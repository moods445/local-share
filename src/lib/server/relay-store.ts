/**
 * 中心信令中继的状态存储：只负责成员登记、昵称去重、按网络组隔离与消息转发。
 * 与具体运行时无关——Node 进程内用一个单例即可，后续 Cloudflare 部署可换成
 * Durable Object 实现同一套接口。
 *
 * 成员同时按两个维度索引：
 * - rooms: networkId → clientId → 连接（用于同组广播与隔离）
 * - clients: clientId → 连接（用于 POST 上行时定位注册时的网络组，避免出口变化丢信令）
 */

export interface AgentMessage {
  t: string;
  [key: string]: unknown;
}

export type SendMessage = (msg: AgentMessage) => void;

export interface ClientView {
  clientId: string;
  nickname: string;
}

/** 已注册连接的可读视图（不含发送回调）。 */
export interface ClientRecord {
  clientId: string;
  nickname: string;
  networkId: string;
}

interface ClientEntry {
  clientId: string;
  nickname: string;
  networkId: string;
  send: SendMessage;
}

export interface RegisterResult {
  init: AgentMessage;
  assigned?: AgentMessage;
  online: AgentMessage;
  /** 同一 clientId 已有旧连接，旧连接会收到 replaced */
  replaced: boolean;
}

export interface NicknameUpdate {
  broadcast?: AgentMessage;
  assigned?: AgentMessage;
}

const MAX_NICKNAME = 40;
const MAX_CLIENT_ID = 64;

function cleanClientId(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_CLIENT_ID);
}

function cleanNickname(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_NICKNAME);
}

/** 5 位随机数字，不足补零，用于昵称重复时区分。 */
function randomSuffix(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.getRandomValues === 'function') {
    const n = c.getRandomValues(new Uint32Array(1))[0] % 100_000;
    return n.toString().padStart(5, '0');
  }
  return Math.floor(Math.random() * 100_000).toString().padStart(5, '0');
}

/** 同网成员昵称去重：昵称已被其他成员占用时，在昵称后追加 5 位随机数字。 */
function dedupeNickname(room: Map<string, ClientEntry>, exceptId: string, nickname: string): string {
  const taken = new Set(
    [...room.values()]
      .filter((client) => client.clientId !== exceptId)
      .map((client) => client.nickname),
  );
  if (!taken.has(nickname)) return nickname;
  let candidate = `${nickname}${randomSuffix()}`;
  while (taken.has(candidate)) candidate = `${nickname}${randomSuffix()}`;
  return candidate;
}

export class RelayStore {
  private rooms = new Map<string, Map<string, ClientEntry>>();
  private clients = new Map<string, ClientEntry>();

  /** 登记一个客户端，返回要发给它的 init/昵称分配消息，以及给同组的上线广播。 */
  register(networkId: string, clientId: string, nickname: string, send: SendMessage): RegisterResult {
    const id = cleanClientId(clientId);
    const room = this.roomOf(networkId);
    const previous = room.get(id);
    const replaced = Boolean(previous && previous.send !== send);
    if (replaced && previous) previous.send({ t: 'replaced' });

    const requested = cleanNickname(nickname) || '未命名成员';
    const finalName = dedupeNickname(room, id, requested);
    const entry: ClientEntry = { clientId: id, nickname: finalName, networkId, send };
    room.set(id, entry);
    this.clients.set(id, entry);

    return {
      replaced,
      init: { t: 'init', clients: this.clientViews(room, id) },
      assigned: finalName !== requested ? { t: 'nickname-assigned', nickname: finalName } : undefined,
      online: { t: 'client-online', clientId: id, nickname: finalName },
    };
  }

  /** 移除客户端，返回给同组的离线广播；不存在时返回 null。 */
  remove(networkId: string, clientId: string, send?: SendMessage): AgentMessage | null {
    const room = this.rooms.get(networkId);
    if (!room) return null;
    const client = room.get(clientId);
    if (!client) return null;
    if (send && client.send !== send) return null;
    room.delete(clientId);
    if (room.size === 0) this.rooms.delete(networkId);
    // 仅在全局索引仍指向本连接时删除，避免旧连接清理误删同 clientId 的新连接
    if (this.clients.get(clientId) === client) this.clients.delete(clientId);
    return { t: 'client-offline', clientId };
  }

  /** 按 clientId 找到注册连接（含注册时的网络组）。 */
  find(clientId: string): ClientRecord | undefined {
    return this.clients.get(clientId);
  }

  sendToClient(clientId: string, msg: AgentMessage): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    client.send(msg);
    return true;
  }

  broadcast(networkId: string, msg: AgentMessage, exceptId?: string): void {
    const room = this.rooms.get(networkId);
    if (!room) return;
    for (const client of room.values()) {
      if (client.clientId === exceptId) continue;
      client.send(msg);
    }
  }

  /** 只把信令转发给发送者所在组的目标客户端；发送者未注册或目标不在同组时返回 false。 */
  relaySignal(fromClientId: string, toClientId: string, data: unknown): boolean {
    const from = this.clients.get(fromClientId);
    if (!from) return false;
    const room = this.rooms.get(from.networkId);
    const target = room?.get(toClientId);
    if (!target || target.clientId === from.clientId) return false;
    target.send({ t: 'signal', fromClient: fromClientId, data });
    return true;
  }

  /** 未注册返回 null；昵称为空返回空对象。 */
  updateNickname(clientId: string, nickname: string): NicknameUpdate | null {
    const client = this.clients.get(clientId);
    if (!client) return null;
    const room = this.rooms.get(client.networkId);
    if (!room) return null;
    const requested = cleanNickname(nickname);
    if (!requested) return {};
    const finalName = dedupeNickname(room, clientId, requested);
    client.nickname = finalName;
    return {
      broadcast: { t: 'peer-nickname', clientId, nickname: finalName },
      assigned: finalName !== requested ? { t: 'nickname-assigned', nickname: finalName } : undefined,
    };
  }

  roomSize(networkId: string): number {
    return this.rooms.get(networkId)?.size ?? 0;
  }

  clear(): void {
    this.rooms.clear();
    this.clients.clear();
  }

  private roomOf(networkId: string): Map<string, ClientEntry> {
    let room = this.rooms.get(networkId);
    if (!room) {
      room = new Map();
      this.rooms.set(networkId, room);
    }
    return room;
  }

  private clientViews(room: Map<string, ClientEntry>, exceptId?: string): ClientView[] {
    return [...room.values()]
      .filter((client) => client.clientId !== exceptId)
      .map((client) => ({ clientId: client.clientId, nickname: client.nickname }));
  }
}

/** 开发模式下 Next 热更新会重置模块状态，挂到 globalThis 上保持单例。 */
const globalForRelay = globalThis as unknown as { __localShareRelay?: RelayStore };

export const relayStore: RelayStore = globalForRelay.__localShareRelay ?? new RelayStore();
if (!globalForRelay.__localShareRelay) globalForRelay.__localShareRelay = relayStore;
