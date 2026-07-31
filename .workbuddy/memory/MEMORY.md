# SillyTavern-Telegram-Multiplayer — 项目笔记

## 项目概述
SillyTavern 第三方扩展，通过 WebSocket 桥接 Telegram Bot 与 SillyTavern，支持多人在 Telegram 群组中进行 AI 角色扮演。

## 关键架构
- **SillyTavern 端**（index.js）：浏览器扩展，加载设置 UI、建立 WebSocket 连接、处理消息/命令/生成
- **服务器端**（server/）：Node.js 进程，运行 Telegram Bot + WebSocket 服务器，转发消息

## 技术要点（2026-07-31 实际落地）
- 扩展符合 SillyTavern 官方规范：`hooks.activate`（onActivate）生命周期、`SillyTavern.getContext()` API、`renderExtensionTemplateAsync()` 加载设置模板
- manifest 已移除废弃 `requires`/`optional`，添加 `dependencies: []` + `hooks.activate`
- 直接 import 仅保留 getContext() 未暴露的 4 个函数：`sendMessageAsUser`、`doNewChat`、`getPastCharacterChats`、`setExternalAbortController`（均从 `../../../../script.js`）
- 自动连接延迟到 `APP_READY` 事件后执行（on + removeListener 方式）
- `DEFAULT_SETTINGS` 使用 `Object.freeze()` + `structuredClone` 初始化 + `Object.hasOwn` 合并默认键
- 已删除 `CHATLOADED` 监听（release 分支中该事件不存在，改用 `CHAT_CHANGED`）
- `GENERATION_ENDED` 传 `chat.length`，`GENERATION_STOPPED` 不传参（handleFinalMessage 需回退 chat.length-1）

## Multiplayer 支持（2026-07-31 落地）
- 设置项：`multiplayerEnabled`、`userPrefix`（`<用户>: ` / `用户: ` / `[用户]: ` / `*用户* `）、`defaultMode`（instant/buffered）、`bufferWindowSeconds`、`bufferMaxMessages`
- 服务器在 `user_message` payload 中传递 `username` / `userId` / `isGroup` 字段
- 服务器新增 `allowedChatIds` 聊天/群组白名单（config.js + `ALLOWED_CHAT_IDS` 环境变量）
- 前端：群组+启用多人时按前缀格式注入玩家名；生成期间消息**排队**顺序处理；缓冲模式把窗口内玩家消息合并成一条发给 AI
- 并发保护：`nextScheduled` 标志防止 Generate 报错时双重调度消息队列

## 环境版本关键事实（2026-07-31 核实）
- ST release 分支：`public/script.js` 存在（4 个函数均 export）；`public/scripts/script.js` **不存在**
- ST staging 分支（2026-07 重构）：`script.js` 已被拆分（chats.js 等），`public/scripts/script.js` 404 —— 若升级到新架构需改用 getContext + 动态 import 回退
- `getContext()` 暴露 `generate`（=Generate）、`eventTypes`/`event_types`、`openGroupChat`、`stopGeneration` 等
- `STREAM_TOKEN_RECEIVED` 事件回调参数为单个字符串（累计文本）
- `sendMessageAsUser(messageText, messageBias, insertAt, compact, name, avatar)` —— name 参数可指定消息作者名（未使用，前缀方案对 AI 可见性更好）
