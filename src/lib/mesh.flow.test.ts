import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ShareMesh, encodeChunk, type TimelineItem, type PeerView, type SelfView } from './mesh';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({ code: 1005, reason: '', wasClean: true }); }
  emit(msg: object) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

class FakeDC {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: unknown[] = [];
  autoCloseAfterChunks = 0;
  private chunkCount = 0;
  private listeners = new Map<string, Array<() => void>>();
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  binaryType = 'arraybuffer';
  addEventListener(type: string, fn: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: () => void) {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }
  emitBufferedAmountLow() {
    for (const fn of [...(this.listeners.get('bufferedamountlow') ?? [])]) fn();
  }
  send(data: unknown) {
    this.sent.push(data);
    if (this.autoCloseAfterChunks > 0 && data instanceof ArrayBuffer) {
      this.chunkCount += 1;
      if (this.chunkCount >= this.autoCloseAfterChunks) this.close();
    }
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
  open() { this.onopen?.(); }
}

class FakePC {
  static instances: FakePC[] = [];
  localDescription = { toJSON: () => ({ type: 'offer', sdp: 'x' }) };
  signalingState = 'stable';
  ondatachannel: ((e: { channel: FakeDC }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  dc = new FakeDC();
  constructor() { FakePC.instances.push(this); }
  createDataChannel() { return this.dc; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}

describe('ShareMesh 发送/取消/确认流程', () => {
  let items: TimelineItem[];
  let mesh: ShareMesh;

  beforeEach(() => {
    FakeSocket.instances = [];
    FakePC.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('crypto', { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
    items = [];
    mesh = new ShareMesh('ws://localhost/browser', {
      onItem: (item) => {
        const i = items.findIndex((x) => x.id === item.id);
        if (i < 0) items.push({ ...item });
        else items[i] = { ...item };
      },
      onPeers: () => {},
      onSelf: () => {},
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function registerPeer() {
    const sock = FakeSocket.instances[0];
    sock.onopen?.();
    sock.emit({
      t: 'init',
      clients: [{ clientId: 'remote-client', nickname: '对端' }],
    });
    const pc = FakePC.instances[0];
    pc.ondatachannel?.({ channel: pc.dc });
    pc.dc.open();
  }

  it('无在线 peer 时发送标记为失败', async () => {
    mesh.start();
    const sock = FakeSocket.instances[0];
    sock.onopen?.();
    sock.emit({ t: 'init', clients: [] });
    mesh.sendText('hello');
    await new Promise((r) => setTimeout(r, 20));
    expect(items[0].status).toBe('failed');
  });

  it('发送文字并收到 ACK 后标记为已送达', async () => {
    mesh.start();
    registerPeer();
    mesh.sendText('hi');
    await new Promise((r) => setTimeout(r, 20));
    const sent = items[0];
    expect(sent.status).not.toBe('failed');
    // 模拟对端确认
    const pc = FakePC.instances[0];
    const meta = JSON.parse(pc.dc.sent[0] as string) as { id: string };
    pc.dc.onmessage?.({ data: JSON.stringify({ k: 'ack', id: meta.id }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(items[0].status).toBe('sent');
    expect(items[0].delivered).toBe(1);
  });

  it('发送文件过程中取消后状态为已取消', async () => {
    mesh.start();
    registerPeer();
    const file = { name: 'a.bin', size: 5, type: 'application/octet-stream', arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer } as File;
    mesh.sendFile(file);
    await new Promise((r) => setTimeout(r, 20));
    const id = items[0].id;
    mesh.cancel(id);
    expect(items[0].status).toBe('cancelled');
    const pc = FakePC.instances[0];
    const cancelFrames = pc.dc.sent.filter((s) => typeof s === 'string' && JSON.parse(s).k === 'cancel');
    expect(cancelFrames.length).toBeGreaterThan(0);
  });

  it('接收单分片文件在数据到达前不标记已接收', async () => {
    mesh.start();
    registerPeer();
    const pc = FakePC.instances[0];
    const meta = {
      k: 'meta', id: 'm1', type: 'file', from: 'remote-client', fromNickname: '对端',
      ts: Date.now(), size: 5, fileName: 'a.txt', mimeType: 'text/plain', chunks: 1,
    };
    pc.dc.onmessage?.({ data: JSON.stringify(meta) });
    expect(items[0].status).toBe('receiving');
    expect(items[0].url).toBeUndefined();
  });

  it('以浏览器自身身份注册，并把每个客户端作为独立成员', async () => {
    const peerEvents: PeerView[][] = [];
    const selfEvents: SelfView[] = [];
    mesh = new ShareMesh('ws://localhost/browser', {
      onItem: () => {},
      onPeers: (peers) => { peerEvents.push(peers); },
      onSelf: (self) => { selfEvents.push(self); },
    });
    mesh.start();
    const sock = FakeSocket.instances[0];
    sock.onopen?.();

    const register = JSON.parse(sock.sent[0]) as { t: string; clientId: string; nickname: string };
    expect(register.t).toBe('register');
    expect(register.clientId).toBeTruthy();
    expect(register.nickname).toBeTruthy();
    expect(selfEvents.at(-1)?.clientId).toBe(register.clientId);

    sock.emit({ t: 'init', clients: [
      { clientId: 'a', nickname: '甲' },
      { clientId: 'b', nickname: '乙' },
    ] });
    expect(peerEvents.at(-1)?.map((p) => p.nickname)).toEqual(['甲', '乙']);

    sock.emit({ t: 'peer-nickname', clientId: 'a', nickname: '甲改' });
    expect(peerEvents.at(-1)?.find((p) => p.clientId === 'a')?.nickname).toBe('甲改');

    sock.emit({ t: 'client-offline', clientId: 'b' });
    expect(peerEvents.at(-1)?.map((p) => p.clientId)).toEqual(['a']);
  });

  it('发送过程中 DataChannel 断开时结束发送状态', async () => {
    mesh.start();
    registerPeer();
    const dc = FakePC.instances[0].dc;
    dc.autoCloseAfterChunks = 2;
    const buffer = new Uint8Array(16 * 1024 * 4).buffer;
    const file = { name: 'a.bin', size: buffer.byteLength, type: 'application/octet-stream', arrayBuffer: async () => buffer } as File;
    mesh.sendFile(file);
    await new Promise((r) => setTimeout(r, 20));
    expect(items[0].status).toBe('partial');
    expect(items[0].progress).toBeLessThan(1);
  });

  it('已完成的接收不会被迟到的 cancel 覆盖', () => {
    mesh.start();
    registerPeer();
    const dc = FakePC.instances[0].dc;
    dc.onmessage?.({ data: JSON.stringify({ k: 'meta', id: 'm-cancel', type: 'file', from: 'remote-client', fromNickname: '对端', ts: Date.now(), size: 3, fileName: 'a.txt', mimeType: 'text/plain', chunks: 1 }) });
    dc.onmessage?.({ data: encodeChunk('m-cancel', 0, new Uint8Array([1, 2, 3]).buffer) });
    expect(items[0].status).toBe('received');
    dc.onmessage?.({ data: JSON.stringify({ k: 'cancel', id: 'm-cancel' }) });
    expect(items[0].status).toBe('received');
    expect(items[0].url).toBe('blob:fake');
  });

  it('WS 断开后中止进行中的接收并清理协商状态', () => {
    mesh.start();
    registerPeer();
    const sock = FakeSocket.instances[0];
    const dc = FakePC.instances[0].dc;
    dc.onmessage?.({ data: JSON.stringify({ k: 'meta', id: 'm-drop', type: 'file', from: 'remote-client', fromNickname: '对端', ts: Date.now(), size: 40000, fileName: 'a.bin', mimeType: 'application/octet-stream', chunks: 3 }) });
    expect(items[0].status).toBe('receiving');
    (mesh as unknown as { makingOffer: Set<string> }).makingOffer.add('remote-client');
    sock.close();
    expect(items[0].status).toBe('cancelled');
    expect((mesh as unknown as { makingOffer: Set<string> }).makingOffer.size).toBe(0);
  });

  it('成员离线时中止其进行中的接收', () => {
    mesh.start();
    registerPeer();
    const sock = FakeSocket.instances[0];
    const dc = FakePC.instances[0].dc;
    dc.onmessage?.({ data: JSON.stringify({ k: 'meta', id: 'm-offline', type: 'file', from: 'remote-client', fromNickname: '对端', ts: Date.now(), size: 40000, fileName: 'a.bin', mimeType: 'application/octet-stream', chunks: 3 }) });
    sock.emit({ t: 'client-offline', clientId: 'remote-client' });
    expect(items[0].status).toBe('cancelled');
  });

  it('背压等待期间取消会立即停止发送', async () => {
    mesh.start();
    registerPeer();
    const dc = FakePC.instances[0].dc;
    dc.bufferedAmount = 2 * 1024 * 1024;
    const buffer = new Uint8Array(16 * 1024 * 4).buffer;
    const file = { name: 'a.bin', size: buffer.byteLength, type: 'application/octet-stream', arrayBuffer: async () => buffer } as File;
    mesh.sendFile(file);
    await new Promise((r) => setTimeout(r, 10));
    mesh.cancel(items[0].id);
    dc.emitBufferedAmountLow();
    await new Promise((r) => setTimeout(r, 10));
    expect(items[0].status).toBe('cancelled');
    expect(dc.sent.filter((s) => s instanceof ArrayBuffer)).toHaveLength(0);
  });

  it('修改昵称后通过 DataChannel 广播给成员', () => {
    mesh.start();
    registerPeer();
    const dc = FakePC.instances[0].dc;
    mesh.setNickname('新昵称');
    const frames = dc.sent
      .filter((s) => typeof s === 'string')
      .map((s) => JSON.parse(s as string)) as Array<{ k: string; nickname: string }>;
    expect(frames).toContainEqual({ k: 'nickname', nickname: '新昵称' });
  });

  it('收到服务器分配的昵称后更新本地身份并广播给成员', () => {
    const selfEvents: SelfView[] = [];
    mesh = new ShareMesh('ws://localhost/browser', {
      onItem: () => {},
      onPeers: () => {},
      onSelf: (self) => { selfEvents.push(self); },
    });
    mesh.start();
    const sock = FakeSocket.instances[0];
    sock.onopen?.();
    registerPeer();
    const dc = FakePC.instances[0].dc;

    sock.emit({ t: 'nickname-assigned', nickname: '甲12345' });
    expect(selfEvents.at(-1)?.nickname).toBe('甲12345');

    const frames = dc.sent
      .filter((s) => typeof s === 'string')
      .map((s) => JSON.parse(s as string)) as Array<{ k: string; nickname: string }>;
    expect(frames).toContainEqual({ k: 'nickname', nickname: '甲12345' });
  });

  it('成员状态随 DataChannel 打开与关闭变化', () => {
    const peerEvents: PeerView[][] = [];
    mesh = new ShareMesh('ws://localhost/browser', {
      onItem: () => {},
      onPeers: (peers) => { peerEvents.push(peers); },
      onSelf: () => {},
    });
    mesh.start();
    const sock = FakeSocket.instances[0];
    sock.onopen?.();
    sock.emit({ t: 'init', clients: [{ clientId: 'remote-client', nickname: '对端' }] });

    const stateOf = () => peerEvents.at(-1)?.find((p) => p.clientId === 'remote-client')?.state;
    expect(stateOf()).toBe('connecting');

    const pc = FakePC.instances[0];
    pc.ondatachannel?.({ channel: pc.dc });
    expect(stateOf()).toBe('connecting');
    pc.dc.open();
    expect(stateOf()).toBe('connected');
    pc.dc.close();
    expect(stateOf()).toBe('connecting');
  });

  it('已发现但未连通的成员计入送达分母', async () => {
    mesh.start();
    const sock = FakeSocket.instances[0];
    sock.onopen?.();
    sock.emit({ t: 'init', clients: [{ clientId: 'remote-client', nickname: '对端' }] });

    mesh.sendText('hi');
    await new Promise((r) => setTimeout(r, 20));
    expect(items[0].status).toBe('partial');
    expect(items[0].total).toBe(1);
    expect(items[0].delivered).toBe(0);
  });
});
