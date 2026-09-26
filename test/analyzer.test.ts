import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer';
import {
  Decoded,
  ErrorCode,
  SemanticFailure,
  StructuralFailure,
  AnalysisSuccess,
  SlotKind,
} from '../src/types';
import { decodeAll, parseProgramText } from '../src/decode';
import { encodeProgram, runOracle, TInstr } from '../src/testing/oracle';

const S = (s: string): SlotKind[] =>
  [...s].map((c) => (c === 'I' ? 'INT' : 'BOOL'));

/** 分析元组 IR 程序的便捷封装。 */
function check(ts: TInstr[]): ReturnType<typeof analyze> {
  return analyze(encodeProgram(ts));
}

function expectOk(r: ReturnType<typeof analyze>): AnalysisSuccess {
  if (!r.ok || r.structural) throw new Error('期望成功，实际：' + JSON.stringify(r, null, 2));
  return r;
}

function expectSemanticFail(r: ReturnType<typeof analyze>): SemanticFailure {
  if (r.ok || (r as StructuralFailure).structural) {
    throw new Error('期望语义失败，实际：' + JSON.stringify(r, null, 2));
  }
  return r as SemanticFailure;
}

function entryOf(r: AnalysisSuccess, pc: number): SlotKind[] {
  const info = r.pcs.find((p) => p.pc === pc);
  if (!info) throw new Error(`PC ${pc} 不可达`);
  return info.entryStack;
}

describe('基础合法程序', () => {
  it('布尔入栈后 HALT', () => {
    const r = expectOk(check([['push', true], ['halt']]));
    expect(r.maxStackDepth).toBe(1);
    expect(entryOf(r, 0)).toEqual([]);
    expect(entryOf(r, 1)).toEqual(S('B'));
    expect(r.deadCode).toEqual([]);
  });

  it('两整数 ADD 后 EQ 比较并 HALT（含 DUP/POP/NOT）', () => {
    // 0 PUSH 1; 1 PUSH 2; 2 ADD -> [I]; 3 DUP -> [I,I]; 4 PUSH 3 -> [I,I,I];
    // 5 EQ -> [I,B]; 6 POP -> [I]; 7 POP -> []; 8 PUSH true; 9 NOT; 10 NOT; 11 HALT
    const r = expectOk(
      check([
        ['push', 1],
        ['push', 2],
        ['add'],
        ['dup'],
        ['push', 3],
        ['eq'],
        ['pop'],
        ['pop'],
        ['push', true],
        ['not'],
        ['not'],
        ['halt'],
      ]),
    );
    expect(entryOf(r, 2)).toEqual(S('II'));
    expect(entryOf(r, 5)).toEqual(S('III'));
    expect(entryOf(r, 8)).toEqual(S(''));
    expect(entryOf(r, 11)).toEqual(S('B'));
    expect(r.maxStackDepth).toBe(3);
  });

  it('死代码只列出而不触发错误', () => {
    // 0 PUSH true; 1 HALT；2 ADD 本会下溢，但不可达
    const r = expectOk(
      check([
        ['push', true],
        ['halt'],
        ['add'],
      ]),
    );
    expect(r.deadCode.map((d) => d.pc)).toEqual([2]);
  });

  it('无条件跳转回边且栈型稳定的无限循环被接受', () => {
    // 0 PUSH true; 1 NOT; 2 JUMP 1  —— 不终止但栈型合流一致
    const r = expectOk(
      check([
        ['push', true],
        ['not'],
        ['jump', 1],
      ]),
    );
    expect(entryOf(r, 1)).toEqual(S('B'));
    expect(r.maxStackDepth).toBe(1);
  });
});

