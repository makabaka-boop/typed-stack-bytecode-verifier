import {
  Decoded,
  MAX_PROGRAM,
  MIN_PROGRAM,
  Op,
  RawInstr,
  StructuralFailure,
} from './types';

/** 无操作数指令集合。 */
const SIMPLE_OPS: ReadonlySet<string> = new Set<Op>([
  'ADD',
  'EQ',
  'NOT',
  'DUP',
  'POP',
  'HALT',
]);

/**
 * 宽解码单条指令：不做控制流判断，只检查结构。
 * 结构非法的指令以 { op: null, bad } 返回，是否报错取决于可达性。
 */
export function decodeOne(pc: number, raw: RawInstr): Decoded {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { pc, op: null, bad: '指令必须是形如 {"op": ...} 的对象' };
  }
  const rec = raw as Record<string, unknown>;
  const op = rec['op'];
  if (typeof op !== 'string') {
    return { pc, op: null, bad: '缺少字符串类型的 "op" 字段' };
  }

  if (SIMPLE_OPS.has(op)) {
    return { pc, op: op as Op };
  }

  if (op === 'PUSH') {
    if (!('value' in rec)) {
      return { pc, op: null, bad: 'PUSH 缺少 "value" 字段' };
    }
    const v = rec['value'];
    if (typeof v === 'boolean') {
      return { pc, op: 'PUSH', value: v };
    }
    if (typeof v === 'number' && Number.isInteger(v)) {
      return { pc, op: 'PUSH', value: v };
    }
    return { pc, op: null, bad: 'PUSH 的 "value" 必须是整数或布尔常量' };
  }

  if (op === 'JUMP' || op === 'JUMP_IF_FALSE') {
    if (!('target' in rec)) {
      return { pc, op: null, bad: `${op} 缺少 "target" 字段` };
    }
    const t = rec['target'];
    if (typeof t !== 'number' || !Number.isInteger(t)) {
      return { pc, op: null, bad: `${op} 的 "target" 必须是绝对地址（非负整数索引）` };
    }
    return { pc, op: op as 'JUMP' | 'JUMP_IF_FALSE', target: t };
  }

  return { pc, op: null, bad: `未知操作码 ${JSON.stringify(op)}` };
}

/** 已通过长度校验的程序：仅做逐条解码。 */
export function decodeAll(rawProgram: RawInstr[]): Decoded[] {
  return rawProgram.map((raw, pc) => decodeOne(pc, raw));
}

/**
 * 解析整份输入文本。
 * 返回字符串表示结构性失败（JSON 非法、不是数组、长度不在 1..500）。
 */
export function parseProgramText(text: string):
  | { ok: true; program: Decoded[] }
  | StructuralFailure {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      structural: true,
      message: `输入不是合法 JSON：${(e as Error).message}`,
    };
  }
  if (!Array.isArray(json)) {
    return { ok: false, structural: true, message: '程序顶层必须是指令数组' };
  }
  if (json.length < MIN_PROGRAM || json.length > MAX_PROGRAM) {
    return {
      ok: false,
      structural: true,
      message: `指令条数必须在 ${MIN_PROGRAM}..${MAX_PROGRAM} 之间，实际为 ${json.length}`,
    };
  }
  return { ok: true, program: decodeAll(json as RawInstr[]) };
}
