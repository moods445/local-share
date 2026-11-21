import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverEntry = path.join(root, 'src', 'server', 'index.ts');
const tsxBin = path.join(root, 'node_modules', '.bin', 'tsx');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [serverEntry, ...args], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('服务启动参数', () => {
  it('非法端口报错退出', async () => {
    const result = await run(['--port', '0']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('无效的 HTTP 端口');
  });

  it('端口被占用时给出错误而不是未处理异常', async () => {
    const occupied = await occupyPort();
    try {
      const result = await run(['--port', String(occupied.port)]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('服务器启动失败');
      expect(result.stderr).not.toContain('Error: listen EADDRINUSE');
    } finally {
      await occupied.close();
    }
  });
});
