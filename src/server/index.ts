#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import nextModule from 'next';
import { Relay } from './relay.js';

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
  console.error('无效的 HTTP 端口:', port);
  process.exit(1);
}

const app = next({ dev, dir });
const handle = app.getRequestHandler();
const relay = new Relay({ trustProxy: process.env.TRUST_PROXY === '1' });

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
  void ensurePrepared()
    .then(() => handle(req, res))
    .catch((error: unknown) => {
      console.error('[server] 处理请求失败:', error instanceof Error ? error.message : error);
      if (!res.headersSent) res.writeHead(500).end('Internal Server Error');
      else res.destroy();
    });
});

// Next 自己也会监听 upgrade（开发时的 HMR），因此只接管 /browser，其余放行
server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));

server.on('error', (err) => {
  console.error('服务器启动失败:', err.message);
  process.exit(1);
});

server.listen(port, () => {
  console.log('local-share 服务器已启动');
  console.log(`  页面地址: http://localhost:${port}`);
  console.log('  同一局域网的设备（同一公网出口）打开该页面地址即可自动进群');
  console.log('  跨网络默认隔离：仅同一来源出口的客户端互相可见；反代部署可设 TRUST_PROXY=1');
  console.log('  每个浏览器客户端都是独立成员，服务器仅转发信令');
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
