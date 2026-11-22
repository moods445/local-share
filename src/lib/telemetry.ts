'use client';

export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

interface TelemetryContext {
  clientId?: string;
  nickname?: string;
}

interface TelemetryPayload extends TelemetryContext {
  level: TelemetryLevel;
  event: string;
  page: string;
  ts: number;
  details?: Record<string, unknown>;
}

const TELEMETRY_ENABLED = process.env.NEXT_PUBLIC_TELEMETRY_ENABLED !== '0';

let endpoint = '/log';
let context: TelemetryContext = {};

/** 线上构建可用 NEXT_PUBLIC_TELEMETRY_ENABLED=0 直接关闭前端埋点上报。 */
export function telemetryEnabled(): boolean {
  return TELEMETRY_ENABLED;
}

/**
 * 由信令地址推导埋点上报地址：http(s)://host/browser → http(s)://host/log。
 * 页面与服务器同源时等价于相对路径 /log。
 */
export function initTelemetry(signalingUrl: string): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(signalingUrl, window.location.href);
    if (
      url.protocol === 'ws:' ||
      url.protocol === 'wss:' ||
      url.protocol === 'http:' ||
      url.protocol === 'https:'
    ) {
      const secure = url.protocol === 'wss:' || url.protocol === 'https:';
      endpoint = `${secure ? 'https:' : 'http:'}//${url.host}/log`;
    }
  } catch {
    endpoint = '/log';
  }
}

export function setTelemetryContext(patch: TelemetryContext): void {
  context = { ...context, ...patch };
}

/** 上报前端事件到服务端 Pino 日志；埋点失败绝不影响主流程。 */
export function report(
  level: TelemetryLevel,
  event: string,
  details?: Record<string, unknown>,
): void {
  if (typeof window === 'undefined') return;
  if (!TELEMETRY_ENABLED) return;
  const payload: TelemetryPayload = {
    level,
    event,
    page: window.location.pathname,
    ts: Date.now(),
    clientId: context.clientId,
    nickname: context.nickname,
    details,
  };
  try {
    const body = JSON.stringify(payload);
    if (typeof navigator.sendBeacon === 'function') {
      // text/plain 属于简单请求，跨源上报也不会触发预检
      const queued = navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
      if (queued) return;
    }
    void fetch(endpoint, {
      method: 'POST',
      body,
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 忽略上报异常
  }
}
