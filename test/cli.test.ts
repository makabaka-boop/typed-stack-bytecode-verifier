import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { main } from '../src/cli';

let dir: string;

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcheck-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('CLI（与 vmcheck 服务同一入口）', () => {
  it('合法程序：stdout 为 ok=true 的 JSON，退出码 0', async () => {
    const f = write('ok.json', JSON.stringify([{ op: 'PUSH', value: true }, { op: 'HALT' }]));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await main(['node', 'cli', f]);
    expect(code).toBe(0);
    const out = JSON.parse(String(writeSpy.mock.calls[0][0]));
    expect(out.ok).toBe(true);
    expect(out.maxStackDepth).toBe(1);
    expect(out.pcs[0]).toMatchObject({ pc: 0, op: 'PUSH', entryStack: [] });
  });

  it('类型失败：退出码 1，含中文消息与见证', async () => {
    const f = write(
      'bad.json',
      JSON.stringify([
        { op: 'PUSH', value: true },
        { op: 'PUSH', value: false },
        { op: 'ADD' },
      ]),
    );
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await main(['node', 'cli', f]);
    expect(code).toBe(1);
    const out = JSON.parse(String(writeSpy.mock.calls[0][0]));
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('TYPE_MISMATCH');
    expect(out.error.witness.frames.length).toBeGreaterThan(0);
  });

  it('结构失败：退出码 2', async () => {
    const f = write('struct.json', '[]');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await main(['node', 'cli', f]);
    expect(code).toBe(2);
  });

  it('文件不存在：退出码 2', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['node', 'cli', join(dir, 'nope.json')]);
    expect(code).toBe(2);
  });

  it('--help 退出码 0', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await main(['node', 'cli', '--help']);
    expect(code).toBe(0);
  });
});
