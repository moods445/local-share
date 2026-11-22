import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { randomInt } from 'node:crypto';
import { logger as defaultLogger, type Logger } from './logger.js';

interface JsonMessage {
  t: string;
  [key: string]: unknown;
}

interface BrowserClient {
  ws: WebSocket;
  id: string;
  nickname: string;
  networkId: string;
}

interface ClientView {
  clientId: string;
  nickname: string;
}

export interface RelayOptions {
  /**
   * 是否在受信反向代理之后解析 X-Forwarded-For。
   * 直连部署保持 false，否则客户端可以伪造来源地址混入其他网络组。
   */
  trustProxy?: boolean;
  /** 注入日志器，默认使用全局 Pino 实例。 */
  logger?: Logger;
}

const MAX_NICKNAME = 40;

function cleanNickname(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_NICKNAME);
}

/** 5 位随机数字，不足补零，用于昵称重复时区分。 */
function randomSuffix(): string {
  return randomInt(0, 100_000).toString().padStart(5, '0');
}

/**
 * 同网成员昵称去重：昵称已被其他成员占用时，在昵称后追加 5 位随机数字。
 * 随机码也可能恰好撞名，重试直到组内唯一。
 */
function dedupeNickname(room: Map<string, BrowserClient>, exceptId: string, nickname: string): string {
  const taken = new Set(
    [...room.values()]
      .filter((client) => client.id !== exceptId)
      .map((client) => client.nickname),
  );
  if (!taken.has(nickname)) return nickname;
  let candidate = `${nickname}${randomSuffix()}`;
  while (taken.has(candidate)) candidate = `${nickname}${randomSuffix()}`;
  return candidate;
}

/** 去掉 IPv4-mapped IPv6 前缀（::ffff:1.2.3.4 → 1.2.3.4）。 */
function normalizeAddress(raw: string): string {
  return raw.replace(/^::ffff:/i, '');
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * 分组键，按服务器所处位置自动适配：
 * - 回环地址：全部同组（本机多标签页/本地调试）。
 * - 私网地址：服务器就在这个局域网里，来源是各设备自己的 IP，因此按 /24（IPv4）
 *   或 /64（IPv6 ULA/链路本地）归组，同一局域网的不同设备才会落在一起。
 * - 公网地址：服务器在公网/云上，来源是 NAT 之后的出口 IP，按完整地址归组，
 *   不同局域网自然隔开。
 */
function groupKey(ip: string): string {
  if (ip === '127.0.0.1' || ip === '::1') return 'loopback';
  if (ip.includes(':')) {
    const head = ip.split(':')[0].toLowerCase();
    if (/^f[cd]/.test(head)) return `lan:v6:${ip.split(':').slice(0, 4).join(':')}`;
    if (/^fe[89ab]/.test(head)) return 'lan:v6:link-local';
    return `wan:v6:${ip}`;
  }
  if (!isPrivateIpv4(ip)) return `wan:v4:${ip}`;
  return `lan:v4:${privateIpv4Block(ip)}`;
}

/** 按 RFC1918 自然边界归组：10/8、172.16/12、192.168/16，回环与链路本地各自成组。 */
function privateIpv4Block(ip: string): string {
  const [a, b] = ip.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 10) return '10';
  if (a === 172 && b >= 16 && b <= 31) return '172.16-31';
  if (a === 192 && b === 168) return '192.168';
  if (a === 169 && b === 254) return '169.254';
  return ip;
}

/**
 * 中心信令中继：只负责转发浏览器之间的 WebRTC 信令与成员上下线事件。
 * 服务器本身不是群成员，不持有消息、文件，也不代表任何设备加入群聊。
 *
 * 成员按网络分组隔离：服务器按来源地址归组（局域网内按网段，公网按完整出口
 * 地址），同组客户端才互相可见；跨组既不发送成员列表，也不转发信令。
 */
export class Relay {
  private browserWss = new WebSocketServer({ noServer: true });
  private rooms = new Map<string, Map<string, BrowserClient>>();
  private trustProxy: boolean;
  private logger: Logger;

