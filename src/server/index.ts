#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import nextModule from 'next';
import { Relay } from './relay.js';
import { createClientLogHandler } from './client-log.js';
import { logger } from './logger.js';

interface NextApp {
  prepare(): Promise<void>;
  getRequestHandler(): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<unknown>;
  close(): Promise<void>;
}

const next = nextModule as unknown as (options: { dev: boolean; dir: string }) => NextApp;

function arg(name: string, fallback: string): string {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(arg('port', process.env.PORT ?? '3000'));
const dir = path.resolve(arg('dir', process.env.APP_DIR ?? process.cwd()));
const dev = process.env.NODE_ENV === 'development';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  logger.fatal({ port }, '无效的 HTTP 端口');
  process.exit(1);
}

if (!dev && !fs.existsSync(path.join(dir, '.next', 'BUILD_ID'))) {
  logger.fatal({ dir }, '未找到生产构建（.next/BUILD_ID）：请先运行 npm run build，或检查 --dir/APP_DIR 是否指向项目根目录');
  process.exit(1);
}

const app = next({ dev, dir });
const handle = app.getRequestHandler();
const relay = new Relay({ trustProxy: process.env.TRUST_PROXY === '1', logger });
const handleClientLog = createClientLogHandler(logger);

// 首次收到请求时才准备 Next，避免仅做端口检查时也要编译
let preparing: Promise<void> | null = null;
function ensurePrepared(): Promise<void> {
  if (preparing) return preparing;
  const pending = app.prepare().catch((error: unknown) => {
    preparing = null;
    throw error;
  });
  preparing = pending;
  return pending;
}

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '').split('?')[0];
  // 兼容 Next trailingSlash 配置带来的 /log/ 形式
  if (req.method === 'POST' && (pathname === '/log' || pathname === '/log/')) {
    handleClientLog(req, res);
    return;
  }
  void ensurePrepared()
    .then(() => handle(req, res))
    .catch((error: unknown) => {
      logger.error({ err: error }, '处理请求失败');
      if (!res.headersSent) res.writeHead(500).end('Internal Server Error');
      else res.destroy();
    });
});

// Next 自己也会监听 upgrade（开发时的 HMR），因此只接管 /browser，其余放行
server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));

server.on('error', (err) => {
  logger.fatal({ message: err.message }, '服务器启动失败');
  process.exit(1);
});

server.listen(port, () => {
  logger.info({ port, dev }, 'local-share 服务器已启动');
  logger.info('  页面地址: http://localhost:' + port);
  logger.info('  同一局域网的设备（同一公网出口）打开该页面地址即可自动进群');
  logger.info('  跨网络默认隔离：仅同一来源出口的客户端互相可见；反代部署可设 TRUST_PROXY=1');
  logger.info('  每个浏览器客户端都是独立成员，服务器仅转发信令');
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await app.close();
  } catch {
    // 忽略关闭阶段的异常
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
