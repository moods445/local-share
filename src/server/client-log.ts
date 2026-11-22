import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from './logger.js';

const MAX_BODY_BYTES = 16 * 1024;
const WINDOW_MS = 60_000;
const MAX_EVENTS_PER_WINDOW = 120;
const LEVELS = new Set(['debug', 'info', 'warn', 'error'] as const);

type BrowserLevel = 'debug' | 'info' | 'warn' | 'error';

interface LimitBucket {
  count: number;
  resetAt: number;
}

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** 只保留浅层标量字段，避免前端上报把日志体积撑爆。 */
function sanitizeDetails(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (typeof item === 'string') output[key.slice(0, 40)] = item.slice(0, 400);
    else if (typeof item === 'number' || typeof item === 'boolean') output[key.slice(0, 40)] = item;
  }
  return output;
}

/**
 * 接收前端埋点（浏览器连接生命周期事件），统一落到服务端 Pino 日志。
 * 仅接收小体量 JSON，并按来源地址限流，避免公开端点被刷。
 */
export function createClientLogHandler(logger: Logger) {
  const buckets = new Map<string, LimitBucket>();

  return function handleClientLog(req: IncomingMessage, res: ServerResponse): void {
    const ip = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/i, '');
    const now = Date.now();
    if (buckets.size > 1000) {
      for (const [key, value] of buckets) {
        if (now >= value.resetAt) buckets.delete(key);
      }
    }
    const bucket = buckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    } else if (bucket.count >= MAX_EVENTS_PER_WINDOW) {
      res.writeHead(429, { 'Cache-Control': 'no-store' }).end();
      return;
    } else {
      bucket.count += 1;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let closed = false;

    req.on('data', (chunk: Buffer) => {
      if (closed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        closed = true;
        res.writeHead(413, { 'Cache-Control': 'no-store' }).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (closed) return;
      closed = true;
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
        payload = parsed as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'Cache-Control': 'no-store' }).end();
        return;
      }

      const level: BrowserLevel = LEVELS.has(payload.level as BrowserLevel)
        ? (payload.level as BrowserLevel)
        : 'info';
      const event = text(payload.event, 80) || 'browser.event';
      logger[level](
        {
          source: 'browser',
          ip,
          clientId: text(payload.clientId, 64),
          nickname: text(payload.nickname, 40),
          page: text(payload.page, 200),
          clientTs: typeof payload.ts === 'number' ? payload.ts : undefined,
          // 放在子对象里，避免与顶层字段（如 clientId）重名时互相覆盖
          details: sanitizeDetails(payload.details),
        },
        event,
      );

      res.writeHead(204, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }).end();
    });

    req.on('error', () => {
      if (closed) return;
      closed = true;
      res.destroy();
    });
  };
}
