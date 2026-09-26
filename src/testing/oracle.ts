/**
 * 独立参考实现（测试 oracle）。
 *
 * 与 src/analyzer.ts 刻意保持结构独立：
 * - 程序以紧凑元组 IR 描述（TInstr），由本文件自己的编码器变成 JSON 指令；
 * - 用 BFS 枚举“所有可达的 (PC, 完整栈型) 抽象状态”，合流仅在栈型完全相同时发生；
 * - 第一个遇到的错误即判定（顺序与生产分析器一致：JIF 先 NOT_TAKEN 后 TAKEN，
 *   队列 FIFO），并独立记录 entryStack / maxStackDepth / 可达集 / 死代码。
 *
 * 该实现只为测试服务：路径枚举量设预算，预算耗尽时返回 budgetExceeded，
 * 测试据此跳过对拍（避免极端程序的指数展开）。
 */
import { Decoded, ErrorCode, SlotKind } from '../types';
import { decodeAll } from '../decode';

export type TInstr =
  | ['push', number | boolean]
  | ['add']
  | ['eq']
  | ['not']
  | ['dup']
  | ['pop']
  | ['jump', number]
  | ['jif', number]
  | ['halt']
  // 结构性坏指令：以“编码器特意制造的坏 JSON”表达
  | ['bad', 'unknown-op']
  | ['bad', 'push-no-value']
  | ['bad', 'push-bad-value']
  | ['bad', 'jump-no-target']
  | ['bad', 'jump-bad-target']
  | ['bad', 'not-an-object'];

/** 元组 IR -> 原始 JSON 指令（独立编码器）。 */
export function encodeOne(t: TInstr): unknown {
  switch (t[0]) {
    case 'push':
      return { op: 'PUSH', value: t[1] };
    case 'add':
      return { op: 'ADD' };
    case 'eq':
      return { op: 'EQ' };
    case 'not':
      return { op: 'NOT' };
    case 'dup':
      return { op: 'DUP' };
    case 'pop':
      return { op: 'POP' };
    case 'jump':
      return { op: 'JUMP', target: t[1] };
    case 'jif':
      return { op: 'JUMP_IF_FALSE', target: t[1] };
    case 'halt':
      return { op: 'HALT' };
    case 'bad': {
      switch (t[1]) {
        case 'unknown-op':
          return { op: 'WAT' };
        case 'push-no-value':
          return { op: 'PUSH' };
        case 'push-bad-value':
          return { op: 'PUSH', value: 'x' };
        case 'jump-no-target':
          return { op: 'JUMP' };
        case 'jump-bad-target':
          return { op: 'JUMP', target: 1.5 };
        case 'not-an-object':
          return 42;
      }
    }
  }
}

export function encodeProgram(ts: TInstr[]): Decoded[] {
  return decodeAll(ts.map(encodeOne));
}

export interface OracleError {
  code: ErrorCode;
  pc: number;
  stackAtEntry: SlotKind[];
}

export interface OracleResult {
  ok: boolean;
  error?: OracleError;
  entry: Record<number, SlotKind[]>;
  maxStackDepth: number;
  reachable: number[];
  budgetExceeded?: boolean;
}

export interface OracleStepOutcome {
  kind: 'goto' | 'halt' | 'error';
  nextStack?: SlotKind[];
  targets?: { pc: number; branch?: 'TAKEN' | 'NOT_TAKEN' }[];
  code?: ErrorCode;
}

const MAX_STACK = 32;

/** oracle 自带的单步语义（不 import 生产分析器的 step）。 */
export function oracleStep(ins: Decoded, s: SlotKind[]): OracleStepOutcome {
  const push = (k: SlotKind): OracleStepOutcome =>
    s.length >= MAX_STACK
      ? { kind: 'error', code: 'STACK_OVERFLOW' }
      : { kind: 'goto', nextStack: [...s, k], targets: [{ pc: ins.pc + 1 }] };

  switch (ins.op) {
    case 'PUSH':
      return push(typeof ins.value === 'boolean' ? 'BOOL' : 'INT');
    case 'ADD': {
      if (s.length < 2) return { kind: 'error', code: 'UNDERFLOW' };
      const [b, a] = [s[s.length - 2], s[s.length - 1]];
      if (a !== 'INT' || b !== 'INT') return { kind: 'error', code: 'TYPE_MISMATCH' };
      return { kind: 'goto', nextStack: [...s.slice(0, -2), 'INT'], targets: [{ pc: ins.pc + 1 }] };
    }
    case 'EQ': {
      if (s.length < 2) return { kind: 'error', code: 'UNDERFLOW' };
      const [b, a] = [s[s.length - 2], s[s.length - 1]];
      if (a !== b) return { kind: 'error', code: 'TYPE_MISMATCH' };
      return { kind: 'goto', nextStack: [...s.slice(0, -2), 'BOOL'], targets: [{ pc: ins.pc + 1 }] };
    }
    case 'NOT': {
      if (s.length === 0) return { kind: 'error', code: 'UNDERFLOW' };
      if (s[s.length - 1] !== 'BOOL') return { kind: 'error', code: 'TYPE_MISMATCH' };
      return { kind: 'goto', nextStack: [...s.slice(0, -1), 'BOOL'], targets: [{ pc: ins.pc + 1 }] };
    }
    case 'DUP': {
      if (s.length === 0) return { kind: 'error', code: 'UNDERFLOW' };
      if (s.length >= MAX_STACK) return { kind: 'error', code: 'STACK_OVERFLOW' };
      return {
        kind: 'goto',
        nextStack: [...s, s[s.length - 1]],
        targets: [{ pc: ins.pc + 1 }],
      };
    }
    case 'POP': {
      if (s.length === 0) return { kind: 'error', code: 'UNDERFLOW' };
      return { kind: 'goto', nextStack: s.slice(0, -1), targets: [{ pc: ins.pc + 1 }] };
    }
    case 'JUMP':
      return { kind: 'goto', nextStack: s, targets: [{ pc: ins.target as number }] };
    case 'JUMP_IF_FALSE': {
      if (s.length === 0) return { kind: 'error', code: 'UNDERFLOW' };
      if (s[s.length - 1] !== 'BOOL') return { kind: 'error', code: 'TYPE_MISMATCH' };
      const rest = s.slice(0, -1);
      return {
        kind: 'goto',
        nextStack: rest,
        targets: [
          { pc: ins.pc + 1, branch: 'NOT_TAKEN' },
          { pc: ins.target as number, branch: 'TAKEN' },
        ],
      };
    }
    case 'HALT':
      if (s.length !== 1 || s[0] !== 'BOOL') return { kind: 'error', code: 'BAD_HALT_STACK' };
      return { kind: 'halt' };
    case null:
      return { kind: 'error', code: 'BAD_INSTRUCTION' };
  }
  // 理论不可达：ins.op 已穷尽
  return { kind: 'error', code: 'BAD_INSTRUCTION' };
}

