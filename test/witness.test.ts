import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer';
import { SemanticFailure, SlotKind } from '../src/types';
import { encodeProgram, oracleStep, TInstr } from '../src/testing/oracle';

/**
 * 见证重放：用独立 oracle 的单步语义，从空栈沿 witness 逐帧执行，验证
 *  - 每帧记录的入栈类型与实际执行结果一致；
 *  - 相邻帧的 PC 确实是上一帧指令的合法后继；
 *  - JIF 帧上的 TAKEN/NOT_TAKEN 标注与后继一致；
 *  - 末帧按其栈型独立执行，得到的错误码与生产分析器一致
 *    （CONFLUENCE / FALL_OFF_THE_END 由重放结构本身验证）。
 * 只对未截断的见证运行。
 */
function replay(ts: TInstr[]): void {
  const program = encodeProgram(ts);
  const r = analyze(program);
  if (r.ok || r.structural) throw new Error('应为语义失败：' + JSON.stringify(r));
  const f = (r as SemanticFailure).error;
  expect(f.witness.truncatedMiddle, '测试程序应足够短，见证不应被截断').toBeUndefined();

  const frames = f.witness.frames;
  let stack: SlotKind[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    expect(frame.stackAtEntry, `帧 ${i} 入栈签名`).toEqual(stack);

    if (i === frames.length - 1) break;

    const out = oracleStep(program[frame.pc], stack);
    expect(out.kind, `帧 ${i} 不应在此报错`).toBe('goto');
    const edge = (out.targets ?? []).find((t) => t.pc === frames[i + 1].pc);
    expect(edge, `帧 ${i}->${i + 1} 不是合法后继`).toBeTruthy();
    if (program[frame.pc].op === 'JUMP_IF_FALSE') {
      expect(frame.fromBranch, `帧 ${i} 的 JIF 分支标注`).toBe(edge!.branch);
    }
    stack = out.nextStack as SlotKind[];
  }

  // 末帧复核
  const last = frames[frames.length - 1];
  expect(last.pc).toBe(f.pc);
  if (f.code === 'CONFLUENCE') {
    expect(f.existingStack).toBeDefined();
    expect(f.incomingStack).toEqual(last.stackAtEntry);
  } else if (f.code === 'FALL_OFF_THE_END') {
    expect(last.pc).toBe(program.length);
  } else if (f.code === 'JUMP_OUT_OF_BOUNDS') {
    // 越界判断在遍历层而非单步语义：独立验证目标不在程序范围内
    const ins = program[last.pc];
    expect(ins.op === 'JUMP' || ins.op === 'JUMP_IF_FALSE').toBe(true);
    const t = ins.target as number;
    expect(t < 0 || t >= program.length).toBe(true);
  } else {
    const out = oracleStep(program[last.pc], last.stackAtEntry);
    expect(out.kind).toBe('error');
    expect(out.code).toBe(f.code);
  }
}

describe('失败见证可被独立解释器重放（真实可达路径）', () => {
  const cases: [string, TInstr[]][] = [
    ['布尔相加', [['push', true], ['push', false], ['add']]],
    ['整数 NOT', [['push', 1], ['not']]],
    ['空栈下溢', [['add']]],
    ['HALT 栈型错', [['push', 1], ['halt']]],
    ['跳转越界', [['push', true], ['jump', 9], ['halt']]],
    ['末尾跌出', [['push', true]]],
    ['可达坏指令', [['push', true], ['bad', 'unknown-op']]],
    ['JIF 条件为整数', [['push', 1], ['jif', 0]]],
    [
      '合流：深度不同',
      [
        ['push', true],
        ['jif', 4],
        ['push', true],
        ['jump', 6],
        ['jump', 5],
        ['jump', 6],
        ['pop'],
        ['halt'],
      ],
    ],
    [
      '合流：类型不同',
      [
        ['push', true],
        ['jif', 4],
        ['push', 1],
        ['jump', 5],
        ['push', true],
        ['pop'],
        ['halt'],
      ],
    ],
    [
      '循环增栈',
      [
        ['push', true],
        ['push', true],
        ['jif', 6],
        ['push', true],
        ['push', 1],
        ['jump', 1],
        ['halt'],
      ],
    ],
  ];

  for (const [name, ts] of cases) {
    it(name, () => replay(ts));
  }
});
