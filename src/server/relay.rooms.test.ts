import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { Relay } from './relay.js';

type Msg = Record<string, unknown>;

interface Client {
  ws: WebSocket;
  messages: Msg[];
}

const NET_A = '203.0.113.7';
const NET_B = '198.51.100.3';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('relay 网络分组隔离', () => {
  let relay: Relay;
  let server: http.Server;
  let port: number;
  let clients: Client[];

  beforeEach(async () => {
    // 模拟位于可信反代之后，来源网络取自 X-Forwarded-For
    relay = new Relay({ trustProxy: true });
    server = http.createServer((_req, res) => {
      res.writeHead(404).end('no');
    });
    server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(network: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client: Client = {
        ws: new WebSocket(`ws://127.0.0.1:${port}/browser`, {
          headers: { 'X-Forwarded-For': network },
        }),
        messages: [],
      };
      client.ws.on('message', (raw) => client.messages.push(JSON.parse(raw.toString()) as Msg));
      client.ws.on('open', () => resolve(client));
      client.ws.on('error', reject);
      clients.push(client);
    });
  }

  function send(client: Client, msg: Msg): void {
    client.ws.send(JSON.stringify(msg));
  }

  function next(client: Client, predicate: (msg: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    const start = client.messages.length;
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const found = client.messages.slice(start).find(predicate);
        if (found) {
          clearInterval(timer);
          resolve(found);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('等待消息超时'));
        }
      }, 10);
    });
  }

  async function register(client: Client, clientId: string, nickname: string): Promise<Msg> {
    const init = next(client, (m) => m.t === 'init');
    send(client, { t: 'register', clientId, nickname });
    return init;
  }

  it('同一网络内的客户端互相发现', async () => {
    const a = await connect(NET_A);
    expect(await register(a, 'A', '甲')).toEqual({ t: 'init', clients: [] });

    // 先挂上等待，再触发对端上线，避免错过已到达的消息
    const aOnline = next(a, (m) => m.t === 'client-online');
    const b = await connect(NET_A);
    expect(await register(b, 'B', '乙')).toEqual({
      t: 'init',
      clients: [{ clientId: 'A', nickname: '甲' }],
    });
    expect(await aOnline).toEqual({
      t: 'client-online',
      clientId: 'B',
      nickname: '乙',
    });
  });

  it('同一局域网内不同地址归为一组（本地部署场景）', async () => {
    const a = await connect('192.168.1.10');
    await register(a, 'A', '甲');

    const aOnline = next(a, (m) => m.t === 'client-online');
    const b = await connect('192.168.1.11');
    expect(await register(b, 'B', '乙')).toEqual({
      t: 'init',
      clients: [{ clientId: 'A', nickname: '甲' }],
    });
    expect(await aOnline).toEqual({ t: 'client-online', clientId: 'B', nickname: '乙' });
  });

  it('192.168 下不同子网归为一组（/16）', async () => {
    const a = await connect('192.168.1.10');
    await register(a, 'A', '甲');

    const b = await connect('192.168.2.10');
    expect(await register(b, 'B', '乙')).toEqual({
      t: 'init',
      clients: [{ clientId: 'A', nickname: '甲' }],
    });
  });

  it('10/8 与 172.16/12 各自按块边界归组', async () => {
    const a = await connect('10.1.2.3');
    await register(a, 'A', '甲');
    const b = await connect('10.9.8.7');
    expect(await register(b, 'B', '乙')).toEqual({
      t: 'init',
      clients: [{ clientId: 'A', nickname: '甲' }],
    });

    const c = await connect('172.16.5.5');
    await register(c, 'C', '丙');
    const d = await connect('172.31.4.4');
    expect(await register(d, 'D', '丁')).toEqual({
      t: 'init',
      clients: [{ clientId: 'C', nickname: '丙' }],
    });
  });

  it('不同私网块互相隔离', async () => {
    const a = await connect('192.168.1.10');
    await register(a, 'A', '甲');

    const b = await connect('10.0.0.10');
    expect(await register(b, 'B', '乙')).toEqual({ t: 'init', clients: [] });
    await delay(150);
    expect(a.messages.some((m) => m.t === 'client-online')).toBe(false);
  });

  it('公网 192.x 地址不套用私网 /16 规则', async () => {
    const a = await connect('192.0.2.10');
    await register(a, 'A', '甲');

    const b = await connect('192.0.2.20');
    expect(await register(b, 'B', '乙')).toEqual({ t: 'init', clients: [] });
    await delay(150);
    expect(a.messages.some((m) => m.t === 'client-online')).toBe(false);
  });

  it('不同网络互不可见', async () => {
    const a = await connect(NET_A);
    await register(a, 'A', '甲');

    const b = await connect(NET_B);
    expect(await register(b, 'B', '乙')).toEqual({ t: 'init', clients: [] });
    await delay(150);
    expect(a.messages.some((m) => m.t === 'client-online')).toBe(false);
    expect(b.messages.some((m) => m.t === 'client-online')).toBe(false);
  });

  it('跨网络的信令被丢弃，同网络信令正常转发', async () => {
    const a = await connect(NET_A);
    await register(a, 'A', '甲');
    const b = await connect(NET_A);
    await register(b, 'B', '乙');
    const c = await connect(NET_B);
    await register(c, 'C', '丙');

    send(c, { t: 'signal', toClient: 'B', data: { description: { type: 'offer' } } });
    await delay(150);
    expect(b.messages.some((m) => m.t === 'signal')).toBe(false);

    const forwarded = next(b, (m) => m.t === 'signal');
    send(a, { t: 'signal', toClient: 'B', data: { description: { type: 'answer' } } });
    expect(await forwarded).toEqual({
      t: 'signal',
      fromClient: 'A',
      data: { description: { type: 'answer' } },
    });
  });

  it('IPv4-mapped IPv6 地址归一到同一网络', async () => {
    const a = await connect(NET_A);
    await register(a, 'A', '甲');

    const b = await connect(`::ffff:${NET_A}`);
    expect(await register(b, 'B', '乙')).toEqual({
      t: 'init',
      clients: [{ clientId: 'A', nickname: '甲' }],
    });
  });
});
