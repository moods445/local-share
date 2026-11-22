import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import pino from 'pino';
import { WebSocket } from 'ws';
import { Relay } from './relay.js';

type Msg = Record<string, unknown>;

const silentLogger = pino({ level: 'silent' });

interface Client {
  ws: WebSocket;
  messages: Msg[];
}

function rawRequest(port: number, target: string, upgrade = false): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const headers = upgrade
        ? 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
        : 'Connection: close\r\n';
      sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n${headers}\r\n`);
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

describe('relay', () => {
  let relay: Relay;
  let server: http.Server;
  let port: number;
  let url: string;
  let clients: Client[];

  beforeEach(async () => {
    relay = new Relay({ logger: silentLogger });
    server = http.createServer((_req, res) => {
      res.writeHead(404).end('no');
    });
    server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    url = `ws://127.0.0.1:${port}/browser`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(): Client {
    const ws = new WebSocket(url);
    const client: Client = { ws, messages: [] };
    ws.on('message', (raw) => client.messages.push(JSON.parse(raw.toString()) as Msg));
    clients.push(client);
    return client;
  }

  function opened(client: Client): Promise<void> {
    return new Promise((resolve, reject) => {
      if (client.ws.readyState === WebSocket.OPEN) return resolve();
      client.ws.once('open', () => resolve());
      client.ws.once('error', (err) => reject(err));
    });
  }

  function send(client: Client, msg: Msg): void {
    client.ws.send(JSON.stringify(msg));
  }

  async function next(client: Client, predicate: (msg: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    const start = client.messages.length;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = client.messages.slice(start).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('等待消息超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('注册后返回现有成员并广播上线', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    expect(await next(a, (m) => m.t === 'init')).toEqual({ t: 'init', clients: [] });

    const b = connect();
    await opened(b);
    const bInit = next(b, (m) => m.t === 'init');
    const aOnline = next(a, (m) => m.t === 'client-online');
    send(b, { t: 'register', clientId: 'B', nickname: '乙' });

    expect(await bInit).toEqual({ t: 'init', clients: [{ clientId: 'A', nickname: '甲' }] });
    expect(await aOnline).toEqual({ t: 'client-online', clientId: 'B', nickname: '乙' });
  });

  it('按 toClient 转发信令并标注 fromClient', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    await next(a, (m) => m.t === 'init');

    const b = connect();
    await opened(b);
    send(b, { t: 'register', clientId: 'B', nickname: '乙' });
    await next(b, (m) => m.t === 'init');

    const aSignal = next(a, (m) => m.t === 'signal');
    send(b, { t: 'signal', toClient: 'A', data: { description: { type: 'offer' } } });
    expect(await aSignal).toEqual({
      t: 'signal',
      fromClient: 'B',
      data: { description: { type: 'offer' } },
    });
  });

  it('信令只发给目标客户端', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    await next(a, (m) => m.t === 'init');
    const b = connect();
    await opened(b);
    send(b, { t: 'register', clientId: 'B', nickname: '乙' });
    await next(b, (m) => m.t === 'init');
    const c = connect();
    await opened(c);
    send(c, { t: 'register', clientId: 'C', nickname: '丙' });
    await next(c, (m) => m.t === 'init');

    send(b, { t: 'signal', toClient: 'A', data: { candidate: { candidate: 'x' } } });
    await next(a, (m) => m.t === 'signal');
    expect(c.messages.some((m) => m.t === 'signal')).toBe(false);
  });

  it('昵称变更广播给其他成员', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    await next(a, (m) => m.t === 'init');
    const b = connect();
    await opened(b);
    send(b, { t: 'register', clientId: 'B', nickname: '乙' });
    await next(b, (m) => m.t === 'init');

    const aNickname = next(a, (m) => m.t === 'peer-nickname');
    send(b, { t: 'nickname', nickname: '乙2' });
    expect(await aNickname).toEqual({ t: 'peer-nickname', clientId: 'B', nickname: '乙2' });
  });

  it('同网昵称重复时追加 5 位随机码', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    expect(await next(a, (m) => m.t === 'init')).toEqual({ t: 'init', clients: [] });

    const b = connect();
    await opened(b);
    const bInit = next(b, (m) => m.t === 'init');
    const aOnline = next(a, (m) => m.t === 'client-online');
    const bAssigned = next(b, (m) => m.t === 'nickname-assigned');
    send(b, { t: 'register', clientId: 'B', nickname: '甲' });

    expect(await bInit).toEqual({ t: 'init', clients: [{ clientId: 'A', nickname: '甲' }] });
    const online = await aOnline;
    expect(online).toEqual({
      t: 'client-online',
      clientId: 'B',
      nickname: expect.stringMatching(/^甲\d{5}$/),
    });
    expect(await bAssigned).toEqual({ t: 'nickname-assigned', nickname: online.nickname });
  });

  it('多个成员重名时随机码互不相同', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    await next(a, (m) => m.t === 'init');

    const b = connect();
    await opened(b);
    const bAssigned = next(b, (m) => m.t === 'nickname-assigned');
    send(b, { t: 'register', clientId: 'B', nickname: '甲' });
    await next(b, (m) => m.t === 'init');

    const c = connect();
    await opened(c);
    const cAssigned = next(c, (m) => m.t === 'nickname-assigned');
    send(c, { t: 'register', clientId: 'C', nickname: '甲' });
    await next(c, (m) => m.t === 'init');

    const bName = String((await bAssigned).nickname);
    const cName = String((await cAssigned).nickname);
    expect(bName).toMatch(/^甲\d{5}$/);
    expect(cName).toMatch(/^甲\d{5}$/);
    expect(bName).not.toBe(cName);
  });

  it('昵称改成与他人重复时同样追加随机码', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    await next(a, (m) => m.t === 'init');
    const b = connect();
    await opened(b);
    send(b, { t: 'register', clientId: 'B', nickname: '乙' });
    await next(b, (m) => m.t === 'init');

    const aNickname = next(a, (m) => m.t === 'peer-nickname');
    const bAssigned = next(b, (m) => m.t === 'nickname-assigned');
    send(b, { t: 'nickname', nickname: '甲' });

    const peer = await aNickname;
    expect(peer).toEqual({
      t: 'peer-nickname',
      clientId: 'B',
      nickname: expect.stringMatching(/^甲\d{5}$/),
    });
    expect(await bAssigned).toEqual({ t: 'nickname-assigned', nickname: peer.nickname });
  });

  it('昵称不重复时不发送分配消息', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    await next(a, (m) => m.t === 'init');
    expect(a.messages.some((m) => m.t === 'nickname-assigned')).toBe(false);
  });

  it('断开连接后广播离线', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    await next(a, (m) => m.t === 'init');
    const b = connect();
    await opened(b);
    send(b, { t: 'register', clientId: 'B', nickname: '乙' });
    await next(b, (m) => m.t === 'init');

    const aOffline = next(a, (m) => m.t === 'client-offline');
    b.ws.close();
    expect(await aOffline).toEqual({ t: 'client-offline', clientId: 'B' });
  });

  it('重复 clientId 时通知旧连接被替换并关闭', async () => {
    const first = connect();
    await opened(first);
    send(first, { t: 'register', clientId: 'A', nickname: '甲' });
    await next(first, (m) => m.t === 'init');

    const second = connect();
    await opened(second);
    const secondInit = next(second, (m) => m.t === 'init');
    const firstReplaced = next(first, (m) => m.t === 'replaced');
    const firstClosed = new Promise<void>((resolve) => first.ws.once('close', () => resolve()));
    send(second, { t: 'register', clientId: 'A', nickname: '甲' });

    expect(await secondInit).toEqual({ t: 'init', clients: [] });
    expect(await firstReplaced).toEqual({ t: 'replaced' });
    await firstClosed;
  });

  it('同一连接改换 clientId 时清理旧 id', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    await next(a, (m) => m.t === 'init');

    const aInit = next(a, (m) => m.t === 'init');
    send(a, { t: 'register', clientId: 'B', nickname: '乙' });
    expect(await aInit).toEqual({ t: 'init', clients: [] });

    const c = connect();
    await opened(c);
    const cInit = next(c, (m) => m.t === 'init');
    send(c, { t: 'register', clientId: 'C', nickname: '丙' });
    expect(await cInit).toEqual({ t: 'init', clients: [{ clientId: 'B', nickname: '乙' }] });
  });

  it('null 与非对象消息不会导致服务崩溃', async () => {
    const a = connect();
    await opened(a);
    a.ws.send('null');
    a.ws.send('123');
    a.ws.send('"文本"');
    a.ws.send('[]');
    a.ws.send('不是 JSON');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const init = next(a, (m) => m.t === 'init');
    send(a, { t: 'register', clientId: 'A', nickname: '甲' });
    expect(await init).toEqual({ t: 'init', clients: [] });
  });

  it('注册前消息被忽略', async () => {
    const a = connect();
    await opened(a);
    send(a, { t: 'signal', toClient: 'B', data: {} });
    send(a, { t: 'nickname', nickname: '甲' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.messages).toEqual([]);
  });

  it('畸形的升级请求不会导致服务崩溃', async () => {
    const response = await rawRequest(port, '//[%2f', true);
    expect(response).toBe('');
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(404);
  });
});
