import { describe, it, expect, afterEach } from 'vitest';
import pino from 'pino';
import { ClientLogHandler } from './client-log';

interface Harness {
  handler: ClientLogHandler;
  lines: string[];
}

let harness: Harness | null = null;

async function start(trustProxy = false): Promise<Harness> {
  const lines: string[] = [];
  const stream = {
    write(line: string) {
      lines.push(line);
    },
  };
  const logger = pino({ level: 'info' }, stream);
  const handler = new ClientLogHandler(logger, trustProxy);
  harness = { handler, lines };
  return harness;
}

afterEach(() => {
  harness = null;
});

function post(handler: ClientLogHandler, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return handler.handle(
    new Request('http://localhost/log', { method: 'POST', body, headers }),
  );
}

describe('前端埋点接收', () => {
  it('合法事件写入 Pino 日志', async () => {
    const { handler, lines } = await start();
    const res = await post(
      handler,
      JSON.stringify({
        level: 'warn',
        event: 'ws.close',
        clientId: 'c1',
        nickname: '手机',
        page: '/',
        ts: 1,
        details: { code: 1006, wasClean: false },
      }),
      { 'content-type': 'text/plain' },
    );

    expect(res.status).toBe(204);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.msg).toBe('ws.close');
    expect(entry.level).toBe(40);
    expect(entry.source).toBe('browser');
    expect(entry.clientId).toBe('c1');
    expect((entry.details as Record<string, unknown>).code).toBe(1006);
  });

  it('非法 JSON 返回 400', async () => {
    const { handler } = await start();
    const res = await post(handler, '不是 JSON');
    expect(res.status).toBe(400);
  });

  it('超大报文返回 413', async () => {
    const { handler } = await start();
    const res = await post(handler, 'x'.repeat(20 * 1024));
    expect(res.status).toBe(413);
  });

  it('同一来源超过限流窗口返回 429', async () => {
    const { handler } = await start();
    const headers = { 'cf-connecting-ip': '203.0.113.7' };
    for (let i = 0; i < 120; i += 1) {
      const res = await post(handler, JSON.stringify({ event: 'ping' }), headers);
      expect(res.status).toBe(204);
    }
    const limited = await post(handler, JSON.stringify({ event: 'ping' }), headers);
    expect(limited.status).toBe(429);
  });

  it('默认不信任 X-Forwarded-For（防伪造限流）', async () => {
    const { handler, lines } = await start();
    const res = await post(handler, JSON.stringify({ event: 'probe' }), {
      'x-forwarded-for': '198.51.100.9',
    });
    expect(res.status).toBe(204);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.ip).toBe('unknown');
  });

  it('TRUST_PROXY=1 时才采信 X-Forwarded-For', async () => {
    const { handler, lines } = await start(true);
    const res = await post(handler, JSON.stringify({ event: 'probe' }), {
      'x-forwarded-for': '198.51.100.9, 10.0.0.1',
    });
    expect(res.status).toBe(204);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.ip).toBe('198.51.100.9');
  });
});
