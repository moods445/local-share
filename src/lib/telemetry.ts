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

let endpoint = '/log';
let context: TelemetryContext = {};

/**
 * 由信令地址推导埋点上报地址：ws://host/browser → http://host/log。
 * 页面与服务器同源时直接使用相对路径 /log。
 */
export function initTelemetry(signalingUrl: string): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(signalingUrl, window.location.href);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      endpoint = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}/log`;
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
