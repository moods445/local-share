import pino, { type Logger } from 'pino';

/**
 * 服务端统一日志器。默认输出 JSON 到标准输出，便于容器/日志系统采集。
 * LOG_LEVEL 可覆盖级别（trace/debug/info/warn/error/fatal）。
 * Node 侧使用同步写入，保证进程退出前的 fatal 日志不会丢失；
 * 非 Node（如 Cloudflare Workers）没有 fs/sonic-boom，退回 pino 默认 stdout 写入。
 */
const level = process.env.LOG_LEVEL ?? 'info';

let destination: ReturnType<typeof pino.destination> | undefined;
if (typeof process.getBuiltinModule === 'function') {
  try {
    process.getBuiltinModule('node:fs');
    destination = pino.destination({ dest: 1, sync: true });
  } catch {
    destination = undefined;
  }
}

export const logger: Logger = pino(
  {
    level,
    base: { service: 'local-share' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destination,
);

export type { Logger };
