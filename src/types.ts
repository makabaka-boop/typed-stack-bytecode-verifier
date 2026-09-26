/**
 * 设备控制脚本校验器的核心类型定义。
 *
 * 抽象域：栈不是“多深 + 布尔/整数计数”，而是从栈底到栈顶的完整类型序列，
 * 因此同一 PC 入边栈型不一致即可在合流点被精确发现（例如循环每轮抬高栈深）。
 */

/** 支持的操作码（解码后的规范形式）。 */
export type Op =
  | 'PUSH'
  | 'ADD'
  | 'EQ'
  | 'NOT'
  | 'DUP'
  | 'POP'
  | 'JUMP'
  | 'JUMP_IF_FALSE'
  | 'HALT';

/** 栈槽抽象类型：整数 / 布尔。 */
export type SlotKind = 'INT' | 'BOOL';

/** 从栈底到栈顶的栈类型序列。 */
export type StackSig = readonly SlotKind[];

/** HALT 时唯一允许留在栈上的值类型。 */
export const HALT_REQUIRED: SlotKind = 'BOOL';

/** 最大允许栈深（inclusive：push/dup 后深度不得超过该值）。 */
export const MAX_STACK = 32;

/** 合法的程序长度区间。 */
export const MIN_PROGRAM = 1;
export const MAX_PROGRAM = 500;

/** 原始 JSON 指令：解码前的宽松形态。 */
export type RawInstr = unknown;

/**
 * 解码后的指令。
 * - bad 为 true 时表示结构性解码失败（未知操作、字段缺失、操作数类型不对等），
 *   仅在该 PC 可达时才升格为语义错误。
 */
export interface Decoded {
  pc: number;
  op: Op | null;
  bad?: string;
  value?: number | boolean;
  target?: number;
}

/** 稳定的错误代码（中文消息由消息表给出）。 */
export type ErrorCode =
  | 'BAD_INSTRUCTION'
  | 'UNDERFLOW'
  | 'TYPE_MISMATCH'
  | 'STACK_OVERFLOW'
  | 'JUMP_OUT_OF_BOUNDS'
  | 'FALL_OFF_THE_END'
  | 'BAD_HALT_STACK'
  | 'CONFLUENCE';

/** 控制流见证中的单帧。 */
export interface TraceFrame {
  /** 当前帧到达的 PC。 */
  pc: number;
  /** 到达该 PC 时（入边）栈类型，栈底 -> 栈顶。 */
  stackAtEntry: SlotKind[];
  /** 该 PC 执行的操作（坏指令为 null）。 */
  op: Op | null;
  /**
   * 若本帧是 JUMP_IF_FALSE，标注从本帧走向下一帧的是哪条边
   * （TAKEN=条件为假跳转 target，NOT_TAKEN=条件为真顺序执行）。
   */
  fromBranch?: 'TAKEN' | 'NOT_TAKEN';
}

/** 实际控制流见证：一条具体可达路径。 */
export interface Witness {
  /** 从入口 PC 0 出发的帧序列（栈型逐帧给出）。 */
  frames: TraceFrame[];
  /** 见证因长度上限被截断时，丢弃的中间帧数。 */
  truncatedMiddle?: number;
}

/** 分析失败时的结构化错误。 */
export interface AnalysisError {
  code: ErrorCode;
  message: string;
  pc: number;
  /** 到达该 PC 时的栈类型序列（栈底 -> 栈顶）。 */
  stackAtEntry: SlotKind[];
  /** 合流错误：该 PC 已有的入栈签名。 */
  existingStack?: SlotKind[];
  /** 合流错误：本次入边带来的签名。 */
  incomingStack?: SlotKind[];
  /** 实际控制流见证（BAD_INSTRUCTION 等错误也带路径）。 */
  witness: Witness;
}

/** 死代码（不可达 PC）条目。坏指令 / 坏跳转目标只在此列出，不触发错误。 */
export interface DeadPc {
  pc: number;
  op: Op | null;
  reasons: string[];
}

/** 单个可达 PC 的入栈签名与执行后深度等信息。 */
export interface PcInfo {
  pc: number;
  op: Op | null;
  /** 入栈签名：所有入边必须相同（否则 CONFLUENCE）。 */
  entryStack: SlotKind[];
  /** 该 PC 执行后的栈深（静态可定）。 */
  exitDepth: number;
}

/** 结构/IO 层面的失败（JSON 解析失败、长度非法等），发生在控制流分析之前。 */
export interface StructuralFailure {
  ok: false;
  structural: true;
  message: string;
}

/** 控制流分析失败。 */
export interface SemanticFailure {
  ok: false;
  structural?: false;
  error: AnalysisError;
  /** 失败前已确认可达的 PC。 */
  reachable: number[];
  deadCode: DeadPc[];
}

/** 控制流分析成功。 */
export interface AnalysisSuccess {
  ok: true;
  /** 全局最大栈深（所有可达状态执行后的深度上确界）。 */
  maxStackDepth: number;
  /** 各可达 PC 的入栈签名等（按 PC 升序）。 */
  pcs: PcInfo[];
  reachable: number[];
  deadCode: DeadPc[];
}

export type AnalysisResult = AnalysisSuccess | SemanticFailure | StructuralFailure;
