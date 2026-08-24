// SillyTavern Server Plugin: Telegram Bridge (内置 Server)
//
// 让用户无需单独部署 server/ 目录 —— 把这个目录放到酒馆的 plugins/ 下，
// 酒馆启动时自动运行 Telegram Bot + WebSocket Bridge。
//
// 依赖策略：仅使用酒馆主进程自带的 ws/express 和 Node 原生 https，
// 不引入 node-telegram-bot-api，插件目录零依赖，开箱即用。
//
// Token 来源（优先级从高到低）：
//   1. 环境变量 TELEGRAM_BOT_TOKEN
//   2. 插件目录 config.json 中的 telegramToken（可通过扩展设置面板写入）
//
// 端口：自动选取未被占用的端口（首选 2333，占用则递增），
//       前端扩展通过 GET /api/plugins/telegram-bridge/status 获取实际端口。

const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');

// 依赖来自酒馆主进程（express/ws 均为 SillyTavern 自带依赖）。
// 可选加载：在独立测试环境（无酒馆）也能 require 本模块。
let express = null;
let WebSocket = null;
try { express = require('express'); } catch (e) { /* 仅在非酒馆环境出现 */ }
try { WebSocket = require('ws'); } catch (e) { /* 仅在非酒馆环境出现 */ }

const PLUGIN_ID = 'telegram-bridge';
const TELEGRAM_API = 'api.telegram.org';
const TELEGRAM_MAX_LENGTH = 4096;
const HEARTBEAT_INTERVAL = 30000;
const TYPING_INTERVAL = 4000;
const MIN_CHARS_BEFORE_DISPLAY = 50;
const STREAM_SESSION_TTL_MS = 60000; // 流式会话兜底清理TTL：stream_end 后若最终更新未到达，超时删除残留会话
const CONFIG_FILE = path.join(__dirname, 'config.json');

// --- 运行时状态 ---
let bot = null;            // 简易 TG Bot 客户端（原生 https 实现）
let wss = null;            // WebSocket Server
let wssPort = null;        // 实际监听端口
let sillyTavernClient = null;
let heartbeatInterval = null;
let lastActiveChatId = null;   // 最近活跃的 Telegram 聊天（用于本地生成同步）
const ongoingStreams = new Map(); // chatId -> stream session

// --- 工具 ---

function logWithTimestamp(level, ...args) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const prefix = `[${ts}] [TG-Bridge]`;
    switch (level) {
        case 'error': console.error(prefix, ...args); break;
        case 'warn': console.warn(prefix, ...args); break;
        default: console.log(prefix, ...args);
    }
}

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (e) {
        logWithTimestamp('warn', '读取 config.json 失败:', e.message);
    }
    return {};
}

function writeConfig(patch) {
    const cfg = Object.assign(readConfig(), patch);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return cfg;
}

// --- 简易 Telegram Bot API（原生 https） ---

function tgRequest(method, payload) {
    const token = this.token || (bot && bot.token);
    if (!token) return Promise.reject(new Error('Bot Token 未配置'));
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload || {});
        const req = https.request({
            hostname: TELEGRAM_API,
            path: `/bot${token}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 60000,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok) return resolve(json.result);
                    reject(new Error(`Telegram API ${method} 失败: ${json.description || '未知错误'}`));
                } catch (e) {
                    reject(new Error(`Telegram API 响应解析失败: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('Telegram API 请求超时')); });
        req.on('error', reject);
        req.end(body);
    });
}

class TelegramBotClient {
    constructor(token) {
        this.token = token;
        this.polling = false;
        this.pollingTimer = null;
        this.offset = 0;
        this.stopRequested = false;
    }

    async start() {
        // 先确认 token 有效（getMe）
        const me = await tgRequest.call({ token: this.token }, 'getMe', {});
        logWithTimestamp('log', `Telegram Bot 已连接: @${me.username}`);
        this.polling = true;
        this.offset = 0;
        this.pollLoop();
        return me;
    }

    async stop() {
        this.stopRequested = true;
        this.polling = false;
        if (this.pollingTimer) clearTimeout(this.pollingTimer);
        this.pollingTimer = null;
    }

