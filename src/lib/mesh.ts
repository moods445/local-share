'use client';

import { initTelemetry, report, setTelemetryContext } from './telemetry';
import { SseAgentSocket, SOCKET_OPEN, type AgentSocket } from './agent-socket';

export type ContentType = 'text' | 'image' | 'file';
export type ItemStatus = 'sending' | 'sent' | 'partial' | 'receiving' | 'received' | 'failed' | 'cancelled';

export interface TimelineItem {
  id: string;
  type: ContentType;
  from: string;
  fromNickname: string;
  timestamp: number;
  status: ItemStatus;
  direction: 'out' | 'in';
  text?: string;
  fileName?: string;
  mimeType?: string;
  size: number;
  progress: number;
  delivered: number;
  total: number;
  url?: string;
}

/** 成员直连通道状态：发现后尚未建立 DataChannel 时为 connecting */
export type PeerState = 'connecting' | 'connected';

export interface PeerView {
  clientId: string;
  nickname: string;
  state: PeerState;
}

export interface SelfView {
  clientId: string;
  nickname: string;
  connected: boolean;
  /** 本页面的身份被同一浏览器的另一个标签页接管，已主动断开且不再重连 */
  replaced: boolean;
}

export interface MeshEvents {
  onItem: (item: TimelineItem) => void;
  onPeers: (peers: PeerView[]) => void;
  onSelf: (self: SelfView) => void;
}

interface MetaFrame {
  k: 'meta';
  id: string;
  type: ContentType;
  from: string;
  fromNickname: string;
  ts: number;
  size: number;
  fileName?: string;
  mimeType?: string;
  text?: string;
  chunks: number;
}

type ControlFrame = MetaFrame | { k: 'ack'; id: string } | { k: 'cancel'; id: string } | { k: 'nickname'; nickname: string };

interface Incoming {
  meta: MetaFrame;
  chunks: Array<ArrayBuffer | undefined>;
  received: number;
  from: string;
}

interface SignalData {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

const CHUNK_SIZE = 16 * 1024;
const ID_BYTES = 36;
const HEADER_BYTES = ID_BYTES + 4;
const BUFFERED_LIMIT = 1 << 20;
const CONNECT_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 2000;
const PEER_RECONNECT_DELAY_MS = 800;
const MAX_PEER_RETRIES = 5;
const MAX_SEEN_IDS = 500;
const MAX_CHUNKS = 10_000;
const CLIENT_ID_KEY = 'local-share.client-id';
const NICKNAME_KEY = 'local-share.nickname';

function storageGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式下 localStorage 可能不可用，身份仅保留在内存中
  }
}

function sessionGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 隐私模式下 sessionStorage 可能不可用，身份仅保留在内存中
  }
}

function loadClientId(): string {
  // clientId 按标签页隔离（sessionStorage）：同一浏览器多开标签页时若共用
  // localStorage 中的 id，服务端会反复关闭旧连接、旧页面又不断重连，形成
  // “一直正在连接群服务器…”的死循环。
  const stored = sessionGet(CLIENT_ID_KEY);
  if (stored) return stored;
  const id = uuid();
  sessionSet(CLIENT_ID_KEY, id);
  return id;
}

function detectDeviceName(): string {
  if (typeof navigator === 'undefined') return '浏览器';

  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const ua = nav.userAgent || '';
  const platform = nav.userAgentData?.platform || '';
  const hint = `${platform} ${ua}`;
  const touchPoints = nav.maxTouchPoints ?? 0;

  if (/iPhone|iPod/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1)) return 'iPad';
  if (/Android/i.test(hint)) return /Mobile/i.test(ua) ? 'Android 手机' : 'Android 平板';
  if (/CrOS/i.test(hint)) return 'ChromeOS';
  if (/Mac OS X|Macintosh/i.test(hint)) return 'Mac';
  if (/Windows NT|Windows/i.test(hint)) return 'Windows';
  if (/Linux|X11/i.test(hint)) return 'Linux';
  return platform || '浏览器';
}

function loadNickname(): string {
  const stored = storageGet(NICKNAME_KEY);
  return stored || detectDeviceName();
}

