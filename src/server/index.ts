#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { Relay } from './relay.js';
import { createStaticHandler } from './static.js';

function arg(name: string, fallback: string): string {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(arg('port', process.env.PORT ?? '3000'));
const staticDir = path.resolve(arg('static', process.env.STATIC_DIR ?? path.join(process.cwd(), 'out')));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('无效的 HTTP 端口:', port);
  process.exit(1);
}

const relay = new Relay();
const server = http.createServer(createStaticHandler(staticDir));
server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));

server.listen(port, () => {
  console.log('local-share 群聊服务器已启动');
  console.log(`  页面地址: http://localhost:${port}`);
  console.log('  局域网内其他设备打开该页面地址即可自动进群');
  console.log('  每个浏览器客户端都是独立成员，服务器仅转发信令');
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
