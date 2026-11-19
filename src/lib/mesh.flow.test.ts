import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ShareMesh, type TimelineItem, type PeerView, type SelfView } from './mesh';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  emit(msg: object) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

class FakeDC {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  binaryType = 'arraybuffer';
  addEventListener() {}
  removeEventListener() {}
  send(data: unknown) { this.sent.push(data); }
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
});
