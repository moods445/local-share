import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';

interface JsonMessage {
  t: string;
  [key: string]: unknown;
}

interface BrowserClient {
  ws: WebSocket;
  id: string;
  nickname: string;
}

interface ClientView {
  clientId: string;
  nickname: string;
}

const MAX_NICKNAME = 40;

function cleanNickname(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_NICKNAME);
}

/**
 * 中心信令中继：只负责转发浏览器之间的 WebRTC 信令与成员上下线事件。
 * 服务器本身不是群成员，不持有消息、文件，也不代表任何设备加入群聊。
 */
export class Relay {
  private browserWss = new WebSocketServer({ noServer: true });
  private browsers = new Map<string, BrowserClient>();

  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/browser') {
      this.browserWss.handleUpgrade(req, socket, head, (ws) => this.onBrowser(ws));
    } else {
      socket.destroy();
    }
  }

  private onBrowser(ws: WebSocket): void {
    let clientId = '';

    ws.on('message', (raw) => {
      let msg: JsonMessage;
      try {
        msg = JSON.parse(raw.toString()) as JsonMessage;
      } catch {
        return;
      }

      if (msg.t === 'register' && typeof msg.clientId === 'string' && msg.clientId) {
        clientId = msg.clientId;
        const previous = this.browsers.get(clientId);
        if (previous && previous.ws !== ws) previous.ws.close();
        const nickname = cleanNickname(msg.nickname) || '未命名成员';
        this.browsers.set(clientId, { ws, id: clientId, nickname });
        this.send(ws, { t: 'init', clients: this.clientViews(clientId) });
        this.broadcast({ t: 'client-online', clientId, nickname }, clientId);
        return;
      }

      if (!clientId || this.browsers.get(clientId)?.ws !== ws) return;

      if (msg.t === 'signal' && typeof msg.toClient === 'string') {
        const target = this.browsers.get(msg.toClient);
        if (target) this.send(target.ws, { t: 'signal', fromClient: clientId, data: msg.data });
        return;
      }

      if (msg.t === 'nickname') {
        const nickname = cleanNickname(msg.nickname);
        if (!nickname) return;
        const client = this.browsers.get(clientId);
        if (!client) return;
        client.nickname = nickname;
        this.broadcast({ t: 'peer-nickname', clientId, nickname }, clientId);
      }
    });

    ws.on('close', () => {
      if (!clientId || this.browsers.get(clientId)?.ws !== ws) return;
      this.browsers.delete(clientId);
      this.broadcast({ t: 'client-offline', clientId });
    });
    ws.on('error', () => undefined);
  }

  private clientViews(exceptId?: string): ClientView[] {
    return [...this.browsers.values()]
      .filter((client) => client.id !== exceptId)
      .map((client) => ({ clientId: client.id, nickname: client.nickname }));
  }

  private broadcast(msg: JsonMessage, exceptId?: string): void {
    const payload = JSON.stringify(msg);
    for (const client of this.browsers.values()) {
      if (client.id === exceptId) continue;
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
    }
  }

  private send(ws: WebSocket, msg: JsonMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
