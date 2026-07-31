# SillyTavern Telegram MultiPlayer

通过 **Telegram 群组**与 SillyTavern AI 角色进行**多人角色扮演**的桥接扩展：多名玩家在群里各说各话，AI 能区分谁是谁，并以角色身份回应。

[![License](https://img.shields.io/github/license/justhil/SillyTavern-Telegram-Connector)](LICENSE)

## ✨ 特性

- 🎭 **Telegram 群组 Multiplayer**：多名玩家与同一 AI 角色互动，消息自动带上玩家名前缀
- 🚀 **内置 Server 模式**：酒馆 Server 插件随酒馆自动启动，零额外依赖、零单独部署
- 🔄 **流式输出**：AI 回复实时流式显示（输入中 → 增量更新 → 最终格式化）
- 💬 **真实对话行为**：连续消息合并、私聊来源标识、酒馆与 Telegram 双向同步
- 📋 **内联按钮菜单**：角色列表 / 聊天记录分页，一键操作
- 💓 **WebSocket 心跳与自动重连**，连接状态面板可见
- 🔒 **用户白名单 + 群组白名单**双重控制

## 📦 安装

### 1. 安装前端扩展

把仓库中以下文件放入酒馆扩展目录（`data/<用户>/extensions/third-party/SillyTavern-Telegram-Multiplayer/` 或 `public/scripts/extensions/third-party/`）：

```
manifest.json
index.js
settings.html
style.css
```

刷新酒馆页面，右侧 Extensions 面板出现 **Telegram MultiPlayer** 设置。

### 2. 部署 Bridge（二选一）

#### 方式 A：内置 Server（推荐，零单独部署）

1. 复制 `plugins/telegram-bridge` 目录到酒馆根目录的 `plugins/` 下：
   ```
   SillyTavern/
   ├── plugins/
   │   └── telegram-bridge/   ← 整个目录放这里
   ├── public/
   ├── server.js
   └── config.yaml
   ```
2. 编辑 `config.yaml`，确认 `enableServerPlugins: true`
3. 重启酒馆
4. 扩展设置面板 → 🚀 内置 Server → 填 **Bot Token** → **保存** → **启动** → URL **留空**点**连接**（自动探测端口）

> 内置 Server 使用酒馆自带的 `ws`/`express` + Node 原生 `https` 实现 Telegram API，**不需要 npm install**，自动选取空闲端口（首选 2333，占用自动递增）。

#### 方式 B：独立部署 server/

```bash
cd server
npm install
node server.js
# 无 config.js 时自动回退 config.example.js，并在控制台提示输入 Token
```

Docker：

```bash
cd server
cp config.example.js config.js   # 填入 Bot Token
docker-compose up -d
```

连接：扩展设置 → Bridge URL 填 `ws://服务器IP:2333` → 连接。

## ⚙️ 配置

### 扩展设置面板

| 设置项 | 说明 |
|--------|------|
| Bridge URL | 留空 = 自动探测内置 Server；填写 = 手动连接指定地址 |
| 自动连接 | 页面加载后自动连接 |
| Bot Token（内置 Server） | 保存到插件 `config.json`，仅内置模式需要 |
| Multiplayer 模式 | 群组多人开关，开启后消息带玩家名前缀 |
| 玩家消息前缀格式 | `名字 (@用户名): ` / `<玩家名>: ` / `玩家名: ` / `[玩家名]: ` / `*玩家名* ` |
| 默认游戏模式 | 即时（每条触发回复）/ 缓冲（窗口内合并多人消息） |
| 连续消息合并窗口 | 秒数，0 = 每条立即回复（默认 3 秒） |
| 缓冲窗口 / 缓冲最大消息数 | 缓冲模式参数（默认 30 秒 / 8 条） |
| 双向同步 | 酒馆本地生成的 AI 回复也推送到最近活跃的 Telegram 聊天 |

### 服务器配置（config.js / 环境变量）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TELEGRAM_BOT_TOKEN` | Bot Token | 必填 |
| `WSS_PORT` | WebSocket 端口 | 2333 |
| `ALLOWED_USER_IDS` | 用户白名单（逗号分隔） | 空（允许所有） |
| `ALLOWED_CHAT_IDS` | 聊天/群组白名单（逗号分隔） | 空（允许所有） |
| `MESSAGE_PARSE_MODE` | 消息格式 (HTML / MarkdownV2 / plain) | HTML |

**群组白名单**：将机器人拉入群组后发一条消息，查看服务器日志中的 Chat ID，或使用 [@RawDataBot](https://t.me/RawDataBot) 获取 `chat.id`，填入 `ALLOWED_CHAT_IDS` 可防止机器人被拉进无关群组。

## 🎮 使用

### 私聊

直接给机器人发消息即可。消息注入酒馆时会以你的 Telegram 用户名作为来源标识；连续短消息默认在 3 秒合并窗口内合并，不会逐条触发回复。

### 群组 Multiplayer

1. 扩展设置勾选 **Multiplayer 模式**
2. 选择前缀格式（推荐 `名字 (@用户名): `，如 `Lin (@lolinverse): 我推开门`）
3. 选择游戏模式：
   - **即时模式**：玩家消息触发回复，连续消息自动合并
   - **缓冲模式**：窗口内（默认 30 秒）所有玩家消息合并成一条交给 AI，适合轮流行动的 RPG
4. 将机器人拉入群组（建议设为管理员）

### 行为说明

- **合并窗口**：玩家连发多条短消息会被合并成一条再触发回复，避免刷屏式对话
- **双向同步**：在酒馆页面手动推进的剧情，AI 回复也会同步到最近活跃的 Telegram 聊天（可关闭）
- **未连接静默**：SillyTavern 未连接时机器人不回复、不刷屏，仅在服务器终端提示

## 📋 命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示菜单按钮 |
| `/listchars` | 角色列表（分页） |
| `/listchats` | 聊天记录（分页） |
| `/switchchar_数字` | 切换角色 |
| `/switchchat_数字` | 切换聊天 |
| `/new` | 新建聊天 |
| `/ping` | 连接状态（Bridge / WebSocket 端口 / SillyTavern） |

## 🔧 故障排查

| 现象 | 原因与解决 |
|------|-----------|
| 状态"重连失败" | Bridge 未运行或 URL 不对：启动内置 Server（或 `node server.js`），确认端口 |
| 设置面板没有 Multiplayer 选项 | 前端扩展文件旧：更新 `index.js` + `settings.html` 后 **Ctrl+F5** 强刷；面板顶部应显示 `Telegram MultiPlayer v1.2.0` 徽标 |
| 群聊出现两条重复回复 | 旧版竞态 bug，已修复；更新 server（或插件）到最新即可 |
| 消息在酒馆里显示 `null:` 前缀 | 旧版 server 未传 username 字段；更新 server 到最新 |
| 409 Token 冲突 | 同一 Token 被两个实例轮询（如同时跑独立 server 和内置插件）；只保留一个 |
| 群里收到"无法连接"刷屏 | 旧版行为，已改为终端提示；更新到最新 |

## 📐 兼容性

- 遵循 SillyTavern 官方 [Writing-Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/) 规范：
  - `SillyTavern.getContext()` 获取稳定 API
  - `hooks.activate` 生命周期钩子初始化
  - 设置面板挂载到官方推荐的 `#extensions_settings2` 容器
  - 仅对 getContext() 未暴露的 4 个函数直接 import
- 已移除废弃的 `requires` / `optional` manifest 字段
- 内置 Server 插件遵循官方 [Server-Plugins](https://docs.sillytavern.app/for-contributors/server-plugins/) 规范

## 🛠 开发

```bash
# 独立模式本地调试
cd server
npm install
node server.js

# 内置插件模式：把 plugins/telegram-bridge 放入酒馆 plugins/ 目录
```

浏览器 F12 Console 提供扩展自检日志（版本、settings.html 内容长度、关键控件渲染状态），方便排查部署问题。

## 许可证

GPL-3.0
