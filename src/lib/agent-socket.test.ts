import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import {
  SseAgentSocket,
  SOCKET_CLOSED,
  SOCKET_OPEN,
  normalizeAgentUrl,
} from './agent-socket';

interface StubResponse {
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
}

let fetchImpl: (url: string, init?: RequestInit) => Promise<StubResponse>;

function sseStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (chunk: string) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    stream,
    push: (chunk) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
  };
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('normalizeAgentUrl', () => {
  it('把 ws/wss 归一成 http/https', () => {
    expect(normalizeAgentUrl('ws://192.168.1.2:3000/browser')).toBe('http://192.168.1.2:3000/browser');
    expect(normalizeAgentUrl('wss://example.com/browser')).toBe('https://example.com/browser');
    expect(normalizeAgentUrl('/browser')).toBe('/browser');
    expect(normalizeAgentUrl('https://example.com/browser')).toBe('https://example.com/browser');
  });
});

describe('SseAgentSocket', () => {
  beforeEach(() => {
    fetchImpl = async () => ({ ok: true, body: null });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => fetchImpl(url, init));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('按空行分帧，兼容 CRLF 与跨 chunk 边界', async () => {
    const { stream, push } = sseStream();
    fetchImpl = async () => ({ ok: true, body: stream });

    const socket = new SseAgentSocket({ streamUrl: 'http://x/browser', postUrl: 'http://x/browser' });
    const events: string[] = [];
    let opened = false;
    socket.onopen = () => { opened = true; };
    socket.onmessage = (e) => events.push(e.data);
    socket.connect();

    push('data: {"t":"a"}\n\n');
    push('data: {"t":"b"}\r\n\r\n');
    push('data: {"t":"c"}\n');
    push('\n: 心跳注释\n\n');
    push('data: {"t":"d"}\n\n');
    await tick();

    expect(opened).toBe(true);
    expect(events).toEqual(['{"t":"a"}', '{"t":"b"}', '{"t":"c"}', '{"t":"d"}']);
    socket.close();
  });

  it('多行 data 合并为一个事件', async () => {
    const { stream, push } = sseStream();
    fetchImpl = async () => ({ ok: true, body: stream });
    const socket = new SseAgentSocket({ streamUrl: 'http://x/browser', postUrl: 'http://x/browser' });
    const events: string[] = [];
    socket.onmessage = (e) => events.push(e.data);
    socket.connect();
    push('data: {"t":\ndata: "x"}\n\n');
    await tick();
    expect(events).toEqual(['{"t":\n"x"}']);
    socket.close();
  });

  it('close() 后迟到的 fetch resolve 不会再触发 onopen/翻回 OPEN', async () => {
    let resolveFetch!: (response: StubResponse) => void;
    fetchImpl = () => new Promise<StubResponse>((resolve) => { resolveFetch = resolve; });

    const socket = new SseAgentSocket({ streamUrl: 'http://x/browser', postUrl: 'http://x/browser' });
    const events: string[] = [];
    socket.onopen = () => events.push('open');
    socket.onclose = () => events.push('close');
    socket.connect();
    socket.close(4001, 'replaced');
    expect(socket.readyState).toBe(SOCKET_CLOSED);

    resolveFetch({ ok: true, body: sseStream().stream });
    await tick();
    expect(events).toEqual(['close']);
    expect(socket.readyState).toBe(SOCKET_CLOSED);
  });

  it('上行 POST 串行保序', async () => {
    const { stream } = sseStream();
    const posted: string[] = [];
    fetchImpl = async (_url, init) => {
      if (init?.method === 'POST') {
        posted.push(String(init.body));
        return { ok: true, body: null };
      }
      return { ok: true, body: stream };
    };

    const socket = new SseAgentSocket({ streamUrl: 'http://x/browser', postUrl: 'http://x/browser' });
    socket.connect();
    await tick();
    expect(socket.readyState).toBe(SOCKET_OPEN);

    socket.send('one');
    socket.send('two');
    socket.send('three');
    await tick(20);
    expect(posted).toEqual(['one', 'two', 'three']);
    socket.close();
  });

  it('close() 后不再发出排队中的 POST', async () => {
    const { stream } = sseStream();
    const posted: string[] = [];
    let releaseFirst!: () => void;
    fetchImpl = async (_url, init) => {
      if (init?.method === 'POST') {
        if (posted.length === 0) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        posted.push(String(init.body));
        return { ok: true, body: null };
      }
      return { ok: true, body: stream };
    };

    const socket = new SseAgentSocket({ streamUrl: 'http://x/browser', postUrl: 'http://x/browser' });
    socket.connect();
    await tick();
    socket.send('one');
    await tick();
    socket.send('two');
    socket.close();
    releaseFirst();
    await tick(20);
    expect(posted).not.toContain('two');
  });

  it('非 2xx / 无 body 触发 onerror 与 onclose', async () => {
    fetchImpl = async () => ({ ok: false, body: null });
    const socket = new SseAgentSocket({ streamUrl: 'http://x/browser', postUrl: 'http://x/browser' });
    let errored = 0;
    let closed = 0;
    socket.onerror = () => { errored += 1; };
    socket.onclose = () => { closed += 1; };
    socket.connect();
    await tick();
    expect(errored).toBe(1);
    expect(closed).toBe(1);
    expect(socket.readyState).toBe(SOCKET_CLOSED);
  });

  it('流结束后 onclose(wasClean=true)', async () => {
    const { stream, close } = sseStream();
    fetchImpl = async () => ({ ok: true, body: stream });
    const socket = new SseAgentSocket({ streamUrl: 'http://x/browser', postUrl: 'http://x/browser' });
    let event: { code: number; wasClean: boolean } | null = null;
    socket.onclose = (e) => { event = e; };
    socket.connect();
    await tick();
    close();
    await tick();
    expect(event).not.toBeNull();
    expect(event!.wasClean).toBe(true);
    expect(socket.readyState).toBe(SOCKET_CLOSED);
  });
});
