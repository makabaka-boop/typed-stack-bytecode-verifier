import {
  AnalysisError,
  AnalysisResult,
  AnalysisSuccess,
  Decoded,
  DeadPc,
  ErrorCode,
  HALT_REQUIRED,
  MAX_STACK,
  PcInfo,
  SlotKind,
  StackSig,
  TraceFrame,
  Witness,
} from './types';

/** 见证保留的最大帧数（超出时保留头部与尾部，避免极端输入产生超长输出）。 */
const TRACE_CAP = 120;
const TRACE_HEAD = 80;

/** 分析队列中的一个待处理状态：到达某 PC 的具体控制流状态。 */
interface Queued {
  pc: number;
  stack: SlotKind[];
  /** 从入口到“到达 pc 之前”的路径帧（不含 pc 自身）。 */
  trace: TraceFrame[];
}

/** 单步执行的结构化结果。 */
type StepResult =
  | { kind: 'goto'; target: number; nextStack: SlotKind[]; branch?: 'TAKEN' | 'NOT_TAKEN' }
  | { kind: 'halt' }
  | { kind: 'error'; code: ErrorCode; message: string };

function topKind(s: SlotKind[]): SlotKind {
  return s[s.length - 1];
}

/** 对 JUMP_IF_FALSE：弹出栈顶布尔，返回剩余栈；不满足则给出错误。 */
function popBool(stack: SlotKind[]): { rest: SlotKind[] } | { error: ErrorCode; message: string } {
  if (stack.length === 0) {
    return { error: 'UNDERFLOW', message: 'JUMP_IF_FALSE 需要一个布尔条件，栈为空（下溢）' };
  }
  if (topKind(stack) !== 'BOOL') {
    return {
      error: 'TYPE_MISMATCH',
      message: `JUMP_IF_FALSE 的条件必须是布尔值，实际为整数（类型错误）`,
    };
  }
  return { rest: stack.slice(0, -1) };
}

/** 执行单条指令的抽象语义（不含坏指令与跳转边界检查，那些在 analyze 内处理）。 */
function step(ins: Decoded, stack: SlotKind[]): StepResult {
  switch (ins.op) {
    case 'PUSH': {
      const kind: SlotKind = typeof ins.value === 'boolean' ? 'BOOL' : 'INT';
      if (stack.length >= MAX_STACK) {
        return {
          kind: 'error',
          code: 'STACK_OVERFLOW',
          message: `入栈将超过最大栈深 ${MAX_STACK}`,
        };
      }
      return { kind: 'goto', target: ins.pc + 1, nextStack: [...stack, kind] };
    }

    case 'ADD': {
      if (stack.length < 2) {
        return { kind: 'error', code: 'UNDERFLOW', message: 'ADD 需要两个整数，栈上不足两项（下溢）' };
      }
      const a = stack[stack.length - 1];
      const b = stack[stack.length - 2];
      if (a !== 'INT' || b !== 'INT') {
        return {
          kind: 'error',
          code: 'TYPE_MISMATCH',
          message: 'ADD 只接受两个整数（布尔值不得当作数字相加）',
        };
      }
      return { kind: 'goto', target: ins.pc + 1, nextStack: [...stack.slice(0, -2), 'INT'] };
    }

    case 'EQ': {
      if (stack.length < 2) {
        return { kind: 'error', code: 'UNDERFLOW', message: 'EQ 需要两个同类型值，栈上不足两项（下溢）' };
      }
      const a = stack[stack.length - 1];
      const b = stack[stack.length - 2];
      if (a !== b) {
        return {
          kind: 'error',
          code: 'TYPE_MISMATCH',
          message: 'EQ 只能比较同类型的两个值（整数与布尔不可比较）',
        };
      }
      return { kind: 'goto', target: ins.pc + 1, nextStack: [...stack.slice(0, -2), 'BOOL'] };
    }

    case 'NOT': {
      if (stack.length === 0) {
        return { kind: 'error', code: 'UNDERFLOW', message: 'NOT 需要一个布尔值，栈为空（下溢）' };
      }
      if (topKind(stack) !== 'BOOL') {
        return {
          kind: 'error',
          code: 'TYPE_MISMATCH',
          message: 'NOT 只接受布尔值（类型错误）',
        };
      }
      return { kind: 'goto', target: ins.pc + 1, nextStack: [...stack.slice(0, -1), 'BOOL'] };
    }

    case 'DUP': {
      if (stack.length === 0) {
        return { kind: 'error', code: 'UNDERFLOW', message: 'DUP 需要一个值，栈为空（下溢）' };
      }
      if (stack.length >= MAX_STACK) {
        return {
          kind: 'error',
          code: 'STACK_OVERFLOW',
          message: `DUP 将超过最大栈深 ${MAX_STACK}`,
        };
      }
      return { kind: 'goto', target: ins.pc + 1, nextStack: [...stack, topKind(stack)] };
    }

    case 'POP': {
      if (stack.length === 0) {
        return { kind: 'error', code: 'UNDERFLOW', message: 'POP 需要一个值，栈为空（下溢）' };
      }
      return { kind: 'goto', target: ins.pc + 1, nextStack: stack.slice(0, -1) };
    }

    case 'JUMP':
      return { kind: 'goto', target: ins.target as number, nextStack: stack };

    case 'JUMP_IF_FALSE': {
      const r = popBool(stack);
      if ('error' in r) {
        return { kind: 'error', code: r.error, message: r.message };
      }
      // 两个后继共用“弹出条件后”的栈；分支标注在入边处补齐。
      return { kind: 'goto', target: ins.target as number, nextStack: r.rest };
    }

    case 'HALT': {
      if (stack.length !== 1 || stack[0] !== HALT_REQUIRED) {
        return {
          kind: 'error',
          code: 'BAD_HALT_STACK',
          message:
            stack.length === 0
              ? 'HALT 时栈为空，必须恰有一个布尔值'
              : `HALT 时栈必须恰有一个布尔值，实际为 [${stack.join(', ')}]`,
        };
      }
      return { kind: 'halt' };
    }

    case null:
      return { kind: 'error', code: 'BAD_INSTRUCTION', message: ins.bad ?? '无法解码的指令' };
  }
}

