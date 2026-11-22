# local-share 局域网群聊

同一局域网内，设备打开网页即进入同一个群聊，共享文字、图片和文件。

## 运行

在局域网的一台设备上启动服务：

```bash
pnpm install
pnpm build
pnpm start
```

其他设备用浏览器访问 `http://<这台设备的局域网IP>:3000`，打开即自动进群。

- 每个浏览器客户端都是群里的**独立成员**，昵称保存在各自浏览器中，互不影响。
- 同一网络组内昵称重复时，服务器自动在昵称后追加 5 位随机码，保证成员列表不重名。
- 服务器只负责托管页面和转发 WebRTC 信令，**不保存也不中转任何消息或文件**；内容在成员之间直连传输。
- 后端就是 Next.js 自带的 Route Handler：`GET /browser` 用 SSE 把成员/信令事件推给浏览器，`POST /browser` 上行控制消息，`POST /log` 接收前端埋点。不再需要自定义 Node 服务器。
- 服务器按来源地址自动分组：Cloudflare 部署取 `CF-Connecting-IP`；反代部署可设 `TRUST_PROXY=1` 读取 `X-Forwarded-For`；直连部署拿不到来源地址时全部并入同一组（局域网场景即同组）。
- 服务端用 Pino 输出 JSON 日志，`LOG_LEVEL=debug` 可调整级别；前端连接事件（`mesh.start`、`ws.open`、`ws.close`、`ws.reconnect` 等）通过 `POST /log` 上报，以 `source: "browser"` 合并进同一份日志。线上构建可设 `NEXT_PUBLIC_TELEMETRY_ENABLED=0` 关闭前端上报，或服务端设 `TELEMETRY_ENABLED=0` 直接丢弃。
- 如果页面不是由这台服务器直接提供（例如放在别的地址或用反代），可在网址后加参数指定信令服务器：
  `?agentUrl=/browser` 或完整 HTTP 地址。

## 开发

```bash
pnpm dev
```

以开发模式启动同一个 Next.js 服务（默认 3000 端口，页面与信令同进程，改代码自动热重载）。开发与生产使用不同构建目录（`.next-dev/` 与 `.next/`），互不覆盖。类型检查、测试与构建：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 结构

- `src/app/` 前端页面与 Route Handler（`app/browser/route.ts`、`app/log/route.ts`）
- `src/lib/` 群聊共享逻辑（成员、信令、传输）
- `src/lib/server/` 服务端信令中继、同网分组与埋点处理

## 技术

Next.js（App Router + Route Handler，SSE + POST 信令）+ WebRTC DataChannel 点对点传输。页面与信令同一个进程、同一个端口。
