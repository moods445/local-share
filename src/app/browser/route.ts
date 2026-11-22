import type { NextRequest } from 'next/server';
import { relayStore, type AgentMessage } from '@/lib/server/relay-store';
import { networkIdFromRequest } from '@/lib/server/network';
import { readLimitedBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const trustProxy = process.env.TRUST_PROXY === '1';
const encoder = new TextEncoder();
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ID_LENGTH = 64;

// 页面可能托管在别的地址、通过 ?agentUrl= 指向本服务，因此 /browser 必须支持跨源
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
} as const;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function cleanId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_ID_LENGTH) : '';
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: { ...CORS, ...NO_STORE } });
}

/**
 * 信令入口（Next.js 自带后端）：
 * - GET  /browser?clientId=...&nickname=...  建立 SSE 长连接，服务器把成员/信令事件推给本客户端
 * - POST /browser                              客户端上行 signal/nickname（带 clientId）
 */
export async function GET(request: NextRequest) {
  const clientId = cleanId(request.nextUrl.searchParams.get('clientId'));
  const nickname = request.nextUrl.searchParams.get('nickname') ?? '';
  if (!clientId) {
    return new Response('missing clientId', { status: 400, headers: { ...CORS, ...NO_STORE } });
  }
  const networkId = networkIdFromRequest(request.headers, trustProxy);

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let send: ((msg: AgentMessage) => void) | null = null;
  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sink: (msg: AgentMessage) => void = (msg) => {
        if (msg.t === 'replaced') {
          // 同一 clientId 被新连接接管：先把 replaced 推给旧页面，再关流并停掉心跳
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
          } catch {
            // 流已关闭
          }
          stopHeartbeat();
          try {
            controller.close();
          } catch {
            // 已关闭
          }
          return;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
        } catch {
          // 流已关闭
        }
      };
      send = sink;

      const result = relayStore.register(networkId, clientId, nickname, sink);
      sink(result.init);
      if (result.assigned) sink(result.assigned);
      relayStore.broadcast(networkId, result.online, clientId);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          // 流已关闭
        }
      }, 25_000);

      const cleanup = () => {
        stopHeartbeat();
        const offline = relayStore.remove(networkId, clientId, sink);
        if (offline) relayStore.broadcast(networkId, offline);
      };
      // 客户端断开（取消订阅）时清理成员身份
      request.signal.addEventListener('abort', cleanup, { once: true });
    },
    cancel() {
      // ReadableStream 被消费者取消时兜底清理；带 send 校验，幂等且不会误删同 clientId 的新连接
      stopHeartbeat();
      if (!send) return;
      const offline = relayStore.remove(networkId, clientId, send);
      if (offline) relayStore.broadcast(networkId, offline);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      ...CORS,
    },
  });
}

export async function POST(request: NextRequest) {
  const body = await readLimitedBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return new Response(null, { status: 413, headers: { ...CORS, ...NO_STORE } });
  }
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    msg = parsed as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 400, headers: { ...CORS, ...NO_STORE } });
  }

  const clientId = cleanId(msg.clientId);
  if (!clientId) {
    return new Response(null, { status: 400, headers: { ...CORS, ...NO_STORE } });
  }
  // POST 没有连接态，按注册时的网络组定位，避免客户端出口变化导致信令被静默丢弃
  const client = relayStore.find(clientId);
  if (!client) {
    return new Response(null, { status: 404, headers: { ...CORS, ...NO_STORE } });
  }

  if (msg.t === 'signal') {
    relayStore.relaySignal(clientId, cleanId(msg.toClient), msg.data);
  } else if (msg.t === 'nickname') {
    const result = relayStore.updateNickname(
      clientId,
      typeof msg.nickname === 'string' ? msg.nickname : '',
    );
    if (result?.broadcast) relayStore.broadcast(client.networkId, result.broadcast, clientId);
    if (result?.assigned) relayStore.sendToClient(clientId, result.assigned);
  }

  return new Response(null, { status: 204, headers: { ...CORS, ...NO_STORE } });
}