/** 目标地址是否在程序范围内。 */
function inBounds(target: number, n: number): boolean {
  return target >= 0 && target < n;
}

function pushFrame(trace: TraceFrame[], frame: TraceFrame): TraceFrame[] {
  return [...trace, frame];
}

function truncate(frames: TraceFrame[]): Witness {
  if (frames.length <= TRACE_CAP) {
    return { frames };
  }
  const tail = frames.slice(frames.length - (TRACE_CAP - TRACE_HEAD));
  return {
    frames: frames.slice(0, TRACE_HEAD).concat(tail),
    truncatedMiddle: frames.length - TRACE_CAP,
  };
}

function makeWitness(trace: TraceFrame[]): Witness {
  return truncate(trace);
}

/**
 * 控制流与栈型分析。
 *
 * 以 (PC, 完整栈型序列) 为抽象状态做工作流遍历：
 * - 同一 PC 首次到达时记录入栈签名；再次到达而签名不同 => CONFLUENCE。
 * - 每条可达边都检查下溢/类型/栈深/跳转边界/末尾跌出/HALT 栈型。
 * - 不可达 PC（含其中的坏指令、坏跳转目标）只列入 deadCode，不产生错误。
 */
export function analyze(program: Decoded[]): AnalysisResult {
  const n = program.length;

  /** 每个可达 PC 首次（也是唯一允许的）入栈签名。 */
  const entryAt = new Map<number, SlotKind[]>();
  /** 每个可达 PC 执行后的栈深（用于签名报告）。 */
  const exitDepthAt = new Map<number, number>();
  /** 可达 PC 的稳定遍历序（首次到达顺序）。 */
  const firstSeenOrder: number[] = [];

  let maxStackDepth = 0;

  const fail = (
    q: Queued,
    ins: Decoded,
    code: ErrorCode,
    message: string,
    extras?: Partial<AnalysisError>,
  ): AnalysisResult => {
    const frames = pushFrame(q.trace, { pc: q.pc, stackAtEntry: [...q.stack], op: ins.op });
    const error: AnalysisError = {
      code,
      message,
      pc: q.pc,
      stackAtEntry: [...q.stack],
      witness: makeWitness(frames),
      ...extras,
    };
    return {
      ok: false,
      error,
      reachable: [...firstSeenOrder],
      deadCode: collectDead(firstSeenOrder, n, program),
    };
  };

  const queue: Queued[] = [{ pc: 0, stack: [], trace: [] }];

  while (queue.length > 0) {
    const q = queue.shift() as Queued;
    const { pc, stack, trace } = q;

    // 跌出程序末尾：顺序执行的最后一条没有后继。
    if (pc === n) {
      const frames = pushFrame(trace, { pc: n, stackAtEntry: [...stack], op: null });
      return {
        ok: false,
        error: {
          code: 'FALL_OFF_THE_END',
          message: '控制流越过最后一条指令（末尾跌出，缺少 HALT/JUMP）',
          pc: n,
          stackAtEntry: [...stack],
          witness: makeWitness(frames),
        },
        reachable: [...firstSeenOrder],
        deadCode: collectDead(firstSeenOrder, n, program),
      };
    }

    const ins = program[pc];

    // ---- 合流检查：同一 PC 的不同入边必须产生相同的完整栈型序列 ----
    const existing = entryAt.get(pc);
    if (existing === undefined) {
      entryAt.set(pc, [...stack]);
      firstSeenOrder.push(pc);
    } else if (!sameStack(existing, stack)) {
      return fail(q, ins, 'CONFLUENCE', '同一 PC 的不同入边产生了不同的栈类型序列（合流错误）', {
        existingStack: [...existing],
        incomingStack: [...stack],
      });
    } else {
      // 签名相同：控制流已在该状态下处理过，无需再次展开（终止性保证）。
      continue;
    }

    if (stack.length > maxStackDepth) {
      maxStackDepth = stack.length;
    }

    // ---- 跳转边界在取栈操作之前检查：目标非法的边本身不可存在 ----
    if ((ins.op === 'JUMP' || ins.op === 'JUMP_IF_FALSE') && !inBounds(ins.target as number, n)) {
      return fail(
        q,
        ins,
        'JUMP_OUT_OF_BOUNDS',
        `绝对跳转目标 ${ins.target} 越界（程序长度 ${n}，合法范围 0..${n - 1}）`,
      );
    }

    const r = step(ins, stack);

    if (r.kind === 'error') {
      return fail(q, ins, r.code, r.message);
    }

    if (r.kind === 'halt') {
      exitDepthAt.set(pc, stack.length);
      continue;
    }

    // goto
    exitDepthAt.set(pc, r.nextStack.length);
    if (r.nextStack.length > maxStackDepth) {
      maxStackDepth = r.nextStack.length;
    }

    const hereFrame: TraceFrame = { pc, stackAtEntry: [...stack], op: ins.op };
    const nextTrace = pushFrame(trace, hereFrame);

    if (ins.op === 'JUMP_IF_FALSE') {
      // 不取边（条件为真）：落到 PC+1；取边（条件为假）：跳到 target。
      // 先排不取边，保证见证与错误选择确定。
      queue.push({
        pc: pc + 1,
        stack: r.nextStack,
        trace: annotateBranch(nextTrace, 'NOT_TAKEN'),
      });
      queue.push({
        pc: r.target,
        stack: r.nextStack,
        trace: annotateBranch(nextTrace, 'TAKEN'),
      });
    } else {
      queue.push({ pc: r.target, stack: r.nextStack, trace: nextTrace });
    }
  }

  const success: AnalysisSuccess = {
    ok: true,
    maxStackDepth,
    pcs: buildPcInfo(firstSeenOrder, entryAt, exitDepthAt, program),
    reachable: [...firstSeenOrder],
    deadCode: collectDead(firstSeenOrder, n, program),
  };
  return success;
}