export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function encodeChunk(id: string, index: number, payload: ArrayBuffer): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer, 0, ID_BYTES);
  bytes.fill(0);
  bytes.set(new TextEncoder().encode(id).subarray(0, ID_BYTES));
  view.setUint32(ID_BYTES, index);
  new Uint8Array(buffer, HEADER_BYTES).set(new Uint8Array(payload));
  return buffer;
}

export function decodeChunk(data: ArrayBuffer): { id: string; index: number; payload: ArrayBuffer } | null {
  if (data.byteLength < HEADER_BYTES) return null;
  const view = new DataView(data);
  const raw = new Uint8Array(data, 0, ID_BYTES);
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end -= 1;
  const id = new TextDecoder().decode(raw.subarray(0, end));
  return { id, index: view.getUint32(ID_BYTES), payload: data.slice(HEADER_BYTES) };
}

function waitForDrain(dc: RTCDataChannel): Promise<void> {
  if (dc.bufferedAmount <= BUFFERED_LIMIT) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dc.removeEventListener('bufferedamountlow', finish);
      dc.removeEventListener('close', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    dc.addEventListener('bufferedamountlow', finish);
    dc.addEventListener('close', finish);
  });
}

export interface ShareMeshOptions {
  /** 测试用：注入信令传输实现，默认走 SSE + POST */
  createSocket?: (agentUrl: string, clientId: string, nickname: string) => AgentSocket;
}

export class ShareMesh {
  private clientId = loadClientId();
  private nickname = loadNickname();
  private socket?: AgentSocket;
  private peers = new Map<string, PeerView>();
  private pcs = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private makingOffer = new Set<string>();
  private ignoringOffer = new Map<string, boolean>();
  private retries = new Map<string, number>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private incoming = new Map<string, Incoming>();
  private seen = new Set<string>();
  private items = new Map<string, TimelineItem>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private replaced = false;
  private stopped = false;
  private events: MeshEvents;

  constructor(
    private agentUrl: string,
    events: MeshEvents,
    private meshOptions: ShareMeshOptions = {},
  ) {
    this.events = events;
  }

  start(): void {
    this.stopped = false;
    this.replaced = false;
    initTelemetry(this.agentUrl);
    setTelemetryContext({ clientId: this.clientId, nickname: this.nickname });
    report('info', 'mesh.start', { url: this.agentUrl });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    report('info', 'mesh.stop');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.socket?.close();
    this.socket = undefined;
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
    this.channels.clear();
    this.peers.clear();
    this.makingOffer.clear();
    this.ignoringOffer.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retries.clear();
    this.abortIncoming();
    this.replaced = false;
    this.events.onPeers([]);
  }

  setNickname(nickname: string): void {
    this.nickname = nickname;
    storageSet(NICKNAME_KEY, nickname);
    setTelemetryContext({ nickname });
    report('info', 'nickname.change', { nickname });
    this.broadcastControl({ k: 'nickname', nickname });
    this.sendToAgent({ t: 'nickname', nickname });
    this.emitSelf();
  }

  sendText(text: string): void {
    const payload = new TextEncoder().encode(text).buffer;
    void this.send('text', payload, { text });
  }

  sendFile(file: File): void {
    if (file.size > (file.type.startsWith('image/') ? 20 : 100) * 1024 * 1024) {
      throw new Error('文件超过大小限制');
    }
    void file.arrayBuffer().then((buffer) => this.send(file.type.startsWith('image/') ? 'image' : 'file', buffer, {
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
    }));
  }

  cancel(id: string): void {
    const item = this.items.get(id);
    if (!item || item.direction !== 'out') return;
    this.broadcastControl({ k: 'cancel', id });
    this.updateItem({ ...item, status: 'cancelled' });
  }

