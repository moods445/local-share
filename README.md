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
- 同一网络组内昵称重复时，服务器自动在昵称后追加 5 位随机码，保证成员列表不重名。
- 服务器只负责托管页面和转发 WebRTC 信令，**不保存也不中转任何消息或文件**；内容在成员之间直连传输。
- 服务器按来源地址自动分组：局域网内按 RFC1918 私网块边界（10/8、172.16/12、192.168/16），公网部署按完整出口 IP；跨组默认互相不可见、信令也不转发。反代部署可设 `TRUST_PROXY=1` 读取 `X-Forwarded-For`。
- 服务端用 Pino 输出 JSON 日志，`LOG_LEVEL=debug` 可调整级别；前端连接事件（`mesh.start`、`ws.open`、`ws.close`、`ws.reconnect` 等）通过 `POST /log` 上报，以 `source: "browser"` 合并进同一份日志。
- 如果页面不是由这台服务器直接提供（例如放在别的地址或用反代），可在网址后加参数指定信令服务器：
  `?agentWs=ws://<服务器IP>:3000/browser`

## 开发

```bash
npm run dev
```

以开发模式启动同一个 Next.js 服务（默认 3000 端口，页面与信令同进程，改代码自动热重载）。开发与生产使用不同构建目录（`.next-dev/` 与 `.next/`），互不覆盖。类型检查、测试与构建：

```bash
npm run typecheck
npm test
npm run build
```

## 结构

单一包、单一服务器，没有 workspace 子包：

- `src/app/` 前端页面
- `src/lib/` 群聊共享逻辑（成员、信令、传输）
- `src/server/` 自定义 Next.js 服务器（一个进程同时提供页面 + WebSocket 信令）
- `.next/` 前端构建产物，`dist/` 服务端编译产物

## 技术

Next.js（自定义 Node 服务器）+ WebSocket 信令中继 + WebRTC DataChannel 点对点传输。页面与信令同一个进程、同一个端口。
