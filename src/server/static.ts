import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStaticHandler(root: string): (req: IncomingMessage, res: ServerResponse) => void {
  const resolvedRoot = path.resolve(root);
  return (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    let filePath = path.resolve(resolvedRoot, '.' + pathname);
    if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if (filePath === resolvedRoot || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(resolvedRoot, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('静态页面未找到，请先运行 pnpm build 构建前端。');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };
}