  private async send(type: ContentType, payload: ArrayBuffer, extra: Partial<TimelineItem>): Promise<void> {
    const id = uuid();
    const chunkCount = Math.max(1, Math.ceil(payload.byteLength / CHUNK_SIZE));
    const meta: MetaFrame = {
      k: 'meta',
      id,
      type,
      from: this.clientId,
      fromNickname: this.nickname,
      ts: Date.now(),
      size: payload.byteLength,
      chunks: chunkCount,
      text: extra.text,
      fileName: extra.fileName,
      mimeType: extra.mimeType,
    };
    const channels = [...this.channels.entries()].filter(([, dc]) => dc.readyState === 'open');
    const item: TimelineItem = {
      id,
      type,
      from: this.clientId,
      fromNickname: this.nickname,
      timestamp: meta.ts,
      status: 'sending',
      direction: 'out',
      size: payload.byteLength,
      progress: 0,
      delivered: 0,
      // 分母是「已发现的成员数」而不是「已建通道数」，未连通的成员算作未送达
      total: this.peers.size,
      ...extra,
    };
    this.items.set(id, item);
    this.updateItem(item);

    if (this.peers.size === 0) {
      this.updateItem({ ...item, status: 'failed' });
      return;
    }

    let sent = 0;
    const totalUnits = channels.length * chunkCount;
    let cancelled = false;
    for (const [, dc] of channels) {
      if (cancelled || dc.readyState !== 'open') break;
      dc.send(JSON.stringify(meta));
      for (let index = 0; index < chunkCount; index += 1) {
        let current = this.items.get(id);
        if (!current || current.status === 'cancelled') {
          cancelled = true;
          break;
        }
        await waitForDrain(dc);
        // 背压等待期间状态可能被取消或 ACK 更新，必须重新读取最新项
        current = this.items.get(id);
        if (!current || current.status === 'cancelled') {
          cancelled = true;
          break;
        }
        if (dc.readyState !== 'open') {
          cancelled = true;
          break;
        }
        const start = index * CHUNK_SIZE;
        const slice = payload.slice(start, Math.min(start + CHUNK_SIZE, payload.byteLength));
        dc.send(encodeChunk(id, index, slice));
        sent += 1;
        this.updateItem({ ...current, progress: sent / totalUnits });
      }
      if (cancelled) break;
    }
    const current = this.items.get(id);
    if (!current || current.status !== 'sending') return;
    this.updateItem({
      ...current,
      status: current.delivered >= current.total ? 'sent' : 'partial',
    });
  }