describe('布尔不得当作数字 / 类型规则', () => {
  it('两个布尔做 ADD => TYPE_MISMATCH', () => {
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['push', false],
        ['add'],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('TYPE_MISMATCH');
    expect(r.error.pc).toBe(2);
    expect(r.error.stackAtEntry).toEqual(S('BB'));
  });

  it('整数与布尔 EQ => TYPE_MISMATCH', () => {
    const r = expectSemanticFail(
      check([
        ['push', 1],
        ['push', true],
        ['eq'],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('TYPE_MISMATCH');
    expect(r.error.pc).toBe(2);
  });

  it('对整数 NOT => TYPE_MISMATCH', () => {
    const r = expectSemanticFail(
      check([
        ['push', 1],
        ['not'],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('TYPE_MISMATCH');
  });

  it('JUMP_IF_FALSE 弹出整数 => TYPE_MISMATCH（整数不得当布尔）', () => {
    const r = expectSemanticFail(
      check([
        ['push', 1],
        ['jif', 3],
        ['push', true],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('TYPE_MISMATCH');
    expect(r.error.pc).toBe(1);
  });

  it('两个同类型（布尔）EQ 合法并产生布尔', () => {
    const r = expectOk(
      check([
        ['push', true],
        ['push', false],
        ['eq'],
        ['halt'],
      ]),
    );
    expect(entryOf(r, 3)).toEqual(S('B'));
  });
});

describe('下溢 / HALT / 栈深', () => {
  it('空栈 ADD => UNDERFLOW', () => {
    const r = expectSemanticFail(check([['add']]));
    expect(r.error.code).toBe('UNDERFLOW');
    expect(r.error.pc).toBe(0);
  });

  it('HALT 时栈上是整数 => BAD_HALT_STACK', () => {
    const r = expectSemanticFail(
      check([
        ['push', 1],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('BAD_HALT_STACK');
  });

  it('HALT 时栈上有两个布尔 => BAD_HALT_STACK', () => {
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['push', false],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('BAD_HALT_STACK');
  });

  it('33 次入栈 => STACK_OVERFLOW', () => {
    const instrs: TInstr[] = [];
    for (let i = 0; i < 33; i++) instrs.push(['push', i]);
    instrs.push(['halt']);
    const r = expectSemanticFail(check(instrs));
    expect(r.error.code).toBe('STACK_OVERFLOW');
    expect(r.error.pc).toBe(32);
    expect(r.error.stackAtEntry).toHaveLength(32);
  });

  it('深度恰好 32 合法（随后全部 POP 到一个布尔）', () => {
    const instrs: TInstr[] = [];
    instrs.push(['push', true]); // 布尔在栈底
    for (let i = 0; i < 31; i++) instrs.push(['push', i]); // 深度 32
    for (let i = 0; i < 31; i++) instrs.push(['pop']); // 仅剩栈底布尔
    instrs.push(['halt']);
    const r = expectOk(check(instrs));
    expect(r.maxStackDepth).toBe(32);
  });
});

describe('跳转边界与末尾跌出', () => {
  it('JUMP 目标越界 => JUMP_OUT_OF_BOUNDS', () => {
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['jump', 5],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('JUMP_OUT_OF_BOUNDS');
    expect(r.error.pc).toBe(1);
  });

  it('负地址跳转 => JUMP_OUT_OF_BOUNDS', () => {
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['jump', -1],
      ]),
    );
    expect(r.error.code).toBe('JUMP_OUT_OF_BOUNDS');
  });

  it('顺序执行跌出末尾 => FALL_OFF_THE_END', () => {
    const r = expectSemanticFail(check([['push', true]]));
    expect(r.error.code).toBe('FALL_OFF_THE_END');
    expect(r.error.pc).toBe(1);
  });

  it('JIF 不取边跌出末尾也必须拒绝（即使取边构成稳定循环）', () => {
    // 0 PUSH true; 1 JIF 0 —— 取边回到 0（栈型稳定），不取边跌出 PC2
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['jif', 0],
      ]),
    );
    expect(r.error.code).toBe('FALL_OFF_THE_END');
    expect(r.error.pc).toBe(2);
  });

  it('不可达的越界跳转只列入死代码，不报错', () => {
    const r = expectOk(
      check([
        ['push', true],
        ['halt'],
        ['jump', 99],
      ]),
    );
    expect(r.deadCode.map((d) => d.pc)).toEqual([2]);
    expect(r.deadCode[0].reasons.join(' ')).toContain('越界');
  });
});

describe('分支合流', () => {
  it('菱形分支栈型一致 => 合流成功', () => {
    // 0 PUSH true
    // 1 JIF 5        （弹出条件，两条边都以空栈出发）
    // 2 PUSH true    不取边
    // 3 NOT
    // 4 JUMP 6
    // 5 PUSH false   取边
    // 6 NOT          合流点：两条边都带一个布尔
    // 7 HALT
    const r = expectOk(
      check([
        ['push', true],
        ['jif', 5],
        ['push', true],
        ['not'],
        ['jump', 6],
        ['push', false],
        ['not'],
        ['halt'],
      ]),
    );
    expect(entryOf(r, 6)).toEqual(S('B'));
    expect(r.maxStackDepth).toBe(1);
  });

  it('两条入边栈深不同 => CONFLUENCE', () => {
    // 0 PUSH true; 1 JIF 4
    // 2 PUSH true (不取边，到合流点时 [B]); 3 JUMP 6
    // 4 JUMP 5; 5 JUMP 6  (取边经两跳，到合流点时 [])
    // 6 POP       <- 入边栈型 [B] vs []（POP 只在首条边上执行，合流先于其后继报错）
    // 7 HALT
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['jif', 4],
        ['push', true],
        ['jump', 6],
        ['jump', 5],
        ['jump', 6],
        ['pop'],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('CONFLUENCE');
    expect(r.error.pc).toBe(6);
    expect(r.error.existingStack).toEqual(S('B'));
    expect(r.error.incomingStack).toEqual(S(''));
  });

  it('两条入边栈深相同但类型不同 => CONFLUENCE', () => {
    // 0 PUSH true; 1 JIF 4
    // 2 PUSH 1    (不取边，到 5 时 [I]); 3 JUMP 5
    // 4 PUSH true (取边，到 5 时 [B])
    // 5 POP; 6 HALT
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['jif', 4],
        ['push', 1],
        ['jump', 5],
        ['push', true],
        ['pop'],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('CONFLUENCE');
    expect(r.error.pc).toBe(5);
    // BFS 先处理取边（等长但更少跳），故先入签名为 [B]
    expect(r.error.existingStack).toEqual(S('B'));
    expect(r.error.incomingStack).toEqual(S('I'));
  });
});

describe('循环不得抬高栈深', () => {
  it('循环每轮净增一个整数，回边栈型变长 => CONFLUENCE', () => {
    // 0 PUSH true        条件种子
    // 1 PUSH true        <- 合流点（首次到达时栈 [B]）
    // 2 JUMP_IF_FALSE 6  弹出条件；取边退出循环
    // 3 PUSH true        补回条件
    // 4 PUSH 1           循环体净增一个整数（永不消费）
    // 5 JUMP 1           回边：栈变为 [B,B,I]
    // 6 HALT             退出边合法（栈 [B]），但回边合流错误随后即报
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['push', true],
        ['jif', 6],
        ['push', true],
        ['push', 1],
        ['jump', 1],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('CONFLUENCE');
    expect(r.error.pc).toBe(1);
    // 首次到达 PC1 栈为 [B]；绕一圈后多出两个槽位
    expect(r.error.existingStack).toEqual(S('B'));
    expect(r.error.incomingStack).toEqual(S('BBI'));
  });

  it('JIF 回边栈型稳定的循环被接受（分析可终止）', () => {
    // 0 PUSH true; 1 PUSH true; 2 JIF 1; 3 HALT
    // 取边回 1 时栈恢复为 [B]，与首次到达一致 => 合流稳定
    const r = expectOk(
      check([
        ['push', true],
        ['push', true],
        ['jif', 1],
        ['halt'],
      ]),
    );
    expect(entryOf(r, 1)).toEqual(S('B'));
    expect(r.maxStackDepth).toBe(2);
  });
});

describe('坏指令的可达性', () => {
  it('可达的未知操作码 => BAD_INSTRUCTION', () => {
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['bad', 'unknown-op'],
      ]),
    );
    expect(r.error.code).toBe('BAD_INSTRUCTION');
    expect(r.error.pc).toBe(1);
  });

  it('不可达坏指令只列出', () => {
    const r = expectOk(
      check([
        ['push', true],
        ['halt'],
        ['bad', 'push-no-value'],
        ['bad', 'not-an-object'],
      ]),
    );
    expect(r.deadCode.map((d) => d.pc)).toEqual([2, 3]);
  });

  it('分支可达路径上的坏指令（一条边跳过它）仍要报错', () => {
    // 0 PUSH true; 1 JIF 4; 2 <bad>; 3 HALT(不可达?); 4 PUSH true; 5 HALT
    // 不取边顺序进入 PC2 坏指令 => 报错
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['jif', 4],
        ['bad', 'jump-bad-target'],
        ['halt'],
        ['push', true],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('BAD_INSTRUCTION');
    expect(r.error.pc).toBe(2);
  });
});

describe('控制流见证', () => {
  it('见证从 PC0 开始、逐帧给出栈型，且与错误 PC 对齐', () => {
    const r = expectSemanticFail(
      check([
        ['push', 1],
        ['push', 2],
        ['add'],
        ['push', true],
        ['add'],
      ]),
    );
    const w = r.error.witness;
    expect(w.frames[0].pc).toBe(0);
    expect(w.frames[w.frames.length - 1].pc).toBe(r.error.pc);
    // PC4 入栈 [I,B]
    expect(w.frames[w.frames.length - 1].stackAtEntry).toEqual(S('IB'));
    expect(w.truncatedMiddle).toBeUndefined();
  });

  it('JIF 边在见证上标注 TAKEN / NOT_TAKEN', () => {
    const r = expectSemanticFail(
      check([
        ['push', true],
        ['jif', 4],
        ['push', 1],
        ['jump', 5],
        ['push', true],
        ['pop'],
        ['halt'],
      ]),
    );
    expect(r.error.code).toBe('CONFLUENCE');
    const annotated = r.error.witness.frames.filter((f) => f.fromBranch);
    expect(annotated.length).toBeGreaterThan(0);
  });

  it('按见证重放：每一步栈型与操作自洽（无截断时）', () => {
    // 用一个较深的顺序程序，验证见证里相邻帧的栈型变化符合语义。
    const r = expectSemanticFail(
      check([
        ['push', 1],
        ['push', 2],
        ['add'],
        ['dup'],
        ['push', 9],
        ['eq'],
        ['not'],
        ['halt'],
      ]),
    );
    // EQ 比较 3 和 9 -> BOOL；NOT -> BOOL；HALT 时栈上是 [I(=3 的副本被...)]
    // 实际：PUSH1 PUSH2 ADD => [I]; DUP => [I,I]; PUSH9 => [I,I,I];
    // EQ => [I,B]; NOT on B? 栈顶 B => [I,B]; HALT 栈非单布尔 => BAD_HALT_STACK
    expect(r.error.code).toBe('BAD_HALT_STACK');
    const frames = r.error.witness.frames;
    expect(frames).toHaveLength(8);
    expect(frames[2].stackAtEntry).toEqual(S('II')); // ADD 入栈
    expect(frames[5].stackAtEntry).toEqual(S('III')); // EQ 入栈
    expect(frames[7].stackAtEntry).toEqual(S('IB')); // HALT 入栈
  });
});

describe('结构校验', () => {
  it('空数组 => 结构失败', () => {
    const r = parseProgramText('[]');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.structural).toBe(true);
  });

  it('501 条 => 结构失败', () => {
    const arr = new Array(501).fill(0).map(() => ({ op: 'HALT' }));
    const r = parseProgramText(JSON.stringify(arr));
    expect(r.ok).toBe(false);
  });

  it('500 条且首条 HALT（其余不可达坏指令）=> 成功并列出死代码', () => {
    const arr: unknown[] = [{ op: 'PUSH', value: true }, { op: 'HALT' }];
    for (let i = 2; i < 500; i++) arr.push({ op: 'ADD' });
    const parsed = parseProgramText(JSON.stringify(arr));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const r = analyze(parsed.program);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.deadCode).toHaveLength(498);
    }
  });

  it('非数组 JSON => 结构失败', () => {
    const r = parseProgramText('{"op":"HALT"}');
    expect(r.ok).toBe(false);
  });

  it('非法 JSON => 结构失败', () => {
    const r = parseProgramText('not json');
    expect(r.ok).toBe(false);
  });

  it('1..500 长度边界：1 条 HALT（空栈）为语义失败而非结构失败', () => {
    const parsed = parseProgramText('[{"op":"HALT"}]');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const r = analyze(parsed.program);
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r as SemanticFailure).error.code).toBe('BAD_HALT_STACK');
    }
  });
});

describe('decode 直接用例', () => {
  it('PUSH 仅接受整数与布尔（字符串/浮点/NaN 均坏）', () => {
    expect(decodeAll([{ op: 'PUSH', value: 'x' }])[0].bad).toBeTruthy();
    expect(decodeAll([{ op: 'PUSH', value: 1.5 }])[0].bad).toBeTruthy();
    expect(decodeAll([{ op: 'PUSH', value: NaN }])[0].bad).toBeTruthy();
    expect(decodeAll([{ op: 'PUSH', value: -7 }])[0].op).toBe('PUSH');
    expect(decodeAll([{ op: 'PUSH', value: false }])[0].op).toBe('PUSH');
  });
});

// 让类型错误码在本文件中保持被引用（便于以后扩充断言）。
export const _codes: ErrorCode[] = ['CONFLUENCE'];
export type _Decoded = Decoded;
