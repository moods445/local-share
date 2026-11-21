import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dgram from 'node:dgram';
import { Discovery, type DiscoveryHooks } from './discovery.js';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.bind(0, '127.0.0.1', () => {
      const port = (socket.address() as { port: number }).port;
      socket.close(() => resolve(port));
    });
  });
}

describe('discovery', () => {
  let port: number;
  let hooks: DiscoveryHooks;
  let discovery: Discovery | null;

  beforeEach(async () => {
    port = await freePort();
    hooks = {
      getSelf: () => ({ device: 'self', nickname: '自己', port: 3000 }),
      onPeer: vi.fn(),
      onPeerGone: vi.fn(),
      onPeerNickname: vi.fn(),
      onPeerChanged: vi.fn(),
    };
    discovery = null;
  });

  afterEach(() => discovery?.stop());

  it('接收广播并回调 onPeer，忽略自身', async () => {
    discovery = new Discovery(port, hooks);
    discovery.start();
    await new Promise((r) => setTimeout(r, 100));

    const sender = dgram.createSocket('udp4');
    const send = (payload: object) => new Promise<void>((resolve) => {
      sender.send(Buffer.from(JSON.stringify(payload)), port, '127.0.0.1', () => resolve());
    });
    await send({ t: 'hello', device: 'self', nickname: '自己', port: 3000 });
    await send({ t: 'hello', device: 'peer-1', nickname: '邻居', port: 3001 });
    await new Promise((r) => setTimeout(r, 150));
    sender.close();

    expect(hooks.onPeer).toHaveBeenCalledTimes(1);
    expect(hooks.onPeer).toHaveBeenCalledWith(
      expect.objectContaining({ device: 'peer-1', nickname: '邻居', port: 3001 }),
    );
    expect(discovery.list()).toHaveLength(1);
  });

  it('昵称变化时回调 onPeerNickname', async () => {
    discovery = new Discovery(port, hooks);
    discovery.start();
    await new Promise((r) => setTimeout(r, 100));
    const sender = dgram.createSocket('udp4');
    const send = (payload: object) => new Promise<void>((resolve) => {
      sender.send(Buffer.from(JSON.stringify(payload)), port, '127.0.0.1', () => resolve());
    });
    await send({ t: 'hello', device: 'p', nickname: 'A', port: 3001 });
    await send({ t: 'hello', device: 'p', nickname: 'B', port: 3001 });
    await new Promise((r) => setTimeout(r, 150));
    sender.close();
    expect(hooks.onPeerNickname).toHaveBeenCalledWith('p', 'B');
  });

  it('端点变化时回调 onPeerChanged', async () => {
    discovery = new Discovery(port, hooks);
    discovery.start();
    await new Promise((r) => setTimeout(r, 100));
    const sender = dgram.createSocket('udp4');
    const send = (payload: object) => new Promise<void>((resolve) => {
      sender.send(Buffer.from(JSON.stringify(payload)), port, '127.0.0.1', () => resolve());
    });
    await send({ t: 'hello', device: 'p', nickname: 'A', port: 3001 });
    await send({ t: 'hello', device: 'p', nickname: 'A', port: 3999 });
    await new Promise((r) => setTimeout(r, 150));
    sender.close();
    expect(hooks.onPeerChanged).toHaveBeenCalledWith(expect.objectContaining({ device: 'p', port: 3999 }));
  });

  it('null 或畸形 UDP 包不会导致服务崩溃', async () => {
    discovery = new Discovery(port, hooks);
    discovery.start();
    await new Promise((r) => setTimeout(r, 100));

    const sender = dgram.createSocket('udp4');
    const send = (payload: string) => new Promise<void>((resolve) => {
      sender.send(Buffer.from(payload), port, '127.0.0.1', () => resolve());
    });
    await send('null');
    await send('123');
    await send('"文本"');
    await send('[]');
    await send('不是 JSON');
    await send('{"t":"hello"}');
    await send('{"t":"hello","device":"peer-null","nickname":"邻居","port":3001}');
    await new Promise((r) => setTimeout(r, 150));
    sender.close();

    expect(hooks.onPeer).toHaveBeenCalledTimes(1);
    expect(discovery.list()).toHaveLength(1);
  });

  it('端口 0 时绑定系统分配端口并可正常停止', async () => {
    discovery = new Discovery(0, hooks);
    discovery.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(discovery.list()).toEqual([]);
    expect(() => discovery?.stop()).not.toThrow();
    expect(() => discovery?.stop()).not.toThrow();
  });
});