/** 给即将到达的下一帧记录“来自哪条分支边”。 */
function annotateBranch(trace: TraceFrame[], branch: 'TAKEN' | 'NOT_TAKEN'): TraceFrame[] {
  if (trace.length === 0) return trace;
  const last = trace[trace.length - 1];
  const copy = trace.slice(0, -1);
  copy.push({ ...last, fromBranch: branch });
  return copy;
}

function sameStack(a: StackSig, b: StackSig): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function buildPcInfo(
  order: number[],
  entryAt: Map<number, SlotKind[]>,
  exitDepthAt: Map<number, number>,
  program: Decoded[],
): PcInfo[] {
  return [...order]
    .sort((a, b) => a - b)
    .map((pc) => ({
      pc,
      op: program[pc].op,
      entryStack: [...(entryAt.get(pc) ?? [])],
      exitDepth: exitDepthAt.get(pc) ?? 0,
    }));
}

/** 列出不可达 PC；其中坏指令/坏跳转目标只作记录，不作为错误。 */
function collectDead(reachableOrder: number[], n: number, program: Decoded[]): DeadPc[] {
  const live = new Set(reachableOrder);
  const dead: DeadPc[] = [];
  for (let pc = 0; pc < n; pc++) {
    if (live.has(pc)) continue;
    const ins = program[pc];
    const reasons: string[] = ['不可达（控制流从不到达）'];
    if (ins.bad) reasons.push(ins.bad);
    if (
      (ins.op === 'JUMP' || ins.op === 'JUMP_IF_FALSE') &&
      typeof ins.target === 'number' &&
      !inBounds(ins.target, n)
    ) {
      reasons.push(`跳转目标 ${ins.target} 越界（程序长度 ${n}）`);
    }
    dead.push({ pc, op: ins.op, reasons });
  }
  return dead;
}