  private createSocket(): AgentSocket {
    if (this.meshOptions.createSocket) {
      return this.meshOptions.createSocket(this.agentUrl, this.clientId, this.nickname);
    }
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
    const stream = new URL(this.agentUrl, base);
    stream.searchParams.set('clientId', this.clientId);
    stream.searchParams.set('nickname', this.nickname);
    return new SseAgentSocket({
      streamUrl: stream.toString(),
      postUrl: new URL(this.agentUrl, base).toString(),
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const attempt = (this.attempts += 1);
    report('info', 'ws.connecting', { attempt, url: this.agentUrl });
    const socket = this.createSocket();
    this.socket = socket;
    let settled = false;
    this.connectTimer = setTimeout(() => {
      if (settled || this.socket !== socket) return;
      report('warn', 'ws.connect_timeout', {
        attempt,
        readyState: socket.readyState,
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
      // 连接挂起（服务器不回响应头、反代缓冲等）：主动断开，走 onclose 的重连逻辑
      socket.close(1006, 'connect timeout');
    }, CONNECT_TIMEOUT_MS);
    const settle = () => {
      settled = true;
      if (this.connectTimer) clearTimeout(this.connectTimer);
    };

    socket.onopen = () => {
      settle();
      report('info', 'ws.open', { attempt });
      this.emitSelf(true);
      // 注册用的昵称是建连时快照的；连上后补发一次，避免连接窗口内改昵称被丢
      this.sendToAgent({ t: 'nickname', nickname: this.nickname });
    };
    socket.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        report('warn', 'ws.bad_message');
        return;
      }
      this.onAgentMessage(msg);
    };
    socket.onclose = (event) => {
      settle();
      report(event.wasClean ? 'info' : 'warn', 'ws.close', {
        attempt,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      this.emitSelf(false);
      this.peers.clear();
      this.events.onPeers([]);
      for (const pc of this.pcs.values()) pc.close();
      this.pcs.clear();
      this.channels.clear();
      this.makingOffer.clear();
      this.ignoringOffer.clear();
      this.abortIncoming();
      if (!this.stopped && !this.replaced) {
        report('info', 'ws.reconnect', { delayMs: RECONNECT_DELAY_MS, nextAttempt: this.attempts + 1 });
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    };
    socket.onerror = () => {
      report('warn', 'ws.error', { attempt, readyState: socket.readyState });
    };
    socket.connect();
  }

  private onAgentMessage(msg: Record<string, unknown>): void {
    switch (msg.t) {
      case 'init': {
        const clients = (msg.clients as Array<{ clientId: string; nickname: string }>) ?? [];
        report('info', 'ws.init', { peers: clients.length });
        for (const client of clients) {
          this.addRemoteClient(String(client.clientId), String(client.nickname || '未命名成员'));
        }
        this.emitSelf();
        this.emitPeers();
        break;
      }
      case 'replaced': {
        // 同一 clientId 已被另一个连接接管：本页停止重连，避免两个页面互相踢
        this.replaced = true;
        report('warn', 'ws.replaced', { attempt: this.attempts });
        this.emitSelf(false);
        this.socket?.close(4001, 'replaced');
        break;
      }
      case 'client-online': {
        const clientId = String(msg.clientId);
        report('debug', 'peer.online', { clientId });
        if (clientId === this.clientId) break;
        const nickname = String(msg.nickname || '未命名成员');
        if (this.peers.has(clientId)) {
          // 同一 clientId 重复上线（多标签页替换/重连竞态）：旧连接可能已失效，
          // 关掉旧 PC 重建，避免复用死通道导致该成员永远“连接中”
          this.peers.get(clientId)!.nickname = nickname;
          this.teardownPeer(clientId);
        } else {
          this.peers.set(clientId, { clientId, nickname, state: 'connecting' });
        }
        this.emitPeers();
        this.setupPeer(clientId);
        break;
      }
      case 'client-offline': {
        report('debug', 'peer.offline', { clientId: String(msg.clientId) });
        this.removeRemoteClient(String(msg.clientId));
        break;
      }
      case 'peer-nickname': {
        const clientId = String(msg.clientId);
        const nickname = String(msg.nickname);
        const peer = this.peers.get(clientId);
        if (peer) {
          peer.nickname = nickname;
          this.emitPeers();
        }
        break;
      }
      case 'nickname-assigned': {
        // 服务器在本机昵称与群内其他成员重复时分配了带 5 位随机码的昵称
        const nickname = String(msg.nickname);
        if (nickname && nickname !== this.nickname) {
          this.nickname = nickname;
          storageSet(NICKNAME_KEY, nickname);
          setTelemetryContext({ nickname });
          report('info', 'nickname.assigned', { nickname });
          this.broadcastControl({ k: 'nickname', nickname });
          this.emitSelf();
        }
        break;
      }
      case 'signal': {
        this.handleSignal(String(msg.fromClient), msg.data as SignalData);
        break;
      }
      default:
        break;
    }
  }

  private addRemoteClient(clientId: string, nickname: string): void {
    if (clientId === this.clientId || this.peers.has(clientId)) return;
    this.peers.set(clientId, { clientId, nickname, state: 'connecting' });
    this.emitPeers();
    this.setupPeer(clientId);
  }

  private removeRemoteClient(clientId: string): void {
    if (!this.peers.delete(clientId)) return;
    const timer = this.retryTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(clientId);
    this.retries.delete(clientId);
    this.teardownPeer(clientId);
    this.abortIncoming(clientId);
    this.emitPeers();
  }

  /** 关闭并清理一个成员的 WebRTC 连接与协商状态（成员本身仍保留）。 */
  private teardownPeer(clientId: string): void {
    const pc = this.pcs.get(clientId);
    if (pc) pc.close();
    this.pcs.delete(clientId);
    this.channels.delete(clientId);
    this.makingOffer.delete(clientId);
    this.ignoringOffer.delete(clientId);
  }

  /** DataChannel 意外断开后，在成员仍在线的前提下重建连接（有重试上限）。 */
  private schedulePeerReconnect(clientId: string): void {
    const count = this.retries.get(clientId) ?? 0;
    if (count >= MAX_PEER_RETRIES) return;
    this.retries.set(clientId, count + 1);
    const timer = setTimeout(() => {
      this.retryTimers.delete(clientId);
      this.retries.delete(clientId);
      if (this.stopped || !this.peers.has(clientId) || this.channels.has(clientId)) return;
      this.setupPeer(clientId);
    }, PEER_RECONNECT_DELAY_MS);
    this.retryTimers.set(clientId, timer);
  }

  private setupPeer(clientId: string): void {
    if (this.pcs.has(clientId)) return;
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pcs.set(clientId, pc);
    const polite = this.clientId < clientId;

    if (!polite) {
      const dc = pc.createDataChannel('share', { ordered: true });
      this.bindChannel(clientId, dc);
    }

    pc.ondatachannel = (event) => this.bindChannel(clientId, event.channel);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendToAgent({ t: 'signal', toClient: clientId, data: { candidate: event.candidate.toJSON() } });
      }
    };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer.add(clientId);
        await pc.setLocalDescription();
        this.sendToAgent({ t: 'signal', toClient: clientId, data: { description: pc.localDescription?.toJSON() } });
      } catch (error) {
        console.error('[mesh] negotiation failed', error);
      } finally {
        this.makingOffer.delete(clientId);
      }
    };
  }

  private bindChannel(clientId: string, dc: RTCDataChannel): void {
    if (this.channels.has(clientId)) return;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFERED_LIMIT / 2;
    this.channels.set(clientId, dc);
    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.handleControl(clientId, event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this.handleChunk(event.data, clientId);
      }
    };
    dc.onopen = () => {
      report('info', 'peer.channel_open', { clientId });
      const peer = this.peers.get(clientId);
      if (peer && peer.state !== 'connected') {
        peer.state = 'connected';
        this.emitPeers();
      }
    };
    dc.onclose = () => {
      report('info', 'peer.channel_closed', { clientId });
      this.channels.delete(clientId);
      const pc = this.pcs.get(clientId);
      if (pc) pc.close();
      this.pcs.delete(clientId);
      this.makingOffer.delete(clientId);
      this.ignoringOffer.delete(clientId);
      const peer = this.peers.get(clientId);
      if (peer && peer.state === 'connected') {
        peer.state = 'connecting';
        this.emitPeers();
      }
      this.schedulePeerReconnect(clientId);
    };
  }

