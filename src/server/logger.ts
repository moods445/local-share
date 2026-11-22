import pino, { type Logger } from 'pino';

/**
 * 服务端统一日志器。默认输出 JSON 到标准输出，便于容器/日志系统采集。
 * LOG_LEVEL 可覆盖级别（trace/debug/info/warn/error/fatal）。
 * 使用同步写入，保证 process.exit 前的 fatal 日志不会丢失。
 */
const level = process.env.LOG_LEVEL ?? 'info';

export const logger: Logger = pino(
  {
    level,
    base: { service: 'local-share' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({ dest: 1, sync: true }),
);

export type { Logger };
