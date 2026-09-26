#!/usr/bin/env node
import { readFileSync } from 'fs';
import { analyze } from './analyzer';
import { parseProgramText } from './decode';
import { AnalysisResult } from './types';

const USAGE = `用法: vmcheck [文件路径]
  读取一份 JSON 指令数组（1..500 条），做控制流 + 栈类型校验。
  不传路径时从标准输入读取。

支持的指令:
  {"op":"PUSH","value": <整数|布尔>}
  {"op":"ADD"}              两个整数相加（禁止布尔参与）
  {"op":"EQ"}               比较两个同类型值，产生布尔
  {"op":"NOT"}              布尔取反
  {"op":"DUP"} / {"op":"POP"}
  {"op":"JUMP","target": <绝对地址>}
  {"op":"JUMP_IF_FALSE","target": <绝对地址>}   弹出栈顶布尔作为条件
  {"op":"HALT"}             栈必须恰有一个布尔值
最大栈深 32。

退出码: 0=通过, 1=控制流/栈校验失败, 2=用法或结构错误。结果以 JSON 打印到 stdout。`;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (args.length > 1) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }

  let text: string;
  try {
    text = args.length === 1 ? readFileSync(args[0], 'utf8') : await readStdin();
  } catch (e) {
    process.stderr.write(`无法读取输入：${(e as Error).message}\n`);
    return 2;
  }

  const parsed = parseProgramText(text);
  let result: AnalysisResult;
  if (!parsed.ok) {
    result = parsed;
  } else {
    result = analyze(parsed.program);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.ok ? 0 : result.structural ? 2 : 1;
}

/** 作为脚本直接执行时运行；被测试代码导入时不自动运行。 */
if (require.main === module) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`内部错误：${(e as Error).stack ?? String(e)}\n`);
      process.exit(2);
    });
}