  private async handleSignal(clientId: string, data: SignalData): Promise<void> {
    if (!data) return;
    if (!this.peers.has(clientId)) return;
    let pc = this.pcs.get(clientId);
    if (!pc) {
      this.setupPeer(clientId);
      pc = this.pcs.get(clientId)!;
    }
    const polite = this.clientId < clientId;
    try {
      if (data.description) {
        const collision = data.description.type === 'offer' && (this.makingOffer.has(clientId) || pc.signalingState !== 'stable');
        this.ignoringOffer.set(clientId, !polite && collision);
        if (this.ignoringOffer.get(clientId)) return;
        if (collision) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(data.description),
          ]);
        } else {
          await pc.setRemoteDescription(data.description);
        }
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          this.sendToAgent({ t: 'signal', toClient: clientId, data: { description: pc.localDescription?.toJSON() } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (error) {
          if (!this.ignoringOffer.get(clientId)) throw error;
        }
      }
    } catch (error) {
      console.error('[mesh] signal handling failed', error);
      report('error', 'signal.failed', {
        clientId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleControl(clientId: string, raw: string): void {
    let frame: ControlFrame;
    try {
      frame = JSON.parse(raw) as ControlFrame;
    } catch {
      return;
    }
    const peer = this.peers.get(clientId);
    if (frame.k === 'meta') {
      if (this.seen.has(frame.id)) return;
      // 分片数必须与声明大小一致且在上限内，避免恶意/异常帧撑爆内存
      const expected = Math.max(1, Math.ceil(frame.size / CHUNK_SIZE));
      if (!Number.isInteger(frame.chunks) || frame.chunks < 1 || frame.chunks > expected || frame.chunks > MAX_CHUNKS) {
        return;
      }
      if (this.seen.size >= MAX_SEEN_IDS) this.seen.clear();
      this.seen.add(frame.id);
      const chunks = new Array<ArrayBuffer | undefined>(frame.chunks);
      this.incoming.set(frame.id, { meta: frame, chunks, received: 0, from: clientId });
      const textOnly = frame.type === 'text';
      const item: TimelineItem = {
        id: frame.id,
        type: frame.type,
        from: frame.from,
        fromNickname: frame.fromNickname || peer?.nickname || '未命名成员',
        timestamp: frame.ts,
        status: 'receiving',
        direction: 'in',
        text: frame.text,
        fileName: frame.fileName,
        mimeType: frame.mimeType,
        size: frame.size,
        progress: 0,
        delivered: 0,
        total: 0,
      };
      this.items.set(frame.id, item);
      this.updateItem(item);
      if (textOnly) {
        this.incoming.delete(frame.id);
        this.updateItem({ ...item, progress: 1, status: 'received' });
        this.sendControlTo(clientId, { k: 'ack', id: frame.id });
      }
      return;
    }
    if (frame.k === 'ack') {
      const item = this.items.get(frame.id);
      if (!item || item.direction !== 'out' || item.status === 'cancelled') return;
      if (item.delivered < item.total) {
        const delivered = item.delivered + 1;
        const status = delivered >= item.total ? 'sent' : item.status;
        this.updateItem({ ...item, delivered, status });
      }
      return;
    }
    if (frame.k === 'cancel') {
      const item = this.items.get(frame.id);
      if (item && item.direction === 'in' && item.status === 'receiving') {
        this.updateItem({ ...item, status: 'cancelled', progress: 0 });
      }
      this.incoming.delete(frame.id);
      return;
    }
    if (frame.k === 'nickname') {
      if (peer) {
        peer.nickname = String(frame.nickname);
        this.emitPeers();
      }
    }
  }

  private handleChunk(data: ArrayBuffer, fromClient?: string): void {
    const decoded = decodeChunk(data);
    if (!decoded) return;
    const incoming = this.incoming.get(decoded.id);
    if (!incoming) return;
    const index = decoded.index;
    if (!Number.isInteger(index) || index < 0 || index >= incoming.chunks.length) return;
    if (incoming.chunks[index]) return;
    incoming.chunks[index] = decoded.payload;
    incoming.received += 1;
    const item = this.items.get(decoded.id);
    if (!item) return;
    const progress = incoming.received / incoming.chunks.length;
    if (incoming.received < incoming.chunks.length) {
      this.updateItem({ ...item, progress });
      return;
    }
    const blob = new Blob(incoming.chunks as ArrayBuffer[], { type: incoming.meta.mimeType || 'application/octet-stream' });
    this.incoming.delete(decoded.id);
    this.updateItem({ ...item, progress: 1, status: 'received', url: URL.createObjectURL(blob) });
    if (fromClient) this.sendControlTo(fromClient, { k: 'ack', id: decoded.id });
  }

  private abortIncoming(fromClientId?: string): void {
    for (const [id, incoming] of this.incoming) {
      if (fromClientId && incoming.from !== fromClientId) continue;
      this.incoming.delete(id);
      const item = this.items.get(id);
      if (item && item.direction === 'in' && item.status === 'receiving') {
        this.updateItem({ ...item, status: 'cancelled', progress: 0 });
      }
    }
  }

  private broadcastControl(frame: ControlFrame): void {
    for (const dc of this.channels.values()) {
      if (dc.readyState === 'open') dc.send(JSON.stringify(frame));
    }
  }

  private sendControlTo(clientId: string, frame: ControlFrame): void {
    const dc = this.channels.get(clientId);
    if (dc?.readyState === 'open') dc.send(JSON.stringify(frame));
  }

  private sendToAgent(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== SOCKET_OPEN) return;
    // POST 上行没有连接态，必须自己带上 clientId 让服务器知道来源
    this.socket.send(JSON.stringify({ clientId: this.clientId, ...message }));
  }

  private updateItem(item: TimelineItem): void {
    this.items.set(item.id, item);
    this.events.onItem(item);
  }

  private emitPeers(): void {
    this.events.onPeers([...this.peers.values()]);
  }

  private emitSelf(connected?: boolean): void {
    this.events.onSelf({
      clientId: this.clientId,
      nickname: this.nickname,
      connected: connected ?? this.socket?.readyState === SOCKET_OPEN,
      replaced: this.replaced,
    });
  }
}
