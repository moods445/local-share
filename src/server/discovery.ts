import dgram from 'node:dgram';
import os from 'node:os';
import type { Announce, PeerInfo, SelfInfo } from './types.js';

const TIMEOUT_MS = 12_000;
const ANNOUNCE_INTERVAL_MS = 3_000;

export interface DiscoveryHooks {
  getSelf: () => SelfInfo;
  onPeer: (peer: PeerInfo) => void;
  onPeerGone: (device: string) => void;
  onPeerNickname: (device: string, nickname: string) => void;
  onPeerChanged: (peer: PeerInfo) => void;
}

export class Discovery {
  private socket: dgram.Socket;
  private peers = new Map<string, { peer: PeerInfo; lastSeen: number }>();
  private timer?: NodeJS.Timeout;
  private hooks: DiscoveryHooks;
  private port: number;
  private started = false;

  constructor(port: number, hooks: DiscoveryHooks) {
    this.port = port;
    this.hooks = hooks;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  }

  start(): void {
    this.socket.on('message', (msg, rinfo) => this.handle(msg, rinfo));
    this.socket.on('error', (err) => console.error('[discovery] socket error:', err.message));
    this.socket.bind(this.port, () => {
      this.started = true;
      this.port = (this.socket.address() as { port: number }).port;
      this.socket.setBroadcast(true);
      this.broadcast();
      this.timer = setInterval(() => {
        this.broadcast();
        this.expire();
      }, ANNOUNCE_INTERVAL_MS);
      this.timer.unref();
      console.log(`[discovery] listening on UDP ${this.port}`);
    });
  }

  broadcast(target?: { host: string; port: number }): void {
    const self = this.hooks.getSelf();
    const announce: Announce = { t: 'hello', device: self.device, nickname: self.nickname, port: self.port };
    const payload = Buffer.from(JSON.stringify(announce));
    const targets = target
      ? [target]
      : [
          { host: '255.255.255.255', port: this.port },
          { host: '127.0.0.1', port: this.port },
        ];
    for (const item of targets) {
      this.socket.send(payload, item.port, item.host, (err) => {
        if (err) console.warn('[discovery] announce failed:', err.message);
      });
    }
  }

  list(): PeerInfo[] {
    return [...this.peers.values()].map((p) => p.peer);
  }

  private handle(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    let data: Announce;
    try {
      data = JSON.parse(msg.toString()) as Announce;
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (data.t !== 'hello' || !data.device || data.device === this.hooks.getSelf().device) return;
    if (!data.port) return;

    const peer: PeerInfo = {
      device: data.device,
      nickname: data.nickname || '未命名设备',
      host: rinfo.address,
      port: data.port,
    };
    const existing = this.peers.get(peer.device);
    if (existing) {
      const endpointChanged = existing.peer.host !== peer.host || existing.peer.port !== peer.port;
      if (existing.peer.nickname !== peer.nickname) {
        this.hooks.onPeerNickname(peer.device, peer.nickname);
      }
      existing.peer = peer;
      existing.lastSeen = Date.now();
      if (endpointChanged) this.hooks.onPeerChanged(peer);
    } else {
      this.peers.set(peer.device, { peer, lastSeen: Date.now() });
      this.hooks.onPeer(peer);
    }
  }

  private expire(): void {
    const now = Date.now();
    for (const [device, entry] of this.peers) {
      if (now - entry.lastSeen > TIMEOUT_MS) {
        this.peers.delete(device);
        this.hooks.onPeerGone(device);
      }
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.socket.close();
  }
}

export function localAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}