    pollLoop() {
        if (!this.polling || this.stopRequested) return;
        tgRequest.call({ token: this.token }, 'getUpdates', {
            offset: this.offset,
            timeout: 25,
            allowed_updates: ['message', 'callback_query'],
        }).then((updates) => {
            if (!this.polling) return;
            for (const update of updates || []) {
                this.offset = update.update_id + 1;
                this.handleUpdate(update);
            }
            this.scheduleNext();
        }).catch((err) => {
            if (err.message.includes('409')) {
                logWithTimestamp('error', '检测到另一个 Bot 实例正在轮询同一 Token（409 冲突）。');
                logWithTimestamp('error', '请停止独立运行的 server.js 或关闭其他实例。');
                this.stop();
                return;
            }
            if (err.message.includes('401')) {
                logWithTimestamp('error', 'Telegram Token 无效（401）。请检查 Token 是否正确。');
                this.stop();
                return;
            }
            logWithTimestamp('warn', `轮询出错，3 秒后重试: ${err.message}`);
            setTimeout(() => this.scheduleNext(), 3000);
        });
    }

    scheduleNext() {
        if (!this.polling || this.stopRequested) return;
        this.pollingTimer = setTimeout(() => this.pollLoop(), 100);
    }

    handleUpdate(update) {
        try {
            if (update.callback_query) this.handleCallbackQuery(update.callback_query);
            else if (update.message) this.handleMessage(update.message);
        } catch (e) {
            logWithTimestamp('error', '处理更新出错:', e.message);
        }
    }

    handleMessage(msg) {
        const chatId = msg.chat.id;
        const text = msg.text;
        if (!text) return; // 忽略非文本消息（图片/贴纸等）

        lastActiveChatId = chatId;
        const userId = msg.from.id;
        const username = msg.from.username || msg.from.first_name || '用户';
        const firstName = msg.from.first_name || ''; // 显示名，供前缀格式 "名字 (@用户名)" 使用
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

        // 命令
        if (text.startsWith('/')) {
            const parts = text.slice(1).trim().split(/\s+/);
            const command = parts[0].toLowerCase();
            const args = parts.slice(1);

            if (['reload', 'restart', 'exit', 'ping'].includes(command)) {
                this.handleSystemCommand(command, chatId);
                return;
            }
            forwardToST({ type: 'execute_command', command, args, chatId });
            // 轻量命令（help/helptext 等由前端回复）走 execute_command 后前端会回 ai_reply
            return;
        }

        if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
            // 未连接：只在终端提示，不向 Telegram 回复，避免群聊刷屏
            logWithTimestamp('warn', `收到来自 ${chatId} 的消息但酒馆扩展未连接，已忽略: "${text.slice(0, 50)}"`);
            logWithTimestamp('warn', '提示：请在酒馆扩展中开启并连接 Telegram 扩展。');
            return;
        }

