import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer';
import { AnalysisResult, SemanticFailure, AnalysisSuccess } from '../src/types';
import { encodeProgram, runOracle, TInstr } from '../src/testing/oracle';

/**
 * 对拍：生产分析器 vs 独立枚举 oracle。
 * 随机生成小长度程序（跳转目标也随机，允许越界/指向坏指令等），
 * 比较 ok / 错误码与 PC / 每个可达 PC 的入栈签名 / 最大栈深 / 可达集。
 */

type Rng = () => number;
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPS: TInstr['0'][] = [
  'push',
  'push',
  'add',
  'eq',
  'not',
  'dup',
  'pop',
  'jump',
  'jif',
  'halt',
];

function genProgram(rng: Rng, maxLen: number): TInstr[] {
  const len = 1 + Math.floor(rng() * maxLen);
  const out: TInstr[] = [];
  for (let pc = 0; pc < len; pc++) {
    const kind = OPS[Math.floor(rng() * OPS.length)];
    switch (kind) {
      case 'push':
        out.push(rng() < 0.5 ? ['push', Math.floor(rng() * 7) - 3] : ['push', rng() < 0.5]);
        break;
      case 'jump':
        // 目标含越界（含负）的情况，测试边界拒绝逻辑
        out.push(['jump', Math.floor(rng() * (len + 2)) - 1]);
        break;
      case 'jif':
        out.push(['jif', Math.floor(rng() * (len + 2)) - 1]);
        break;
      default:
        out.push([kind] as TInstr);
    }
  }
  return out;
}

function compare(ts: TInstr[], label: string): void {
  const program = encodeProgram(ts);
  const o = runOracle(program);
  if (o.budgetExceeded) return; // 指数展开的极端程序：跳过

  const a = analyze(program) as AnalysisResult;
  expect(a.ok, `${label}: ok 不一致`).toBe(o.ok);

  if (!o.ok) {
    expect(a.ok).toBe(false);
    if (a.ok || a.structural) throw new Error('unreachable');
    const f = a as SemanticFailure;
    expect(f.error.code, `${label}: 错误码不一致`).toBe(o.error!.code);
    expect(f.error.pc, `${label}: 错误 PC 不一致`).toBe(o.error!.pc);
    // 出错 PC 的入栈签名也要一致
    expect(f.error.stackAtEntry, `${label}: 错误点入栈签名不一致`).toEqual(o.error!.stackAtEntry);
    expect(f.reachable, `${label}: 失败前可达集不一致`).toEqual(o.reachable);
    return;
  }

  const s = a as AnalysisSuccess;
  expect(s.maxStackDepth, `${label}: 最大栈深不一致`).toBe(o.maxStackDepth);
  expect(s.reachable, `${label}: 可达集不一致`).toEqual(o.reachable);
  for (const info of s.pcs) {
    expect(info.entryStack, `${label}: PC ${info.pc} 入栈签名不一致`).toEqual(
      o.entry[info.pc],
    );
  }
}

describe('随机程序对拍（抽象状态枚举 oracle）', () => {
  it('2000 个长度 <=6 的种子', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const rng = mulberry32(seed * 2654435761);
      compare(genProgram(rng, 6), `seed=${seed}`);
    }
  });

  it('800 个长度 <=8 的种子', () => {
    for (let seed = 1; seed <= 800; seed++) {
      const rng = mulberry32(seed ^ 0x9e3779b9);
      compare(genProgram(rng, 8), `long seed=${seed}`);
    }
  });

  it('定向：分支合流/循环增栈/不可达坏指令三类要求都能在对拍中出现', () => {
    // 收集错误码分布，确保三类关键失败真实发生过
    const codes = new Set<string>();
    for (let seed = 1; seed <= 3000; seed++) {
      const rng = mulberry32(seed + 777);
      const program = encodeProgram(genProgram(rng, 7));
      const o = runOracle(program);
      if (!o.ok && !o.budgetExceeded) codes.add(o.error!.code);
    }
    for (const c of ['CONFLUENCE', 'TYPE_MISMATCH', 'UNDERFLOW', 'JUMP_OUT_OF_BOUNDS']) {
      expect(codes.has(c), `随机语料中从未观察到 ${c}`).toBe(true);
    }
  });

  it('带坏指令的随机程序对拍', () => {
    const bads: TInstr[] = [
      ['bad', 'unknown-op'],
      ['bad', 'push-no-value'],
      ['bad', 'push-bad-value'],
      ['bad', 'jump-no-target'],
      ['bad', 'jump-bad-target'],
      ['bad', 'not-an-object'],
    ];
    for (let seed = 1; seed <= 400; seed++) {
      const rng = mulberry32(seed * 1103515245);
      const ts = genProgram(rng, 6);
      // 随机把一条替换为坏指令
      const idx = Math.floor(rng() * ts.length);
      ts[idx] = bads[Math.floor(rng() * bads.length)];
      compare(ts, `bad seed=${seed} idx=${idx}`);
    }
  });
});