interface OState {
  pc: number;
  stack: SlotKind[];
}

/**
 * 枚举所有可达 (PC, 栈型) 状态。
 * @param budget 最多出队的状态数。
 */
export function runOracle(program: Decoded[], budget = 20000): OracleResult {
  const n = program.length;
  const seenAt = new Map<number, SlotKind[][]>();
  const entry = new Map<number, SlotKind[]>();
  const order: number[] = [];
  const queue: OState[] = [{ pc: 0, stack: [] }];
  let visited = 0;
  let maxDepth = 0;
  let budgetExceeded = false;

  const seen = (pc: number, s: SlotKind[]): boolean =>
    (seenAt.get(pc) ?? []).some((x) => x.length === s.length && x.every((v, i) => v === s[i]));

  while (queue.length > 0) {
    const st = queue.shift() as OState;
    if (++visited > budget) {
      budgetExceeded = true;
      break;
    }
    const { pc, stack } = st;

    if (pc === n) {
      return {
        ok: false,
        error: { code: 'FALL_OFF_THE_END', pc: n, stackAtEntry: [...stack] },
        entry: mapToRecord(entry),
        maxStackDepth: maxDepth,
        reachable: [...order],
      };
    }

    const ins = program[pc];
    const list = seenAt.get(pc) ?? [];
    if (list.length === 0) {
      seenAt.set(pc, list);
      entry.set(pc, [...stack]);
      order.push(pc);
    } else if (!same(list[0], stack)) {
      return {
        ok: false,
        error: { code: 'CONFLUENCE', pc, stackAtEntry: [...stack] },
        entry: mapToRecord(entry),
        maxStackDepth: maxDepth,
        reachable: [...order],
      };
    }
    if (seen(pc, stack)) continue;
    list.push([...stack]);

    maxDepth = Math.max(maxDepth, stack.length);

    const targetIsJump = ins.op === 'JUMP' || ins.op === 'JUMP_IF_FALSE';
    const target = ins.target as number;
    if (targetIsJump && (target < 0 || target >= n)) {
      return {
        ok: false,
        error: { code: 'JUMP_OUT_OF_BOUNDS', pc, stackAtEntry: [...stack] },
        entry: mapToRecord(entry),
        maxStackDepth: maxDepth,
        reachable: [...order],
      };
    }

    const r = oracleStep(ins, stack);
    if (r.kind === 'error') {
      return {
        ok: false,
        error: { code: r.code as ErrorCode, pc, stackAtEntry: [...stack] },
        entry: mapToRecord(entry),
        maxStackDepth: maxDepth,
        reachable: [...order],
      };
    }
    if (r.kind === 'halt') continue;

    maxDepth = Math.max(maxDepth, (r.nextStack as SlotKind[]).length);
    // JIF 后继顺序：先 NOT_TAKEN（pc+1），后 TAKEN（target）—— 与生产分析器一致。
    for (const t of r.targets as { pc: number }[]) {
      queue.push({ pc: t.pc, stack: r.nextStack as SlotKind[] });
    }
  }

  return {
    ok: !budgetExceeded,
    entry: mapToRecord(entry),
    maxStackDepth: maxDepth,
    reachable: [...order],
    ...(budgetExceeded ? { budgetExceeded: true } : {}),
  };
}

function same(a: SlotKind[], b: SlotKind[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function mapToRecord(m: Map<number, SlotKind[]>): Record<number, SlotKind[]> {
  const out: Record<number, SlotKind[]> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}
