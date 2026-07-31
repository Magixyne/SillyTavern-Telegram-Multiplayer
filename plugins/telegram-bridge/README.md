# Telegram Bridge 内置 Server 插件

把本目录（`telegram-bridge`）放到 SillyTavern 的 `plugins/` 目录下，酒馆启动时就会自动运行 Telegram Bot + WebSocket Bridge。

**零额外依赖**：只使用酒馆自带的 `express` / `ws` 和 Node 原生 `https`，无需 npm install。

## 安装

1. 将本目录复制到酒馆 `plugins/` 目录下（与酒馆主程序同级的 `plugins/`，而非 `data/` 内的）：
   ```
   SillyTavern/
   ├── plugins/
   │   └── telegram-bridge/     ← 放这里（整个目录）
   ├── public/
   ├── server.js
   └── config.yaml
   ```
2. 编辑酒馆 `config.yaml`，确认 `enableServerPlugins: true`
3. 重启酒馆

## 配置 Token

三种方式（优先级从高到低）：

1. **扩展设置面板**（推荐）：酒馆 → Extensions → Telegram Connector → 内置 Server 区块 → 填 Token → 保存 → 启动
2. 环境变量：`TELEGRAM_BOT_TOKEN=123456:ABC...`
3. 本目录 `config.json`：`{ "telegramToken": "123456:ABC..." }`（保存 Token 时自动生成）

> ⚠️ `config.json` 含 Token，已加入 .gitignore，请勿提交到仓库。

## 端口

自动选取空闲端口（首选 2333，被占用则自动递增）。前端扩展通过
`GET /api/plugins/telegram-bridge/status` 自动发现端口并连接，Bridge URL 留空即可。

## 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/plugins/telegram-bridge/status` | 运行状态、端口、Bot 连接状态 |
| POST | `/api/plugins/telegram-bridge/config` | 保存 Token `{ "telegramToken": "..." }` |
| POST | `/api/plugins/telegram-bridge/start` | 启动/重启 Bridge |
| POST | `/api/plugins/telegram-bridge/stop` | 停止 Bridge |

## 与独立 server/ 模式的区别

| | 内置插件（本目录） | 独立 server/ |
|---|---|---|
| 部署 | 放进酒馆 plugins/ 即可 | 单独克隆 + npm install + node server.js |
| 启动 | 随酒馆自动启动 | 手动启动 |
| 依赖 | 零额外依赖（原生 https 实现 TG API） | node-telegram-bot-api |
| 端口 | 自动选空闲端口 | 固定 2333（可配） |
| 适用 | 酒馆与 Bot 同机部署 | 需要独立进程/远程部署/Docker |
