import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createStaticHandler } from './static.js';

function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    sock.on('data', (chunk) => {
      data += chunk.toString();
    });
    sock.on('error', () => undefined);
    sock.on('close', () => resolve(data));
    setTimeout(() => resolve(data), 1500);
  });
}

describe('static handler', () => {
  let dir: string;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsa-static-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>home</h1>');
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    server = http.createServer(createStaticHandler(dir));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('根路径返回 index.html', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<h1>home</h1>');
  });

  it('静态资源返回正确 MIME 与内容', async () => {
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toBe('console.log(1)');
  });

  it('目录回退到 index.html', async () => {
    const res = await fetch(`${base}/assets/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>home</h1>');
  });

  it('阻止编码路径穿越', async () => {
    const res = await fetch(`${base}/..%2f..%2fetc/passwd`);
    expect(res.status).toBe(403);
  });

  it('畸形请求地址返回 400 且不崩溃', async () => {
    const response = await rawRequest(new URL(base).port, '//[%2f');
    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
  });

  (typeof process.getuid === 'function' && process.getuid() === 0 ? it.skip : it)(
    '文件不可读时断开响应而不是崩溃',
    async () => {
      const file = path.join(dir, 'locked.txt');
      fs.writeFileSync(file, 'secret');
      fs.chmodSync(file, 0o000);
      await expect(fetch(`${base}/locked.txt`)).rejects.toThrow();
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<h1>home</h1>');
    },
  );

  it('缺少文件时返回 404', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lsa-empty-'));
    const testServer = http.createServer(createStaticHandler(empty));
    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const addr = testServer.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/missing`);
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
