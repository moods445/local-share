'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ShareMesh,
  type PeerView,
  type SelfView,
  type TimelineItem,
} from '../lib/mesh';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function statusLabel(item: TimelineItem): { text: string; ok: boolean } {
  if (item.status === 'sending' || item.status === 'receiving') {
    return { text: `${item.status === 'sending' ? '发送中' : '接收中'} ${Math.round(item.progress * 100)}%`, ok: true };
  }
  if (item.status === 'sent') return { text: `已送达 ${item.delivered}/${item.total}`, ok: true };
  if (item.status === 'partial') return { text: `部分送达 ${item.delivered}/${item.total}`, ok: false };
  if (item.status === 'received') return { text: '已接收', ok: true };
  if (item.status === 'cancelled') return { text: '已取消', ok: false };
  return { text: '发送失败：暂无其他成员在线', ok: false };
}

function serverWebSocketUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('agentWs');
  if (explicit) return explicit;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/browser`;
}

function renderTextWithLinks(text: string) {
  return text.split(/(https?:\/\/[^\s<>"]+)/g).map((part, index) => {
    if (!/^https?:\/\//.test(part)) return part;
    const match = part.match(/^(https?:\/\/.+?)([，。！？、）】」』.,!?;:]+)$/);
    const url = match ? match[1] : part;
    const tail = match ? match[2] : '';
    return (
      <span key={index}>
        <a className="bubble-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
        {tail}
      </span>
    );
  });
}

function Avatar({ name }: { name: string }) {
  const text = name.trim();
  return <div className="avatar" aria-hidden="true">{text ? text.slice(0, 2) : '?'}</div>;
}

export default function Home() {
  const meshRef = useRef<ShareMesh | null>(null);
  const connectedRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bubbleListRef = useRef<HTMLDivElement>(null);
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const [self, setSelf] = useState<SelfView>({ clientId: '', nickname: '', connected: false });
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [nickname, setNickname] = useState('');
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectFailed, setConnectFailed] = useState(false);

  useEffect(() => {
    const mesh = new ShareMesh(serverWebSocketUrl(), {
      onItem: (item) => {
        if (item.url) objectUrlsRef.current.add(item.url);
        setItems((prev) => {
          const index = prev.findIndex((entry) => entry.id === item.id);
          if (index < 0) return [...prev, item];
          const next = [...prev];
          next[index] = item;
          return next;
        });
      },
      onPeers: setPeers,
      onSelf: (value) => {
        setSelf(value);
        connectedRef.current = value.connected;
        if (value.nickname) setNickname(value.nickname);
        if (value.connected) setConnectFailed(false);
      },
    });
    meshRef.current = mesh;
    mesh.start();
    const timer = setTimeout(() => {
      if (!meshRef.current) return;
      if (!connectedRef.current) setConnectFailed(true);
    }, 5000);
    return () => {
      clearTimeout(timer);
      mesh.stop();
      for (const url of objectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      objectUrlsRef.current.clear();
    };
  }, []);

  const sortedItems = useMemo(() => [...items].sort((a, b) => a.timestamp - b.timestamp), [items]);

  useEffect(() => {
    const list = bubbleListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [sortedItems.length]);

  function saveNickname() {
    const value = nickname.trim();
    if (!value) return;
    meshRef.current?.setNickname(value.slice(0, 40));
  }

  function sendText() {
    const value = text.trim();
    if (!value) return;
    if (value.length > 2000) {
      setError('文字不能超过 2000 字');
      return;
    }
    meshRef.current?.sendText(value);
    setText('');
    setError('');
  }

  function sendFiles(files: FileList | File[]) {
    const list = Array.from(files);
    for (const file of list) {
      try {
        meshRef.current?.sendFile(file);
      } catch {
        setError(`${file.name} 超过大小限制（图片 20MB / 文件 100MB）`);
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  const memberCount = peers.length + 1;
  const myName = self.nickname || '我';

  return (
    <main className="chat">
      <header className="chat-header">
        <button
          className="icon-btn menu-btn"
          type="button"
          aria-label="会话详情"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          ☰
        </button>
        <div className="chat-title">
          <h1>局域网共享群</h1>
          <p>
            <span className={`dot ${self.connected ? 'on' : ''}`} />
            {self.connected
              ? `${memberCount} 位成员在线 · 实时共享`
              : connectFailed
                ? '连接失败：请确认访问的是群服务器地址'
                : '正在连接群服务器…'}
          </p>
        </div>
        <button
          className="icon-btn"
          type="button"
          aria-label="会话详情"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          ⋯
        </button>
      </header>

      {error ? <div className="error" role="alert">{error}</div> : null}

      <div className="chat-body">
        <div className="bubble-list" ref={bubbleListRef}>
          <div className="chat-intro">
            <div className="chat-intro-icon">⇄</div>
            <h2>局域网共享群</h2>
            <p>同一局域网的设备打开这个页面就自动进群。每个浏览器都是独立成员，文字、图片、文件在成员之间直连传输，不经过服务器。</p>
          </div>

          {sortedItems.map((item) => {
            const status = statusLabel(item);
            const busy = item.status === 'sending' || item.status === 'receiving';
            const mine = item.direction === 'out';
            return (
              <div key={item.id} className={`bubble-row ${mine ? 'mine' : ''}`}>
                {!mine ? <Avatar name={item.fromNickname || '成员'} /> : null}
                <div className="bubble-wrap">
                  {!mine ? <div className="sender">{item.fromNickname || '成员'}</div> : null}
                  <div className={`bubble ${busy ? 'busy' : ''}`}>
                    {item.type === 'text' ? (
                      <div className="bubble-text">{renderTextWithLinks(item.text || '')}</div>
                    ) : item.type === 'image' && item.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="bubble-image" src={item.url} alt={item.fileName || '分享的图片'} />
                    ) : (
                      <div className="file-card">
                        <div className="file-icon">📄</div>
                        <div className="file-info">
                          <div className="file-name">{item.fileName || '未命名文件'}</div>
                          <div className="file-size">{formatSize(item.size)}</div>
                        </div>
                      </div>
                    )}
                    {busy ? (
                      <div className="progress"><i style={{ width: `${Math.min(100, item.progress * 100)}%` }} /></div>
                    ) : null}
                    <div className="bubble-foot">
                      <span className={`status-text ${status.ok ? 'ok' : 'bad'}`}>{status.text}</span>
                      <time>{formatTime(item.timestamp)}</time>
                    </div>
                    {item.url ? (
                      <a
                        className="bubble-download"
                        href={item.url}
                        download={item.fileName || (item.type === 'image' ? 'image' : 'download')}
                      >
                        {item.type === 'image' ? '下载原图' : '下载文件'}
                      </a>
                    ) : null}
                    {mine && busy ? (
                      <button className="bubble-cancel" type="button" onClick={() => meshRef.current?.cancel(item.id)}>
                        取消发送
                      </button>
                    ) : null}
                  </div>
                </div>
                {mine ? <Avatar name={myName} /> : null}
              </div>
            );
          })}
        </div>
      </div>

      <footer className="composer">
        <div className="composer-toolbar">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => event.target.files && sendFiles(event.target.files)}
          />
          <button className="tool-btn" type="button" aria-label="发送图片或文件" onClick={() => fileRef.current?.click()}>
            ＋
          </button>
          <textarea
            className="composer-input"
            value={text}
            rows={1}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendText();
              }
            }}
            placeholder="发消息给群里所有人…"
          />
          <button className="send-btn" type="button" onClick={sendText} disabled={!text.trim()}>发送</button>
        </div>
        <div
          className={`dropzone ${dragging ? 'over' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer.files.length) sendFiles(event.dataTransfer.files);
          }}
        >
          拖入图片或文件即可发送
        </div>
      </footer>

      {settingsOpen ? (
        <div className="drawer-backdrop" onClick={() => setSettingsOpen(false)}>
          <aside className="drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-head">
              <h2>会话详情</h2>
              <button className="icon-btn" type="button" aria-label="关闭" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>

            <div className="drawer-section">
              <p className="drawer-title">我的昵称</p>
              <div className="self-row">
                <input
                  className="nickname-input"
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  placeholder="例如：客厅的手机"
                  maxLength={40}
                  onKeyDown={(event) => { if (event.key === 'Enter') saveNickname(); }}
                />
                <button className="btn primary" type="button" onClick={saveNickname}>保存</button>
              </div>
              <p className="hint">昵称只保存在当前浏览器，不影响其他成员。</p>
            </div>

            <div className="drawer-section">
              <p className="drawer-title">群成员 · {memberCount}</p>
              <div className="member-list">
                <div className="peer">
                  <Avatar name={myName} />
                  <div className="peer-name">
                    <strong>{myName}</strong>
                    <small>我 · 本机浏览器</small>
                  </div>
                </div>
                {peers.map((peer) => (
                  <div className="peer" key={peer.clientId}>
                    <Avatar name={peer.nickname} />
                    <div className="peer-name">
                      <strong>{peer.nickname}</strong>
                      <small className={peer.state === 'connected' ? 'peer-state ok' : 'peer-state'}>
                        {peer.state === 'connected' ? '已连接 · 可直连' : '连接中…'}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="drawer-section">
              <p className="drawer-title">如何加入</p>
              <p className="hint">
                在局域网一台设备上运行群聊服务器，其他设备浏览器打开同一个页面地址即可自动进群。
                服务器只转发信令，消息与文件在浏览器之间直连传输。
                如需连接其他服务器，可在地址后加 <code>?agentWs=ws://服务器地址:端口/browser</code>。
              </p>
            </div>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
