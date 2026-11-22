/**
 * 信令传输层：用 Next.js 自带的 HTTP 能力实现（SSE 下行 + POST 上行），
 * 替代 WebSocket。接口与 WebSocket 在 ShareMesh 中用到的子集保持一致，
 * 这样上层逻辑（重连、成员管理、WebRTC 协商）不变。
 */

export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSED = 3;

export interface AgentSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onerror: (() => void) | null;
  connect(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SseAgentSocketOptions {
  /** 下行 SSE 地址（已带 clientId/nickname 查询参数） */
  streamUrl: string;
  /** 上行 POST 地址 */
  postUrl: string;
}

/** 兼容旧链接：把 ws/wss 归一成 http/https，避免 feed 给 fetch 后无限重连。 */
export function normalizeAgentUrl(url: string): string {
  return url.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
}

/** 超过该时长没有任何下行数据（含心跳）就判定半开连接并触发重连。 */
const READ_TIMEOUT_MS = 75_000;
const WATCHDOG_INTERVAL_MS = 10_000;

export class SseAgentSocket implements AgentSocket {
  readyState = SOCKET_CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;

  private abort: AbortController | null = null;
  private postAbort = new AbortController();
  private closedByUs = false;
  /** 上行 POST 串行发送，保证 offer/candidate 等信令的先后顺序（多条 fetch 并发可能乱序） */
  private queue: Promise<void> = Promise.resolve();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0;

  private options: SseAgentSocketOptions;

  constructor(options: SseAgentSocketOptions) {
    this.options = {
      streamUrl: normalizeAgentUrl(options.streamUrl),
      postUrl: normalizeAgentUrl(options.postUrl),
    };
  }

  connect(): void {
    if (this.closedByUs) return;
    this.closeTransport();
    this.postAbort = new AbortController();
    this.queue = Promise.resolve();
    this.readyState = SOCKET_CONNECTING;
    const abort = new AbortController();
    this.abort = abort;
    void this.consume(abort);
  }

  send(data: string): void {
    if (this.closedByUs || this.readyState !== SOCKET_OPEN) return;
    const signal = this.postAbort.signal;
    this.queue = this.queue.then(() => {
      if (this.closedByUs) return;
      return fetch(this.options.postUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: data,
        keepalive: true,
        signal,
      }).then((response) => {
        // 204 一般无 body；非 2xx 时也要消费掉，避免占用连接
        void response.body?.cancel().catch(() => undefined);
      });
    }).catch(() => undefined);
  }

  close(code = 1000, reason = ''): void {
    if (this.closedByUs) return;
    this.closedByUs = true;
    this.queue = Promise.resolve();
    this.postAbort.abort();
    this.closeTransport();
    this.stopWatchdog();
    this.readyState = SOCKET_CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }

  private closeTransport(): void {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private async consume(abort: AbortController): Promise<void> {
    try {
      const response = await fetch(this.options.streamUrl, {
        signal: abort.signal,
        headers: { accept: 'text/event-stream' },
        cache: 'no-store',
      });
      // close()/重连会让本次 fetch 作废，迟到的 resolve 不得再改写状态
      if (this.closedByUs || this.abort !== abort) return;
      if (!response.ok || !response.body) {
        this.fail(abort);
        return;
      }
      this.readyState = SOCKET_OPEN;
      this.lastActivity = Date.now();
      this.startWatchdog(abort);
      this.onopen?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.lastActivity = Date.now();
        // SSE 规范允许 CRLF/CR/LF，统一成 LF 再按空行分帧
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = raw
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data || data.startsWith(':')) continue;
          try {
            this.onmessage?.({ data });
          } catch {
            // 应用层处理异常不影响信令连接
          }
        }
      }
      this.finish(abort, 1000, '', true);
    } catch {
      if (this.closedByUs || this.abort !== abort) return;
      this.fail(abort);
    }
  }

  private startWatchdog(abort: AbortController): void {
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastActivity > READ_TIMEOUT_MS) {
        this.fail(abort, 'read timeout');
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private fail(abort: AbortController, reason = ''): void {
    if (this.closedByUs || this.abort !== abort) return;
    this.settle();
    this.onerror?.();
    this.onclose?.({ code: 1006, reason, wasClean: false });
  }

  private finish(abort: AbortController, code: number, reason: string, wasClean: boolean): void {
    if (this.closedByUs || this.abort !== abort) return;
    this.settle();
    this.onclose?.({ code, reason, wasClean });
  }

  private settle(): void {
    this.closeTransport();
    this.stopWatchdog();
    this.readyState = SOCKET_CLOSED;
  }
}
