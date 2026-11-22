import type { Logger } from './logger';
import { readLimitedBody } from './http';

const MAX_BODY_BYTES = 16 * 1024;
const WINDOW_MS = 60_000;
const MAX_EVENTS_PER_WINDOW = 120;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

type BrowserLevel = 'debug' | 'info' | 'warn' | 'error';

interface LimitBucket {
  count: number;
  resetAt: number;
}

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** 只保留浅层标量字段，避免前端上报把日志体积撑爆；键冲突时丢弃后者。 */
function sanitizeDetails(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    const name = key.slice(0, 40);
    if (name in output) continue;
    if (typeof item === 'string') output[name] = item.slice(0, 400);
    else if (typeof item === 'number' || typeof item === 'boolean') output[name] = item;
  }
  return output;
}

/** 与 /browser 使用同一信任策略：只有 TRUST_PROXY=1 才采信 X-Forwarded-For。 */
function clientIp(headers: Headers, trustProxy: boolean): string {
  const cf = headers.get('cf-connecting-ip');
  const forwarded = headers.get('x-forwarded-for');
  const raw = trustProxy && forwarded && forwarded.trim()
    ? forwarded.split(',')[0].trim()
    : (cf ?? '');
  return raw.replace(/^::ffff:/i, '') || 'unknown';
}

/**
 * 接收前端埋点（浏览器连接生命周期事件），统一落到服务端 Pino 日志。
 * 仅接收小体量 JSON，并按来源地址限流，避免公开端点被刷。
 * 与框架无关：Route Handler 直接调用 handle(request)。
 */
export class ClientLogHandler {
  private buckets = new Map<string, LimitBucket>();

  constructor(private logger: Logger, private trustProxy = false) {}

  async handle(request: Request): Promise<Response> {
    const ip = clientIp(request.headers, this.trustProxy);
    const now = Date.now();
    // 惰性清理过期桶，避免 map 无界增长
    for (const [key, value] of this.buckets) {
      if (now >= value.resetAt) this.buckets.delete(key);
    }
    const bucket = this.buckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    } else if (bucket.count >= MAX_EVENTS_PER_WINDOW) {
      return new Response(null, { status: 429, headers: { 'Cache-Control': 'no-store' } });
    } else {
      bucket.count += 1;
    }

    const body = await readLimitedBody(request, MAX_BODY_BYTES);
    if (!body.ok) {
      return new Response(null, { status: 413, headers: { 'Cache-Control': 'no-store' } });
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body.text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      payload = parsed as Record<string, unknown>;
    } catch {
      return new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const level: BrowserLevel = LEVELS.has(payload.level as BrowserLevel)
      ? (payload.level as BrowserLevel)
      : 'info';
    const event = text(payload.event, 80) || 'browser.event';
    this.logger[level](
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

    return new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