        logWithTimestamp('log', `收到消息 ${isGroup ? '群组' : '私聊'} @${username}: "${text.slice(0, 60)}"`);
        forwardToST({ type: 'user_message', chatId, text, username, firstName, userId, isGroup });
    }

    handleCallbackQuery(cq) {
        const chatId = cq.message.chat.id;
        const data = cq.data || '';
        lastActiveChatId = chatId;
        this.answerCallbackQuery(cq.id).catch(() => {});

        // 长消息分页
        if (data.startsWith('page_')) {
            const parts = data.split('_');
            const cacheId = parts.slice(1, 4).join('_');
            const page = parseInt(parts[4]);
            const cache = longMessageCache.get(cacheId);
            if (cache && !isNaN(page)) {
                this.deleteMessage(chatId, cq.message.message_id).catch(() => {});
                sendPagedMessage(chatId, cacheId, page);
            }
            return;
        }
        // 命令按钮
        if (data.startsWith('cmd_')) {
            const command = data.replace('cmd_', '');
            const pageMatch = command.match(/^(listchars|listchats)_(\d+)$/);
            if (pageMatch) {
                forwardToST({ type: 'execute_command', command: pageMatch[1], args: [pageMatch[2]], chatId });
            } else {
                forwardToST({ type: 'execute_command', command, args: [], chatId });
            }
        }
    }

    async handleSystemCommand(command, chatId) {
        let replyText;
        switch (command) {
            case 'ping': {
                const stStatus = sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN ? '已连接 ✅' : '未连接 ❌';
                replyText = `🤖 Bridge 状态：运行中 ✅\n📡 WebSocket 端口：${wssPort}\n🖥️ SillyTavern：${stStatus}`;
                break;
            }
            case 'reload':
                replyText = '内置 Server 与酒馆同进程，无需 reload。请直接重启酒馆。';
                break;
            case 'restart':
                replyText = '内置 Server 与酒馆同进程，重启酒馆即可生效。';
                break;
            case 'exit':
                replyText = '内置 Server 无法独立退出（与酒馆同进程）。';
                break;
            default:
                replyText = `未知系统命令: /${command}`;
        }
        this.sendMessage(chatId, replyText).catch(() => {});
    }

    // --- Telegram 发送 API（供桥接使用） ---

    sendMessage(chatId, text, options = {}) {
        const payload = Object.assign({ chat_id: chatId, text }, options);
        return tgRequest.call(this, 'sendMessage', payload);
    }

    editMessageText(chatId, messageId, text, options = {}) {
        const payload = Object.assign({ chat_id: chatId, message_id: messageId, text }, options);
        return tgRequest.call(this, 'editMessageText', payload);
    }

    deleteMessage(chatId, messageId) {
        return tgRequest.call(this, 'deleteMessage', { chat_id: chatId, message_id: messageId });
    }

    sendChatAction(chatId, action) {
        return tgRequest.call(this, 'sendChatAction', { chat_id: chatId, action }).catch(() => {});
    }

    answerCallbackQuery(id) {
        return tgRequest.call(this, 'answerCallbackQuery', { callback_query_id: id });
    }
}

// --- 长消息分页缓存 ---
const longMessageCache = new Map();

function cacheLongMessage(chatId, parts) {
    const cacheId = `msg_${chatId}_${Date.now()}`;
    longMessageCache.set(cacheId, { parts, chatId });
    setTimeout(() => longMessageCache.delete(cacheId), 5 * 60 * 1000);
    return cacheId;
}

