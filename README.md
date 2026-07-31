# SillyTavern Telegram Connector (Multiplayer)

通过 Telegram 与 SillyTavern AI 角色聊天的桥接扩展，支持 **Telegram 群组多人角色扮演（Multiplayer）**。

[![License](https://img.shields.io/github/license/justhil/SillyTavern-Telegram-Connector)](LICENSE)

## 功能

- 📱 通过 Telegram 与 AI 角色实时对话（私聊 / 群组）
- 🎭 **Multiplayer 群组模式**：多名玩家在群组中与同一 AI 角色进行多人角色扮演
  - 每条玩家消息自动带上玩家名前缀（支持 4 种格式）
  - **即时模式**：每条消息立即触发 AI 回复，生成中的消息自动排队
  - **缓冲模式**：收集一段时间内所有玩家消息合并成一条交给 AI，适合轮流行动的 RPG 场景
- 🔄 流式输出，实时显示 AI 回复
- 📋 内联按钮菜单，快速操作
- 🐳 Docker 一键部署
- 💓 WebSocket 心跳检测，自动重连
- 🔒 用户白名单 + 群组白名单双重控制

## 快速开始

### 1. 安装扩展

在 SillyTavern 中：Extensions → Install Extension → 输入 `https://github.com/justhil/SillyTavern-Telegram-Multiplayer`

### 2. 部署服务器

#### Docker 部署（推荐）

```bash
cd server
# 创建 config.js，参考 config.example.js
cp config.example.js config.js
# 编辑 config.js，填入 Bot Token
docker-compose up -d
```

#### 手动部署

```bash
cd server
npm install
cp config.example.js config.js
# 编辑 config.js，填入 Bot Token
node server.js
```

### 3. 连接

1. SillyTavern → Extensions → Telegram Connector
2. 填入 Bridge URL：`ws://服务器IP:2333` 或 `wss://域名/tg-bridge`
3. 点击连接

## 🎭 Multiplayer 群组模式

1. 在 SillyTavern 扩展设置中勾选 **「Multiplayer 模式」**
2. 选择玩家消息前缀格式（`<玩家名>: ` / `玩家名: ` / `[玩家名]: ` / `*玩家名* `）
3. 选择默认游戏模式：
   - **即时模式**：每条玩家消息立即触发 AI 回复；AI 生成期间收到的消息自动排队，回复完成后按序处理
   - **缓冲模式**：在缓冲窗口（默认 30 秒）内收集所有玩家的消息，合并成一条交给 AI 后统一回复，适合多人轮流行动
4. 将机器人拉入群组（建议设为管理员），玩家在群内发言即可与 AI 互动

> 私聊中不会添加玩家名前缀，行为与普通模式一致。

## 命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示菜单按钮 |
| `/listchars` | 角色列表（分页） |
| `/listchats` | 聊天记录（分页） |
| `/switchchar_数字` | 切换角色 |
| `/switchchat_数字` | 切换聊天 |
| `/new` | 新建聊天 |
| `/ping` | 连接状态 |

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TELEGRAM_BOT_TOKEN` | Bot Token | 必填 |
| `WSS_PORT` | WebSocket 端口 | 2333 |
| `ALLOWED_USER_IDS` | 用户白名单（逗号分隔） | 空（允许所有） |
| `ALLOWED_CHAT_IDS` | 聊天/群组白名单（逗号分隔，Multiplayer 场景限制机器人只在指定群组响应） | 空（允许所有） |
| `MESSAGE_PARSE_MODE` | 消息格式 (HTML/MarkdownV2/plain) | HTML |

### 开发模式（无需 config.js）

没有 `config.js` 时会自动回退加载 `config.example.js`，并在交互式终端中提示手动输入 Bot Token：

```bash
cd server
npm install
node server.js
# 未找到 config.js，已自动回退到 config.example.js（开发模式）
# 开发模式：请在下方手动输入 Token（输入后按回车）：
> 123456789:AAHxxxxx...
```

- 控制台输入的 Token 仅本次运行有效，不会写入配置文件
- 非交互环境（Docker / 后台运行 / CI）下不会等待输入，会按原逻辑报错退出，避免进程卡死

### 群组白名单（ALLOWED_CHAT_IDS）

获取群组 ID 的方法：
1. 将机器人拉入群组后发送一条消息，查看服务器日志中的 `Chat ID`
2. 或使用 [@RawDataBot](https://t.me/RawDataBot) 将机器人添加进群组查看 `chat.id`

## 兼容性说明

- 扩展遵循 SillyTavern 官方 [Writing-Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/) 规范：
  - 使用 `SillyTavern.getContext()` 获取稳定 API
  - 使用 `hooks.activate` 生命周期钩子（`onActivate`）初始化
  - 设置界面通过 `renderExtensionTemplateAsync()` 加载
  - 仅对 `getContext()` 未暴露的 4 个函数直接 import
- 已移除废弃的 `requires` / `optional` manifest 字段（旧 Extras 系统残留）

## 许可证

GPL-3.0
