import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST, OPTIONS } from './route';
import { relayStore } from '@/lib/server/relay-store';

const NET_A = '203.0.113.7';
const NET_B = '198.51.100.3';

class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = '';

  constructor(res: Response) {
    if (!res.body) throw new Error('响应没有正文');
    this.reader = res.body.getReader();
  }

  async next(timeoutMs = 2000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.buffer.indexOf('\n\n');
      if (index >= 0) {
        const raw = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        const data = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && !data.startsWith(':')) return JSON.parse(data) as Record<string, unknown>;
      }
      if (Date.now() > deadline) throw new Error('等待 SSE 事件超时');
      const { done, value } = await this.reader.read();
      if (done) throw new Error('SSE 流提前关闭');
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

function get(clientId: string, nickname: string, ip = NET_A, signal?: AbortSignal): NextRequest {
  const url = `http://localhost/browser?clientId=${encodeURIComponent(clientId)}&nickname=${encodeURIComponent(nickname)}`;
  return new NextRequest(url, { headers: { 'cf-connecting-ip': ip }, signal });
}

function post(body: unknown, ip = NET_A): NextRequest {
  return new NextRequest('http://localhost/browser', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
}

describe('/browser 信令 Route Handler', () => {
  const readers: SseReader[] = [];

  beforeEach(() => {
    relayStore.clear();
  });

  afterEach(async () => {
    for (const reader of readers) await reader.cancel();
    readers.length = 0;
    relayStore.clear();
  });

  async function connect(clientId: string, nickname: string, ip = NET_A): Promise<SseReader> {
    const res = await GET(get(clientId, nickname, ip));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = new SseReader(res);
    readers.push(reader);
    return reader;
  }

  it('注册后返回同组现有成员', async () => {
    const a = await connect('A', '甲');
    expect(await a.next()).toEqual({ t: 'init', clients: [] });

    const b = await connect('B', '乙');
    expect(await b.next()).toEqual({ t: 'init', clients: [{ clientId: 'A', nickname: '甲' }] });
    expect(await a.next()).toEqual({ t: 'client-online', clientId: 'B', nickname: '乙' });
  });

  it('缺少 clientId 返回 400', async () => {
    const res = await GET(new NextRequest('http://localhost/browser'));
    expect(res.status).toBe(400);
  });

  it('POST 转发信令并标注来源', async () => {
    const a = await connect('A', '甲');
    await a.next();
    const b = await connect('B', '乙');
    await b.next();

    const res = await POST(
      post({ t: 'signal', clientId: 'A', toClient: 'B', data: { description: { type: 'offer' } } }),
    );
    expect(res.status).toBe(204);
    expect(await b.next()).toEqual({
      t: 'signal',
      fromClient: 'A',
      data: { description: { type: 'offer' } },
    });
  });

  it('POST 昵称变更广播并回传分配结果', async () => {
    const a = await connect('A', '甲');
    await a.next();
    const b = await connect('B', '乙');
    await b.next();
    // 先消费掉 B 的上线广播，再触发昵称变更
    expect(await a.next()).toEqual({ t: 'client-online', clientId: 'B', nickname: '乙' });

    const res = await POST(post({ t: 'nickname', clientId: 'B', nickname: '甲' }));
    expect(res.status).toBe(204);
    expect(await a.next()).toEqual({
      t: 'peer-nickname',
      clientId: 'B',
      nickname: expect.stringMatching(/^甲\d{5}$/),
    });
  });

  it('跨网络互不可见', async () => {
    const a = await connect('A', '甲', NET_A);
    await a.next();
    const b = await connect('B', '乙', NET_B);
    expect(await b.next()).toEqual({ t: 'init', clients: [] });
  });

  it('重复 clientId 时旧连接收到 replaced', async () => {
    const first = await connect('A', '甲');
    expect(await first.next()).toEqual({ t: 'init', clients: [] });

    const second = await connect('A', '甲');
    expect(await second.next()).toEqual({ t: 'init', clients: [] });
    expect(await first.next()).toEqual({ t: 'replaced' });
  });

  it('非法 JSON 与缺少 clientId 返回 400', async () => {
    const bad = new NextRequest('http://localhost/browser', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '不是 JSON',
    });
    expect((await POST(bad)).status).toBe(400);

    expect((await POST(post({ t: 'signal', toClient: 'B' }))).status).toBe(400);
  });

  it('未注册的 clientId 返回 404', async () => {
    const res = await POST(post({ t: 'signal', clientId: 'ghost', toClient: 'A', data: {} }));
    expect(res.status).toBe(404);
  });

  it('超大 body 返回 413', async () => {
    const body = 'x'.repeat(20 * 1024);
    const req = new NextRequest('http://localhost/browser', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': NET_A, 'content-length': String(body.length) },
      body,
    });
    expect((await POST(req)).status).toBe(413);
  });

  it('GET/POST/OPTIONS 都带 CORS 头', async () => {
    const a = await connect('A', '甲');
    await a.next();
    const res = await GET(get('B', '乙'));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const posted = await POST(post({ t: 'nickname', clientId: 'A', nickname: '甲2' }));
    expect(posted.headers.get('access-control-allow-origin')).toBe('*');
    const options = await OPTIONS();
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-origin')).toBe('*');
    expect(options.headers.get('access-control-allow-headers')).toBe('content-type');
  });

  it('客户端断开后清理成员身份', async () => {
    const controller = new AbortController();
    const res = await GET(get('A', '甲', NET_A, controller.signal));
    const reader = new SseReader(res);
    readers.push(reader);
    await reader.next();
    expect(relayStore.find('A')).toBeDefined();

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(relayStore.find('A')).toBeUndefined();
  });
});