  constructor(options: RelayOptions = {}) {
    this.trustProxy = options.trustProxy ?? false;
    this.logger = options.logger ?? defaultLogger;
  }

  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname === '/browser') {
      const networkId = this.networkIdOf(req);
      this.logger.info(
        { networkId, remote: req.socket.remoteAddress },
        'browser websocket upgrade',
      );
      this.browserWss.handleUpgrade(req, socket, head, (ws) => this.onBrowser(ws, networkId));
    }
    // 其余升级请求（如 Next 开发模式的 /_next/webpack-hmr）交给服务器上其他监听者处理
  }

  /** 服务端观察到的来源地址，作为同网分组依据。 */
  private networkIdOf(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    const raw =
      this.trustProxy && typeof forwarded === 'string' && forwarded.trim()
        ? forwarded.split(',')[0].trim()
        : (req.socket.remoteAddress ?? '');
    return groupKey(normalizeAddress(raw));
  }

  private roomOf(networkId: string): Map<string, BrowserClient> {
    let room = this.rooms.get(networkId);
    if (!room) {
      room = new Map();
      this.rooms.set(networkId, room);
    }
    return room;
  }

  private onBrowser(ws: WebSocket, networkId: string): void {
    let clientId = '';

    ws.on('message', (raw) => {
      let msg: JsonMessage;
      try {
        msg = JSON.parse(raw.toString()) as JsonMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'register' && typeof msg.clientId === 'string' && msg.clientId) {
        const room = this.roomOf(networkId);
        if (clientId && clientId !== msg.clientId) {
          const old = room.get(clientId);
          if (old?.ws === ws) room.delete(clientId);
        }
        clientId = msg.clientId;
        const previous = room.get(clientId);
        if (previous && previous.ws !== ws) {
          // 同一 clientId 被另一个连接占用（多标签页/页面复制）。
          // 关闭旧连接前先通知它被替换，避免旧页面无限重连互相踢下线。
          this.logger.warn(
            { clientId, networkId, nickname: previous.nickname },
            'duplicate clientId registered, replacing previous connection',
          );
          this.send(previous.ws, { t: 'replaced' });
          previous.ws.close(4001, 'replaced');
        }
        const requested = cleanNickname(msg.nickname) || '未命名成员';
        const nickname = dedupeNickname(room, clientId, requested);
        room.set(clientId, { ws, id: clientId, nickname, networkId });
        this.logger.info(
          { clientId, nickname, requested, networkId, roomSize: room.size },
          'client registered',
        );
        this.send(ws, { t: 'init', clients: this.clientViews(room, clientId) });
        if (nickname !== requested) this.send(ws, { t: 'nickname-assigned', nickname });
        this.broadcast(room, { t: 'client-online', clientId, nickname }, clientId);
        return;
      }

      const client = this.rooms.get(networkId)?.get(clientId);
      if (!client || client.ws !== ws) return;

      if (msg.t === 'signal' && typeof msg.toClient === 'string') {
        const room = this.rooms.get(networkId);
        const target = room?.get(msg.toClient);
        if (target && target.ws !== client.ws) {
          this.logger.debug({ from: clientId, to: msg.toClient }, 'relay signal');
          this.send(target.ws, { t: 'signal', fromClient: clientId, data: msg.data });
        } else {
          this.logger.debug({ from: clientId, to: msg.toClient }, 'signal target not found');
        }
        return;
      }

      if (msg.t === 'nickname') {
        const requested = cleanNickname(msg.nickname);
        if (!requested) return;
        const room = this.rooms.get(networkId);
        if (!room) return;
        const nickname = dedupeNickname(room, client.id, requested);
        client.nickname = nickname;
        this.logger.info({ clientId, nickname, requested }, 'client nickname updated');
        this.broadcast(room, { t: 'peer-nickname', clientId, nickname }, clientId);
        if (nickname !== requested) this.send(client.ws, { t: 'nickname-assigned', nickname });
      }
    });

    ws.on('close', () => {
      const room = this.rooms.get(networkId);
      if (!room) return;
      const client = room.get(clientId);
      if (!client || client.ws !== ws) return;
      room.delete(clientId);
      if (room.size === 0) this.rooms.delete(networkId);
      this.logger.info({ clientId, networkId, roomSize: room.size }, 'client disconnected');
      this.broadcast(room, { t: 'client-offline', clientId });
    });
    ws.on('error', (error) => {
      this.logger.warn({ err: error, clientId, networkId }, 'browser websocket error');
    });
  }

  private clientViews(room: Map<string, BrowserClient>, exceptId?: string): ClientView[] {
    return [...room.values()]
      .filter((client) => client.id !== exceptId)
      .map((client) => ({ clientId: client.id, nickname: client.nickname }));
  }

  private broadcast(room: Map<string, BrowserClient>, msg: JsonMessage, exceptId?: string): void {
    const payload = JSON.stringify(msg);
    for (const client of room.values()) {
      if (client.id === exceptId) continue;
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
    }
  }

  private send(ws: WebSocket, msg: JsonMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
