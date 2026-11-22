import { describe, it, expect, beforeEach } from 'vitest';
import { RelayStore, type AgentMessage, type SendMessage } from './relay-store';

const NET_A = 'wan:v4:203.0.113.7';
const NET_B = 'wan:v4:198.51.100.3';

interface FakeClient {
  id: string;
  messages: AgentMessage[];
  send: SendMessage;
}

describe('RelayStore', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore();
  });

  /** 登记一个客户端：把 init/assigned 发给本人，online 广播给同组其他成员。 */
  function register(networkId: string, id: string, nickname: string): FakeClient {
    const client: FakeClient = {
      id,
      messages: [],
      send: (msg) => client.messages.push(msg),
    };
    const result = store.register(networkId, id, nickname, client.send);
    client.messages.push(result.init);
    if (result.assigned) client.messages.push(result.assigned);
    store.broadcast(networkId, result.online, id);
    return client;
  }

  function last(client: FakeClient, t: string): AgentMessage {
    return client.messages.filter((m) => m.t === t).at(-1)!;
  }

  it('注册后返回现有成员并广播上线', () => {
    const a = register(NET_A, 'A', '甲');
    expect(a.messages).toEqual([{ t: 'init', clients: [] }]);

    const b = register(NET_A, 'B', '乙');
    expect(last(b, 'init')).toEqual({ t: 'init', clients: [{ clientId: 'A', nickname: '甲' }] });
    expect(last(a, 'client-online')).toEqual({ t: 'client-online', clientId: 'B', nickname: '乙' });
  });

  it('按 toClient 转发信令并标注 fromClient', () => {
    const a = register(NET_A, 'A', '甲');
    const b = register(NET_A, 'B', '乙');

    expect(store.relaySignal('B', 'A', { description: { type: 'offer' } })).toBe(true);
    expect(last(a, 'signal')).toEqual({
      t: 'signal',
      fromClient: 'B',
      data: { description: { type: 'offer' } },
    });
    expect(b.messages.some((m) => m.t === 'signal')).toBe(false);
  });

  it('信令只发给目标客户端', () => {
    const a = register(NET_A, 'A', '甲');
    register(NET_A, 'B', '乙');
    const c = register(NET_A, 'C', '丙');

    store.relaySignal('B', 'A', { candidate: { candidate: 'x' } });
    expect(a.messages.some((m) => m.t === 'signal')).toBe(true);
    expect(c.messages.some((m) => m.t === 'signal')).toBe(false);
  });

  it('不会把信令发回发送者自己', () => {
    const a = register(NET_A, 'A', '甲');
    expect(store.relaySignal('A', 'A', {})).toBe(false);
    expect(a.messages.some((m) => m.t === 'signal')).toBe(false);
  });

  it('未注册的发送者转发失败', () => {
    register(NET_A, 'A', '甲');
    expect(store.relaySignal('ghost', 'A', {})).toBe(false);
  });

  it('昵称变更广播给其他成员', () => {
    const a = register(NET_A, 'A', '甲');
    const b = register(NET_A, 'B', '乙');

    const result = store.updateNickname('B', '乙2');
    expect(result?.broadcast).toEqual({ t: 'peer-nickname', clientId: 'B', nickname: '乙2' });
    store.broadcast(NET_A, result!.broadcast!, 'B');
    expect(last(a, 'peer-nickname')).toEqual({ t: 'peer-nickname', clientId: 'B', nickname: '乙2' });
    expect(b.messages.some((m) => m.t === 'peer-nickname')).toBe(false);
  });

  it('未注册客户端改昵称返回 null', () => {
    expect(store.updateNickname('ghost', 'x')).toBeNull();
  });

  it('同网昵称重复时追加 5 位随机码', () => {
    const a = register(NET_A, 'A', '甲');
    const b = register(NET_A, 'B', '甲');

    const online = last(a, 'client-online');
    expect(online.nickname).toMatch(/^甲\d{5}$/);
    expect(last(b, 'nickname-assigned')).toEqual({ t: 'nickname-assigned', nickname: online.nickname });
  });

  it('多个成员重名时随机码互不相同', () => {
    register(NET_A, 'A', '甲');
    const b = register(NET_A, 'B', '甲');
    const c = register(NET_A, 'C', '甲');

    const bName = String(last(b, 'nickname-assigned').nickname);
    const cName = String(last(c, 'nickname-assigned').nickname);
    expect(bName).toMatch(/^甲\d{5}$/);
    expect(cName).toMatch(/^甲\d{5}$/);
    expect(bName).not.toBe(cName);
  });

  it('昵称改成与他人重复时同样追加随机码', () => {
    const a = register(NET_A, 'A', '甲');
    const b = register(NET_A, 'B', '乙');

    const result = store.updateNickname('B', '甲');
    expect(result?.broadcast).toEqual({
      t: 'peer-nickname',
      clientId: 'B',
      nickname: expect.stringMatching(/^甲\d{5}$/),
    });
    store.broadcast(NET_A, result!.broadcast!, 'B');
    expect(last(a, 'peer-nickname').nickname).toMatch(/^甲\d{5}$/);
  });

  it('昵称不重复时不发送分配消息', () => {
    const a = register(NET_A, 'A', '甲');
    expect(a.messages.some((m) => m.t === 'nickname-assigned')).toBe(false);
  });

  it('断开连接后广播离线', () => {
    const a = register(NET_A, 'A', '甲');
    const b = register(NET_A, 'B', '乙');

    const offline = store.remove(NET_A, 'B');
    expect(offline).toEqual({ t: 'client-offline', clientId: 'B' });
    store.broadcast(NET_A, offline!);
    expect(last(a, 'client-offline')).toEqual({ t: 'client-offline', clientId: 'B' });
  });

  it('重复 clientId 时通知旧连接被替换', () => {
    const first = register(NET_A, 'A', '甲');
    const second = register(NET_A, 'A', '甲');

    expect(last(first, 'replaced')).toEqual({ t: 'replaced' });
    expect(last(second, 'init')).toEqual({ t: 'init', clients: [] });

    // 旧连接清理不得误删同 clientId 的新连接
    expect(store.remove(NET_A, 'A', first.send)).toBeNull();
    expect(store.roomSize(NET_A)).toBe(1);
  });

  it('不同网络互不可见，跨网信令被丢弃', () => {
    const a = register(NET_A, 'A', '甲');
    const b = register(NET_B, 'B', '乙');

    expect(last(b, 'init')).toEqual({ t: 'init', clients: [] });
    expect(store.relaySignal('B', 'A', {})).toBe(false);
    expect(store.relaySignal('A', 'B', {})).toBe(false);
    expect(a.messages.some((m) => m.t === 'client-online')).toBe(false);
    expect(b.messages.some((m) => m.t === 'client-online')).toBe(false);
  });

  it('昵称去重只在同一网络组内进行', () => {
    register(NET_A, 'A', '甲');
    const b = register(NET_B, 'B', '甲');
    expect(b.messages.some((m) => m.t === 'nickname-assigned')).toBe(false);
  });

  it('POST 用注册时的网络组：客户端出口变化后信令仍可达', () => {
    const a = register(NET_A, 'A', '甲');
    const b = register(NET_A, 'B', '乙');
    // B 的客户端换了一个出口，但注册时属于 NET_A
    expect(store.find('B')?.networkId).toBe(NET_A);
    expect(store.relaySignal('B', 'A', { description: { type: 'answer' } })).toBe(true);
    expect(last(a, 'signal').data).toEqual({ description: { type: 'answer' } });
  });

  it('clientId 超长会被截断到 64', () => {
    const long = 'x'.repeat(200);
    const client = register(NET_A, long, '甲');
    expect(client.id).toBe(long);
    expect(store.find(long.slice(0, 64))?.nickname).toBe('甲');
    expect(store.find(long)).toBeUndefined();
  });
});
