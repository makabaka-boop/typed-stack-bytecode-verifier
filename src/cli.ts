#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import type { ValidationResult } from './validator';
import { validateJsonText } from './validator';

async function readInput(): Promise<string> {
  const args = process.argv.slice(2);

  if (args.length > 1) {
    throw new UsageError('用法：vmcheck [program.json]；不传文件参数时从标准输入读取');
  }

  const [filePath] = args;
  if (filePath !== undefined) {
    return fs.readFile(filePath, 'utf8');
  }

  return readStdin();
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

class UsageError extends Error {}

function printResult(result: ValidationResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main(): Promise<number> {
  try {
    const input = await readInput();
    const result = validateJsonText(input);
    printResult(result);
    if (result.kind === 'program') {
      return result.ok ? 0 : 1;
    }
    return 1;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`读取输入失败：${message}\n`);
    return 2;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