// --- 消息格式化（与 server/messageFormatter.js 对齐的精简版） ---

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatMessage(text, parseMode) {
    if (!parseMode || parseMode === 'plain') {
        return { text, parseMode: null };
    }
    if (parseMode === 'HTML') {
        let html = text
            .replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${escapeHtml(code.trim())}</pre>`)
            .replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`)
            .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
            .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<i>$2</i>');
        return { text: html, parseMode: 'HTML' };
    }
    if (parseMode === 'MarkdownV2') {
        const esc = (s) => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
        let md = text
            .replace(/```([\s\S]*?)```/g, (_, code) => '```' + code.trim() + '```')
            .replace(/`([^`\n]+)`/g, (_, code) => '`' + code + '`')
            .replace(/\*\*([^*]+)\*\*/g, '*$1*')
            .replace(/(^|\s)\*([^*\n]+)\*/g, '$1_$2_');
        return { text: md, parseMode: 'MarkdownV2' };
    }
    return { text, parseMode: null };
}

function splitLongMessage(text, maxLength = 4000) {
    const parts = [];
    let remaining = text;
    while (remaining.length > maxLength) {
        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) splitIndex = maxLength;
        parts.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }
    parts.push(remaining);
    return parts;
}

async function sendLongMessage(chatId, text, parseMode) {
    if (!text) text = '(空消息)';
    if (text.length <= 4000) {
        const options = parseMode ? { parse_mode: parseMode } : {};
        try {
            return await bot.sendMessage(chatId, text, options);
        } catch (err) {
            logWithTimestamp('warn', `格式化发送失败，回退纯文本: ${err.message}`);
            return await bot.sendMessage(chatId, text).catch(() => null);
        }
    }
    // 超长：分页按钮
    const parts = splitLongMessage(text);
    if (parts.length === 1) return bot.sendMessage(chatId, parts[0]);
    const cacheId = cacheLongMessage(chatId, parts);
    return sendPagedMessage(chatId, cacheId, 1);
}

/**
 * 发送分页消息（超长消息拆成多页，带上一页/下一页按钮）
 */
async function sendPagedMessage(chatId, cacheId, page) {
    const cache = longMessageCache.get(cacheId);
    if (!cache) {
        await bot.sendMessage(chatId, '消息已过期，请重新请求').catch(() => {});
        return;
    }
    const { parts } = cache;
    const totalPages = parts.length;
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const content = parts[currentPage - 1];

    const buttons = [];
    if (currentPage > 1) {
        buttons.push({ text: `⬅️ ${currentPage - 1}/${totalPages}`, callback_data: `page_${cacheId}_${currentPage - 1}` });
    }
    if (currentPage < totalPages) {
        buttons.push({ text: `${currentPage + 1}/${totalPages} ➡️`, callback_data: `page_${cacheId}_${currentPage + 1}` });
    }
    const sendOptions = {};
    if (buttons.length > 0) sendOptions.reply_markup = { inline_keyboard: [buttons] };

    const pageText = totalPages > 1 ? `📄 [${currentPage}/${totalPages}]\n\n${content}` : content;
    try {
        await bot.sendMessage(chatId, pageText, sendOptions);
    } catch (err) {
        logWithTimestamp('error', '发送分页消息失败:', err.message);
        await bot.sendMessage(chatId, pageText).catch(() => {});
    }
}

// --- WebSocket 处理 ---

function startHeartbeat(ws) {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
        }
    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

function startTypingInterval(chatId) {
    bot.sendChatAction(chatId, 'typing');
    return setInterval(() => bot.sendChatAction(chatId, 'typing'), TYPING_INTERVAL);
}

function stopTypingInterval(interval) {
    if (interval) clearInterval(interval);
}

function forwardToST(payload) {
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        sillyTavernClient.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

function handleStreamChunk(data) {
    const chatId = data.chatId;
    let session = ongoingStreams.get(chatId);

    // 残留会话检测：上一轮流式已结束（stream_end 已停 typing）但
    // final_message_update 未到达时会话残留并携带旧 messageId，
    // 复用会导致新一轮回复去编辑旧消息。检测到即重建会话。
    if (session && session.typingInterval === null) {
        logWithTimestamp('warn', `检测到残留流式会话 ChatID ${chatId}，重建会话（避免覆盖旧消息）`);
        ongoingStreams.delete(chatId);
        session = null;
    }

    if (!session) {
        let resolveMessagePromise;
        const messagePromise = new Promise((resolve) => { resolveMessagePromise = resolve; });
        session = {
            messagePromise,
            resolveMessagePromise,
            messageId: null,
            lastText: data.text,
            timer: null,
            isEditing: false,
            sendingInitial: false,
            typingInterval: startTypingInterval(chatId),
            charCount: data.text ? data.text.length : 0,
        };
        ongoingStreams.set(chatId, session);

        if (session.charCount >= MIN_CHARS_BEFORE_DISPLAY) {
            session.sendingInitial = true;
            const displayText = data.text.length > 4000 ? data.text.substring(0, 4000) + '...' : data.text + ' ...';
            bot.sendMessage(chatId, displayText)
                .then((sent) => {
                    session.messageId = sent.message_id;
                    resolveMessagePromise(sent.message_id);
                })
                .catch((err) => {
                    logWithTimestamp('error', '发送初始消息失败:', err.message);
                    session.sendingInitial = false;
                    stopTypingInterval(session.typingInterval);
                    ongoingStreams.delete(chatId);
                    resolveMessagePromise(null); // 避免 messagePromise 永悬
                });
        }
    } else {
        session.lastText = data.text;
        session.charCount = data.text ? data.text.length : 0;
        if (!session.messageId && session.charCount >= MIN_CHARS_BEFORE_DISPLAY && !session.sendingInitial) {
            session.sendingInitial = true;
            const displayText = data.text.length > 4000 ? data.text.substring(0, 4000) + '...' : data.text + ' ...';
            bot.sendMessage(chatId, displayText)
                .then((sent) => {
                    session.messageId = sent.message_id;
                    if (session.resolveMessagePromise) session.resolveMessagePromise(sent.message_id);
                })
                .catch((err) => {
                    logWithTimestamp('error', '发送初始消息失败:', err.message);
                    session.sendingInitial = false;
                    if (session.resolveMessagePromise) session.resolveMessagePromise(null); // 避免 messagePromise 永悬
                });
        }
    }

    if (session.messageId && !session.isEditing && !session.timer) {
        session.timer = setTimeout(() => {
            const current = ongoingStreams.get(chatId);
            if (current && current.messageId) {
                current.isEditing = true;
                const editText = current.lastText.length > 4000
                    ? current.lastText.substring(0, 4000) + '...'
                    : current.lastText + ' ...';
                bot.editMessageText(chatId, current.messageId, editText)
                    .catch((err) => {
                        if (!err.message.includes('message is not modified')) {
                            logWithTimestamp('error', '编辑流式消息失败:', err.message);
                        }
                    })
                    .finally(() => {
                        const latest = ongoingStreams.get(chatId);
                        if (latest) latest.isEditing = false;
                    });
            }
            // 会话可能在编辑期间被 final_message_update/cleanup_session 删除
            if (current) current.timer = null;
        }, 2000);
    }
}

async function handleFinalMessageUpdate(data) {
    const chatId = data.chatId;
    const session = ongoingStreams.get(chatId);
    const parseMode = readConfig().messageFormat?.parseMode || 'HTML';
    const formatted = formatMessage(data.text, parseMode);

    if (session) {
        stopTypingInterval(session.typingInterval);

        // 竞态修复：初始消息可能还在发送中（messageId 尚未赋值）。
        // 等待其完成拿到 messageId 后原地编辑，避免群里出现"初始消息 + 完整消息"两条重复。
        if (!session.messageId && session.sendingInitial && session.messagePromise) {
            await Promise.race([
                session.messagePromise.then(() => { }).catch(() => { }),
                new Promise(resolve => setTimeout(resolve, 3000)),
            ]);
        }

        if (session.messageId) {
            if (formatted.text.length > 4000) {
                await bot.deleteMessage(chatId, session.messageId).catch(() => {});
                await sendLongMessage(chatId, formatted.text, formatted.parseMode);
            } else {
                const options = formatted.parseMode ? { parse_mode: formatted.parseMode } : {};
                await bot.editMessageText(chatId, session.messageId, formatted.text, options).catch(async (err) => {
                    if (!err.message.includes('message is not modified')) {
                        logWithTimestamp('warn', `编辑最终消息失败，回退纯文本: ${err.message}`);
                        await bot.editMessageText(chatId, session.messageId, data.text).catch(() => {});
                    }
                });
            }
        } else {
            await sendLongMessage(chatId, formatted.text, formatted.parseMode);
        }
        // 清理流式会话（取消兜底清理定时器）
        clearTimeout(session.cleanupTimer);
        ongoingStreams.delete(chatId);
    } else {
        await sendLongMessage(chatId, formatted.text, formatted.parseMode);
    }
}

function handleLocalReply(data) {
    // 酒馆本地生成的 AI 回复 → 推送到最近活跃的 Telegram 聊天
    if (!lastActiveChatId) {
        logWithTimestamp('log', '收到本地生成同步请求，但没有活跃的 Telegram 聊天，已忽略。');
        return;
    }
    const parseMode = readConfig().messageFormat?.parseMode || 'HTML';
    const formatted = formatMessage(data.text, parseMode);
    logWithTimestamp('log', `本地生成同步 → chatId ${lastActiveChatId}`);
    sendLongMessage(lastActiveChatId, formatted.text, formatted.parseMode);
}

function handleSTMessage(message) {
    let data;
    try {
        data = JSON.parse(message);
    } catch (e) {
        logWithTimestamp('error', '解析前端消息失败');
        return;
    }

    if (data.type === 'heartbeat_ack') return;
    if (data.type === 'stream_chunk' && data.chatId) return handleStreamChunk(data);
    if (data.type === 'stream_end' && data.chatId) {
        const session = ongoingStreams.get(data.chatId);
        if (session) {
            if (session.timer) clearTimeout(session.timer);
            stopTypingInterval(session.typingInterval);
            session.typingInterval = null;
            // 兜底清理：final_message_update 未在 TTL 内到达时删除残留会话，
            // 避免无限残留（内存泄漏 + 复用旧消息）
            clearTimeout(session.cleanupTimer);
            session.cleanupTimer = setTimeout(() => {
                if (ongoingStreams.get(data.chatId) === session) {
                    logWithTimestamp('log', `流式会话 ChatID ${data.chatId} 超时未收到最终更新，已清理残留`);
                    ongoingStreams.delete(data.chatId);
                }
            }, STREAM_SESSION_TTL_MS);
        }
        return;
    }
    if (data.type === 'final_message_update' && data.chatId) {
        return handleFinalMessageUpdate(data);
    }
    if (data.type === 'local_reply') {
        return handleLocalReply(data);
    }
    if (data.type === 'ai_reply' && data.chatId) {
        if (ongoingStreams.has(data.chatId)) ongoingStreams.delete(data.chatId);
        const options = {};
        if (data.pagination) {
            const { currentPage, totalPages, type } = data.pagination;
            const buttons = [];
            if (currentPage > 1) buttons.push({ text: '⬅️ 上一页', callback_data: `cmd_${type}_${currentPage - 1}` });
            if (currentPage < totalPages) buttons.push({ text: '➡️ 下一页', callback_data: `cmd_${type}_${currentPage + 1}` });
            if (buttons.length > 0) options.reply_markup = { inline_keyboard: [buttons] };
        }
        bot.sendMessage(data.chatId, data.text, options).catch((err) => {
            logWithTimestamp('error', `发送回复失败: ${err.message}`);
            sendLongMessage(data.chatId, data.text, null);
        });
        return;
    }
    if (data.type === 'error_message' && data.chatId) {
        sendLongMessage(data.chatId, data.text, null);
        return;
    }
    if (data.type === 'typing_action' && data.chatId) {
        bot.sendChatAction(data.chatId, 'typing');
        return;
    }
    if (data.type === 'cleanup_session' && data.chatId) {
        const session = ongoingStreams.get(data.chatId);
        if (session) {
            if (session.timer) clearTimeout(session.timer);
            clearTimeout(session.cleanupTimer);
            stopTypingInterval(session.typingInterval);
            ongoingStreams.delete(data.chatId);
        }
        return;
    }
    if (data.type === 'command_executed') {
        logWithTimestamp('log', `命令 ${data.command} 执行结果: ${data.success ? '成功' : '失败'}`);
        return;
    }
    if (data.type === 'system_command') {
        if (data.command === 'reload_ui_only') {
            forwardToST({ type: 'system_command', command: 'reload_ui_only', chatId: data.chatId });
        }
        return;
    }
}

// --- 自动端口选择 ---

function findFreePort(preferred) {
    if (preferred > 65535) return Promise.reject(new Error('没有可用端口'));
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                // 端口被占用，尝试下一个
                server.close();
                resolve(findFreePort(preferred + 1).catch(() => null));
            } else {
                reject(err);
            }
        });
        server.listen(preferred, '0.0.0.0', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

// --- 插件生命周期 ---

async function startBridge(token) {
    if (!WebSocket) {
        throw new Error('无法加载 ws 模块：请确认插件位于 SillyTavern 的 plugins/ 目录中');
    }
    if (bot) {
        logWithTimestamp('warn', 'Bridge 已在运行，先停止旧实例');
        await stopBridge();
    }

    bot = new TelegramBotClient(token);
    await bot.start();

    // 自动选端口（首选 2333）
    wssPort = await findFreePort(2333);
    wss = new WebSocket.Server({ port: wssPort, host: '0.0.0.0' });
    logWithTimestamp('log', `WebSocket Bridge 正在监听端口 ${wssPort}`);

    wss.on('connection', (ws) => {
        logWithTimestamp('log', '酒馆扩展已连接！');
        sillyTavernClient = ws;
        startHeartbeat(ws);

        ws.on('message', (message) => {
            try {
                handleSTMessage(message);
            } catch (e) {
                logWithTimestamp('error', '处理酒馆消息出错:', e);
            }
        });

        ws.on('close', () => {
            logWithTimestamp('log', '酒馆扩展已断开');
            stopHeartbeat();
            sillyTavernClient = null;
            for (const s of ongoingStreams.values()) stopTypingInterval(s.typingInterval);
            ongoingStreams.clear();
        });

        ws.on('error', (e) => {
            logWithTimestamp('error', 'WebSocket 错误:', e.message);
            stopHeartbeat();
            sillyTavernClient = null;
            ongoingStreams.clear();
        });
    });
}

async function stopBridge() {
    if (bot) {
        await bot.stop().catch(() => {});
        bot = null;
    }
    if (wss) {
        for (const client of wss.clients) client.close();
        await new Promise((resolve) => wss.close(resolve));
        wss = null;
    }
    stopHeartbeat();
    sillyTavernClient = null;
    ongoingStreams.clear();
    logWithTimestamp('log', 'Bridge 已停止');
}

/**
 * 插件初始化入口（SillyTavern Server Plugin 规范）
 * @param {import('express').Router} router
 */
async function init(router) {
    const cfg = readConfig();
    const envToken = process.env.TELEGRAM_BOT_TOKEN;
    const token = envToken || cfg.telegramToken;

    if (token) {
        try {
            await startBridge(token);
        } catch (e) {
            logWithTimestamp('error', '启动 Bridge 失败:', e.message);
            bot = null;
        }
    } else {
        logWithTimestamp('warn', '未配置 Telegram Bot Token。');
        logWithTimestamp('warn', '可在扩展设置面板中填写，或设置 TELEGRAM_BOT_TOKEN 环境变量。');
    }

    // 状态查询（前端扩展用来自动发现端口）
    router.get('/status', (req, res) => {
        res.json({
            running: !!(bot && wss),
            wssPort,
            botConnected: !!(bot && bot.polling),
            configured: !!(process.env.TELEGRAM_BOT_TOKEN || readConfig().telegramToken),
            lastActiveChatId,
            pluginPath: __dirname,
        });
    });

    // Token/配置保存（前端扩展设置面板写入）
    // express 在真实酒馆环境必然存在；缺失时使用透传中间件保证路由不崩
    const jsonBody = express ? express.json() : (req, res, next) => { next(); };
    router.post('/config', jsonBody, (req, res) => {
        try {
            const body = req.body || {};
            const cfg = writeConfig({ telegramToken: body.telegramToken || '' });
            res.json({ ok: true, configured: !!cfg.telegramToken, message: '配置已保存' });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 启动/重启 Bridge
    router.post('/start', jsonBody, async (req, res) => {
        const cfg = readConfig();
        const token = process.env.TELEGRAM_BOT_TOKEN || cfg.telegramToken || (req.body && req.body.telegramToken);
        if (!token) {
            res.status(400).json({ ok: false, error: '未配置 Token' });
            return;
        }
        try {
            await startBridge(token);
            res.json({ ok: true, wssPort });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 停止 Bridge
    router.post('/stop', async (req, res) => {
        try {
            await stopBridge();
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    logWithTimestamp('log', 'Telegram Bridge Server 插件已加载 (id: telegram-bridge)');
    return Promise.resolve();
}

async function exit() {
    await stopBridge();
    return Promise.resolve();
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'Telegram Bridge (内置 Server)',
        description: '在酒馆进程内运行 Telegram Bot + WebSocket Bridge，支持群组 Multiplayer。零额外依赖，自动选择空闲端口。',
    },
};
