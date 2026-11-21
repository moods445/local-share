# local-share 局域网群聊

同一局域网内，设备打开网页即进入同一个群聊，共享文字、图片和文件。

## 运行

在局域网的一台设备上启动服务：

```bash
npm install
npm run build
npm start
```

其他设备用浏览器访问 `http://<这台设备的局域网IP>:3000`，打开即自动进群。

- 每个浏览器客户端都是群里的**独立成员**，昵称保存在各自浏览器中，互不影响。
- 服务器只负责托管页面和转发 WebRTC 信令，**不保存也不中转任何消息或文件**；内容在成员之间直连传输。
- 服务器按来源地址自动分组：局域网内按 RFC1918 私网块边界（10/8、172.16/12、192.168/16），公网部署按完整出口 IP；跨组默认互相不可见、信令也不转发。反代部署可设 `TRUST_PROXY=1` 读取 `X-Forwarded-For`。
- 如果页面从其他地址打开（例如 Cloudflare Pages），可在网址后加参数指定信令服务器：
  `?agentWs=ws://<服务器IP>:3000/browser`

## 开发

```bash
npm run dev
```

先构建前端，再启动唯一的群聊服务器（默认 3000 端口，同时托管页面与信令）。类型检查、测试与构建：

```bash
npm run typecheck
npm test
npm run build
```

## 结构

单一包、单一服务器，没有 workspace 子包：

- `src/app/` 前端页面
- `src/lib/` 群聊共享逻辑（成员、信令、传输）
- `src/server/` 唯一的 Node 服务器（托管页面 + WebSocket 信令）
- `out/` 前端静态产物，`dist/` 服务端编译产物

## 技术

Next.js 静态导出 + Node.js WebSocket 信令中继 + WebRTC DataChannel 点对点传输。
