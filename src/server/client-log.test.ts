import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import pino from 'pino';
import { createClientLogHandler } from './client-log.js';

interface Harness {
  server: http.Server;
  port: number;
  lines: string[];
}

let harness: Harness | null = null;

async function start(): Promise<Harness> {
  const lines: string[] = [];
  const stream = {
    write(line: string) {
      lines.push(line);
    },
  };
  const logger = pino({ level: 'info' }, stream);
  const handle = createClientLogHandler(logger);
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  harness = { server, port: (server.address() as { port: number }).port, lines };
  return harness;
}

afterEach(async () => {
  if (!harness) return;
  await new Promise<void>((resolve) => harness!.server.close(() => resolve()));
  harness = null;
});

function post(port: number, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/log', method: 'POST', headers: { 'content-type': 'text/plain' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('前端埋点接收', () => {
  it('合法事件写入 Pino 日志', async () => {
    const { port, lines } = await start();
    const status = await post(
      port,
      JSON.stringify({
        level: 'warn',
        event: 'ws.close',
        clientId: 'c1',
        nickname: '手机',
        page: '/',
        ts: 1,
        details: { code: 1006, wasClean: false },
      }),
    );

    expect(status).toBe(204);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.msg).toBe('ws.close');
    expect(entry.level).toBe(40);
    expect(entry.source).toBe('browser');
    expect(entry.clientId).toBe('c1');
    expect((entry.details as Record<string, unknown>).code).toBe(1006);
  });

  it('非法 JSON 返回 400', async () => {
    const { port } = await start();
    expect(await post(port, '不是 JSON')).toBe(400);
  });

  it('超大报文返回 413', async () => {
    const { port } = await start();
    expect(await post(port, 'x'.repeat(20 * 1024))).toBe(413);
  });
});
