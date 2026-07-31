// index.js
// SillyTavern Telegram Connector (Multiplayer)
//
// 合规性说明（依据官方 Writing-Extensions 文档）：
// - 使用 SillyTavern.getContext() 获取稳定 API（eventSource、extensionSettings 等）
// - 仅对 getContext() 未暴露的 4 个函数做直接 import（script.js 是官方文档认可的写法）
// - 使用 hooks.activate 生命周期钩子（onActivate）替代 jQuery 就绪回调
// - 异步初始化放到 APP_READY 事件之后，避免阻塞应用加载

// 从 script.js 导入 getContext() 未暴露的函数
import {
    sendMessageAsUser,
    doNewChat,
    getPastCharacterChats,
    setExternalAbortController,
} from "../../../../script.js";

const MODULE_NAME = 'SillyTavern-Telegram-Connector';

// 默认设置：Object.freeze 防止意外修改
const DEFAULT_SETTINGS = Object.freeze({
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
    // ---- Multiplayer 设置 ----
    multiplayerEnabled: false,      // 是否启用群组多人模式
    userPrefix: '<用户>: ',          // 用户消息前缀格式: '<用户>: ' | '用户: ' | '[用户]: ' | '*用户* '
    defaultMode: 'instant',          // 默认游戏模式: 'instant'(即时) | 'buffered'(缓冲)
    bufferWindowSeconds: 30,         // 缓冲模式：收集窗口（秒）
    bufferMaxMessages: 8,            // 缓冲模式：最多收集消息数，达到立即触发
});

let ws = null; // WebSocket实例
let lastProcessedChatId = null; // 当前正在生成的Telegram chatId

// 生成状态标志
let isGenerating = false;

// 消息队列：Multiplayer 下生成期间的新消息先入队，回复完成后按序处理
// 元素: { chatId, text, username, isGroup }
let messageQueue = [];

// 缓冲模式：收集一段时间内多名玩家的消息，合并成一条发送给 AI
// 元素: { chatId, parts: [string], timer, lastActivity }
let buffer = null;

// 心跳超时检测相关变量
let heartbeatTimeoutTimer = null;
const HEARTBEAT_TIMEOUT = 45000; // 45秒超时
let lastHeartbeatTime = null;

// 自动重连相关变量
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 5000; // 5秒延迟
let reconnectTimer = null;
let isReconnecting = false;

// --- 工具函数 ---

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    // 确保新增默认键不丢失（升级兼容）
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        statusEl.textContent = `状态： ${message}`;
        statusEl.style.color = color;
    }
}

/**
 * 根据设置的用户名前缀格式，为群组消息添加玩家名前缀
 * @param {string} username - Telegram 用户名
 * @param {string} text - 原始消息文本
 * @returns {string} 添加前缀后的文本
 */
function applyUserPrefix(username, text) {
    if (!username) return text;
    const format = getSettings().userPrefix || '<用户>: ';
    const displayName = username.startsWith('@') ? username.slice(1) : username;
    switch (format) {
        case '用户: ':
            return `${displayName}: ${text}`;
        case '[用户]: ':
            return `[${displayName}]: ${text}`;
        case '*用户* ':
            return `*${displayName}* ${text}`;
        case '<用户>: ':
        default:
            return `<${displayName}>: ${text}`;
    }
}

/**
 * 重置心跳超时定时器
 */
function resetHeartbeatTimeout() {
    if (heartbeatTimeoutTimer) {
        clearTimeout(heartbeatTimeoutTimer);
    }
    lastHeartbeatTime = Date.now();
    heartbeatTimeoutTimer = setTimeout(() => {
        console.log('[Telegram Bridge] 心跳超时，连接可能已断开');
        updateStatus('连接超时', 'red');
        if (ws) {
            ws.close();
        }
    }, HEARTBEAT_TIMEOUT);
}

/**
 * 清除心跳超时定时器
 */
function clearHeartbeatTimeout() {
    if (heartbeatTimeoutTimer) {
        clearTimeout(heartbeatTimeoutTimer);
        heartbeatTimeoutTimer = null;
    }
    lastHeartbeatTime = null;
}

/**
 * 处理收到的心跳消息，发送心跳响应
 */
function handleHeartbeat(data) {
    resetHeartbeatTimeout();
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'heartbeat_ack',
            timestamp: data.timestamp
        }));
    }
}

/**
 * 尝试自动重连（最多3次，间隔5秒）
 */
function attemptReconnect() {
    if (isReconnecting) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('[Telegram Bridge] 已达到最大重连次数，停止重连');
        updateStatus('重连失败', 'red');
        reconnectAttempts = 0;
        return;
    }
    isReconnecting = true;
    reconnectAttempts++;
    console.log(`[Telegram Bridge] 将在${RECONNECT_DELAY / 1000}秒后尝试重连 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    updateStatus(`重连中... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, 'orange');
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }
    reconnectTimer = setTimeout(() => {
        isReconnecting = false;
        console.log(`[Telegram Bridge] 正在尝试第${reconnectAttempts}次重连...`);
        connect();
    }, RECONNECT_DELAY);
}

function resetReconnectState() {
    reconnectAttempts = 0;
    isReconnecting = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function cancelReconnect() {
    resetReconnectState();
    console.log('[Telegram Bridge] 已取消自动重连');
}

function reloadPage() {
    window.location.reload();
}

// --- Multiplayer 消息队列 ---

/**
 * 新消息入口：生成中则入队，否则立即处理
 * @param {object} item - { chatId, text, username, isGroup }
 */
function enqueueOrProcess(item) {
    if (isGenerating) {
        messageQueue.push(item);
        console.log(`[Telegram Bridge] 正在生成回复，消息已入队。队列长度: ${messageQueue.length}`);
        // 即时模式下给玩家一个提示（缓冲模式静默收集）
        if (getSettings().defaultMode === 'instant' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ai_reply',
                chatId: item.chatId,
                text: '⏳ AI正在生成回复中，您的消息已加入队列，将在当前回复完成后处理。',
            }));
        }
        return;
    }
    processMessage(item);
}

/**
 * 处理队列中的下一条消息
 */
function processNextFromQueue() {
    const next = messageQueue.shift();
    if (!next) return;
    console.log(`[Telegram Bridge] 处理队列消息，剩余队列长度: ${messageQueue.length}`);
    processMessage(next);
}

/**
 * 缓冲模式：把玩家消息加入缓冲区
 */
function addToBuffer(item) {
    if (!buffer || buffer.chatId !== item.chatId) {
        // 已有其他群组的缓冲，先冲刷
        if (buffer) flushBuffer();
        buffer = { chatId: item.chatId, parts: [], timer: null };
    }
    const prefixed = item.isGroup ? applyUserPrefix(item.username, item.text) : item.text;
    buffer.parts.push(prefixed);
    buffer.lastActivity = Date.now();
    console.log(`[Telegram Bridge] 缓冲消息 (${buffer.parts.length}/${getSettings().bufferMaxMessages})，来自: ${item.username || '未知用户'}`);

    // 达到最大条数，立即触发
    if (buffer.parts.length >= getSettings().bufferMaxMessages) {
        flushBuffer();
        return;
    }
    // 重置窗口定时器
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(flushBuffer, (getSettings().bufferWindowSeconds || 30) * 1000);
}

/**
 * 冲刷缓冲区：把收集到的多条玩家消息合并为一条发送给 AI
 */
function flushBuffer() {
    if (!buffer) return;
    const b = buffer;
    buffer = null;
    if (b.timer) clearTimeout(b.timer);
    const text = b.parts.join('\n');
    console.log(`[Telegram Bridge] 冲刷缓冲区 (${b.parts.length} 条消息) → 发送给 AI`);
    enqueueOrProcess({ chatId: b.chatId, text, username: null, isGroup: false });
}

/**
 * 实际处理一条（或一批）玩家消息：注入 ST 并触发生成
 * @param {object} item - { chatId, text, username, isGroup }
 */
async function processMessage(item) {
    const { eventSource, event_types, generate } = SillyTavern.getContext();

    // 标记开始生成
    isGenerating = true;
    lastProcessedChatId = item.chatId;

    // 1. 立即向Telegram发送"输入中"状态
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'typing_action', chatId: item.chatId }));
    }

    // 2. 将用户消息添加到SillyTavern
    //    - Multiplayer 且来自群组时，添加玩家名前缀
    //    - 缓冲模式冲刷出的合并消息（username=null）不再重复加前缀
    let messageText = item.text;
    if (item.username && item.isGroup && getSettings().multiplayerEnabled) {
        messageText = applyUserPrefix(item.username, item.text);
    }
    try {
        await sendMessageAsUser(messageText);
    } catch (err) {
        console.error('[Telegram Bridge] sendMessageAsUser() 错误:', err);
        isGenerating = false;
        lastProcessedChatId = null;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error_message',
                chatId: item.chatId,
                text: `抱歉，消息注入失败: ${err.message || '未知错误'}`,
            }));
        }
        setTimeout(processNextFromQueue, 200);
        return;
    }

    // 3. 设置流式传输的回调
    const streamCallback = (...args) => {
        let cumulativeText = '';
        if (typeof args[0] === 'string') {
            cumulativeText = args[0];
        } else if (args[0] && typeof args[0].text === 'string') {
            cumulativeText = args[0].text;
        } else if (args[0] && typeof args[0].message === 'string') {
            cumulativeText = args[0].message;
        }
        if (ws && ws.readyState === WebSocket.OPEN && cumulativeText) {
            ws.send(JSON.stringify({
                type: 'stream_chunk',
                chatId: item.chatId,
                text: cumulativeText,
            }));
        }
    };
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

    // 4. 清理函数：生成结束（成功/失败/手动停止）后执行
    const cleanup = () => {
        eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
        if (ws && ws.readyState === WebSocket.OPEN) {
            if (!item.error) {
                ws.send(JSON.stringify({ type: 'stream_end', chatId: item.chatId }));
            }
        }
    };

    // 5. 监听生成结束事件（once，避免干扰后续消息）
    //    注意：Generate 报错时 GENERATION_ENDED 也会触发，且 catch 分支也会走到这里，
    //    因此用 nextScheduled 标志保证队列只被调度一次，避免并发处理两条消息。
    let nextScheduled = false;
    const scheduleNextOnce = () => {
        if (nextScheduled) return;
        nextScheduled = true;
        isGenerating = false;
        lastProcessedChatId = null;
        // 等 handleFinalMessage 的 DOM 提取完成（约100ms）后再处理下一条
        setTimeout(processNextFromQueue, 250);
    };
    const scheduleNext = () => {
        cleanup();
        scheduleNextOnce();
    };
    eventSource.once(event_types.GENERATION_ENDED, scheduleNext);
    eventSource.once(event_types.GENERATION_STOPPED, scheduleNext);

    // 6. 触发生成
    try {
        const abortController = new AbortController();
        setExternalAbortController(abortController);
        await generate('normal', { signal: abortController.signal });
    } catch (error) {
        console.error("[Telegram Bridge] generate() 错误:", error);
        item.error = true;

        // a. 从聊天记录中删除导致错误的用户消息
        try {
            const { deleteLastMessage } = SillyTavern.getContext();
            await deleteLastMessage();
            console.log('[Telegram Bridge] 已删除导致错误的用户消息。');
        } catch (delErr) {
            console.error('[Telegram Bridge] 删除消息失败:', delErr);
        }

        // b. 发送错误信息
        const errorMessage = `抱歉，AI生成回复时遇到错误。\n您的上一条消息已被撤回，请重试或发送不同内容。\n\n错误详情: ${error.message || '未知错误'}`;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error_message',
                chatId: item.chatId,
                text: errorMessage,
            }));
        }

        // 清理并调度下一条（nextScheduled 保证只调度一次）
        scheduleNext();
    }
}

// --- WebSocket 连接 ---

function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[Telegram Bridge] 已连接');
        return;
    }
    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('URL 未设置！', 'red');
        return;
    }
    updateStatus('连接中...', 'orange');
    console.log(`[Telegram Bridge] 正在连接 ${settings.bridgeUrl}...`);

    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        console.log('[Telegram Bridge] 连接成功！');
        updateStatus('已连接', 'green');
        resetReconnectState();
        resetHeartbeatTimeout();
    };

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);

            // --- 心跳消息处理 ---
            if (data.type === 'heartbeat') {
                handleHeartbeat(data);
                return;
            }

            // --- 用户消息处理 ---
            if (data.type === 'user_message') {
                console.log('[Telegram Bridge] 收到用户消息。', data);

                const item = {
                    chatId: data.chatId,
                    text: data.text,
                    username: data.username || null,
                    isGroup: data.isGroup === true,
                };

                const settings = getSettings();

                // 缓冲模式：群组多人消息先进缓冲区
                if (settings.multiplayerEnabled && settings.defaultMode === 'buffered' && item.isGroup) {
                    addToBuffer(item);
                    return;
                }

                // 即时模式（或非群组/未启用多人）：入队或直接处理
                enqueueOrProcess(item);
                return;
            }

            // --- 系统命令处理 ---
            if (data.type === 'system_command') {
                console.log('[Telegram Bridge] 收到系统命令', data);
                if (data.command === 'reload_ui_only') {
                    console.log('[Telegram Bridge] 正在刷新UI...');
                    setTimeout(reloadPage, 500);
                }
                return;
            }

            // --- 执行命令处理 ---
            if (data.type === 'execute_command') {
                console.log('[Telegram Bridge] 执行命令', data);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }
                await handleExecuteCommand(data);
                return;
            }
        } catch (error) {
            console.error('[Telegram Bridge] 处理请求时发生错误：', error);
            if (data && data.chatId && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error_message', chatId: data.chatId, text: '处理您的请求时发生了一个内部错误。' }));
            }
        }
    };

    ws.onclose = () => {
        console.log('[Telegram Bridge] 连接已关闭。');
        clearHeartbeatTimeout();
        ws = null;
        const settings = getSettings();
        if (settings.autoConnect && !isReconnecting) {
            updateStatus('连接已断开，准备重连...', 'orange');
            attemptReconnect();
        } else {
            updateStatus('连接已断开', 'red');
        }
    };

    ws.onerror = (error) => {
        console.error('[Telegram Bridge] WebSocket 错误：', error);
        clearHeartbeatTimeout();
        updateStatus('连接错误', 'red');
    };
}

function disconnect() {
    cancelReconnect();
    if (ws) {
        ws.close();
    }
}

/**
 * 执行来自 Telegram 的命令（角色/聊天管理）
 */
async function handleExecuteCommand(data) {
    const {
        characters,
        characterId,
        selectCharacterById,
        openCharacterChat,
    } = SillyTavern.getContext();

    let replyText = '命令执行失败，请稍后重试。';
    let commandSuccess = false;

    try {
        switch (data.command) {
            case 'new':
                await doNewChat({ deleteCurrentChat: false });
                replyText = '新的聊天已经开始。';
                commandSuccess = true;
                break;

            case 'listchars': {
                const charList = characters.slice(1);
                if (charList.length > 0) {
                    const PAGE_SIZE = 10;
                    const pageArg = data.args && data.args[0] ? parseInt(data.args[0]) : 1;
                    const page = isNaN(pageArg) ? 1 : pageArg;
                    const totalPages = Math.ceil(charList.length / PAGE_SIZE);
                    const currentPage = Math.max(1, Math.min(page, totalPages));
                    const startIndex = (currentPage - 1) * PAGE_SIZE;
                    const endIndex = Math.min(startIndex + PAGE_SIZE, charList.length);
                    const pageChars = charList.slice(startIndex, endIndex);

                    replyText = `📋 角色 (${currentPage}/${totalPages}页)\n`;
                    pageChars.forEach((char, index) => {
                        const globalIndex = startIndex + index + 1;
                        const charName = char.name.length > 20 ? char.name.substring(0, 20) + '..' : char.name;
                        replyText += `${globalIndex}. ${charName}\n`;
                    });
                    replyText += `\n切换: /switchchar_数字`;

                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'ai_reply',
                            chatId: data.chatId,
                            text: replyText,
                            pagination: { currentPage, totalPages, type: 'listchars' }
                        }));
                    }
                    return;
                }
                replyText = '没有找到可用角色。';
                commandSuccess = true;
                break;
            }

            case 'switchchar': {
                if (!data.args || data.args.length === 0) {
                    replyText = '请提供角色名称或序号。用法: /switchchar <角色名称> 或 /switchchar_数字';
                    break;
                }
                const targetName = data.args.join(' ');
                const targetChar = characters.find(c => c.name === targetName);
                if (targetChar) {
                    const charIndex = characters.indexOf(targetChar);
                    await selectCharacterById(charIndex);
                    replyText = `已成功切换到角色 "${targetName}"。`;
                    commandSuccess = true;
                } else {
                    replyText = `角色 "${targetName}" 未找到。`;
                }
                break;
            }

            case 'listchats': {
                if (characterId === undefined) {
                    replyText = '群组聊天中不可用，请先单独选择一个角色。';
                    break;
                }
                const chatFiles = await getPastCharacterChats(characterId);
                if (chatFiles.length > 0) {
                    const CHAT_PAGE_SIZE = 10;
                    const chatPageArg = data.args && data.args[0] ? parseInt(data.args[0]) : 1;
                    const chatPage = isNaN(chatPageArg) ? 1 : chatPageArg;
                    const chatTotalPages = Math.ceil(chatFiles.length / CHAT_PAGE_SIZE);
                    const chatCurrentPage = Math.max(1, Math.min(chatPage, chatTotalPages));
                    const chatStartIndex = (chatCurrentPage - 1) * CHAT_PAGE_SIZE;
                    const chatEndIndex = Math.min(chatStartIndex + CHAT_PAGE_SIZE, chatFiles.length);
                    const pageChats = chatFiles.slice(chatStartIndex, chatEndIndex);

                    replyText = `💬 聊天 (${chatCurrentPage}/${chatTotalPages}页)\n`;
                    pageChats.forEach((chat, index) => {
                        const globalIndex = chatStartIndex + index + 1;
                        let chatName = chat.file_name.replace('.jsonl', '');
                        chatName = chatName.length > 20 ? chatName.substring(0, 20) + '..' : chatName;
                        replyText += `${globalIndex}. ${chatName}\n`;
                    });
                    replyText += `\n切换: /switchchat_数字`;

                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'ai_reply',
                            chatId: data.chatId,
                            text: replyText,
                            pagination: { currentPage: chatCurrentPage, totalPages: chatTotalPages, type: 'listchats' }
                        }));
                    }
                    return;
                }
                replyText = '当前角色没有任何聊天记录。';
                commandSuccess = true;
                break;
            }

            case 'switchchat': {
                if (!data.args || data.args.length === 0) {
                    replyText = '请提供聊天记录名称。用法： /switchchat <聊天记录名称>';
                    break;
                }
                const targetChatFile = data.args.join(' ');
                try {
                    await openCharacterChat(targetChatFile);
                    replyText = `已加载聊天记录： ${targetChatFile}`;
                    commandSuccess = true;
                } catch (err) {
                    console.error(err);
                    replyText = `加载聊天记录 "${targetChatFile}" 失败。请确认名称完全正确。`;
                }
                break;
            }

            default: {
                const charMatch = data.command.match(/^switchchar_(\d+)$/);
                if (charMatch) {
                    const index = parseInt(charMatch[1]) - 1;
                    const charList = characters.slice(1);
                    if (index >= 0 && index < charList.length) {
                        const targetChar = charList[index];
                        const charIndex = characters.indexOf(targetChar);
                        await selectCharacterById(charIndex);
                        replyText = `已切换到角色 "${targetChar.name}"。`;
                        commandSuccess = true;
                    } else {
                        replyText = `无效的角色序号: ${index + 1}。请使用 /listchars 查看可用角色。`;
                    }
                    break;
                }

                const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                if (chatMatch) {
                    if (characterId === undefined) {
                        replyText = '群组聊天中不可用，请先单独选择一个角色。';
                        break;
                    }
                    const index = parseInt(chatMatch[1]) - 1;
                    const chatFiles = await getPastCharacterChats(characterId);
                    if (index >= 0 && index < chatFiles.length) {
                        const targetChat = chatFiles[index];
                        const chatName = targetChat.file_name.replace('.jsonl', '');
                        try {
                            await openCharacterChat(chatName);
                            replyText = `已加载聊天记录： ${chatName}`;
                            commandSuccess = true;
                        } catch (err) {
                            console.error(err);
                            replyText = '加载聊天记录失败。';
                        }
                    } else {
                        replyText = `无效的聊天记录序号: ${index + 1}。请使用 /listchats 查看可用聊天记录。`;
                    }
                    break;
                }

                replyText = `未知命令: /${data.command}。使用 /help 查看所有命令。`;
            }
        }
    } catch (error) {
        console.error('[Telegram Bridge] 执行命令时出错:', error);
        replyText = `执行命令时出错: ${error.message || '未知错误'}`;
    }

    // 发送命令执行结果
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: replyText }));
        ws.send(JSON.stringify({
            type: 'command_executed',
            command: data.command,
            success: commandSuccess,
            message: replyText
        }));
    }
}

// --- DOM 文本提取（用于获取最终渲染后的消息） ---

function extractTextFromDOM(messageTextElement) {
    const clone = messageTextElement.clone();
    clone.find('br').replaceWith('\n');
    clone.find('p').each(function () {
        $(this).prepend('\n\n').append('\n\n');
    });
    clone.find('div').each(function () {
        $(this).append('\n');
    });
    clone.find('b, strong').each(function () {
        const text = $(this).text();
        $(this).replaceWith(`**${text}**`);
    });
    clone.find('i, em').each(function () {
        const text = $(this).text();
        $(this).replaceWith(`*${text}*`);
    });
    clone.find('code').each(function () {
        const text = $(this).text();
        if (text.includes('\n')) {
            $(this).replaceWith(`\`\`\`\n${text}\n\`\`\``);
        } else {
            $(this).replaceWith(`\`${text}\``);
        }
    });
    clone.find('pre').each(function () {
        const text = $(this).text();
        $(this).replaceWith(`\`\`\`\n${text}\n\`\`\``);
    });
    let text = clone.text();
    text = decodeHtmlEntities(text);
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

function decodeHtmlEntities(text) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = text;
    return tempDiv.textContent || tempDiv.innerText || '';
}

// --- 最终消息处理 ---

function handleFinalMessage(lastMessageIdInChatArray) {
    console.log(`[Telegram Bridge] handleFinalMessage 被调用, lastMessageId: ${lastMessageIdInChatArray}, lastProcessedChatId: ${lastProcessedChatId}`);

    if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) {
        return;
    }

    // GENERATION_ENDED 传 chat.length；GENERATION_STOPPED 不传参数，回退到 chat 数组
    let lastMessageIndex;
    if (typeof lastMessageIdInChatArray === 'number' && lastMessageIdInChatArray > 0) {
        lastMessageIndex = lastMessageIdInChatArray - 1;
    } else {
        const currentChat = SillyTavern.getContext().chat;
        lastMessageIndex = Array.isArray(currentChat) ? currentChat.length - 1 : -1;
    }
    if (lastMessageIndex < 0) return;

    const chatIdToSend = lastProcessedChatId;

    setTimeout(() => {
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            let renderedText = null;

            // 优先从 DOM 提取渲染后的文本（保留格式标记）
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);
            if (messageElement.length > 0) {
                const messageTextElement = messageElement.find('.mes_text');
                if (messageTextElement.length > 0) {
                    renderedText = extractTextFromDOM(messageTextElement);
                }
            }

            // DOM 提取失败时回退到 chat 数组中的原始文本
            if (!renderedText && typeof lastMessage.mes === 'string') {
                console.log('[Telegram Bridge] DOM提取失败，回退到 chat 原始文本');
                renderedText = lastMessage.mes.trim();
            }

            if (renderedText) {
                console.log(`[Telegram Bridge] 捕获到最终文本，发送更新到 chatId: ${chatIdToSend}`);
                ws.send(JSON.stringify({
                    type: 'final_message_update',
                    chatId: chatIdToSend,
                    text: renderedText,
                }));
            }
        }

        // 重置当前会话标识（不管成功与否）
        if (lastProcessedChatId === chatIdToSend) {
            lastProcessedChatId = null;
        }
    }, 100);
}

// --- 会话清理 ---

function cleanupStreamSession() {
    console.log('[Telegram Bridge] 检测到角色/聊天切换，清理流式会话状态');
    isGenerating = false;
    if (buffer) {
        if (buffer.timer) clearTimeout(buffer.timer);
        buffer = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN && lastProcessedChatId) {
        ws.send(JSON.stringify({
            type: 'cleanup_session',
            chatId: lastProcessedChatId,
        }));
        console.log(`[Telegram Bridge] 已发送清理消息到 chatId: ${lastProcessedChatId}`);
    }
    lastProcessedChatId = null;
}

// --- 设置界面 ---

async function loadSettingsUI() {
    console.log('[Telegram Bridge] 正在尝试加载设置 UI...');
    const { renderExtensionTemplateAsync } = SillyTavern.getContext();

    // 从自身模块 URL 推导扩展文件夹名（兼容第三方目录与用户级安装）
    let settingsHtml = null;
    try {
        const url = new URL('.', import.meta.url).href;
        const match = url.match(/\/scripts\/extensions\/(.+?)\/$/);
        if (match && renderExtensionTemplateAsync) {
            const folder = match[1];
            console.log(`[Telegram Bridge] 扩展文件夹: ${folder}`);
            settingsHtml = await renderExtensionTemplateAsync(folder, 'settings');
        }
    } catch (error) {
        console.warn('[Telegram Bridge] renderExtensionTemplateAsync 失败，尝试直接加载:', error);
    }

    // 回退：直接 fetch settings.html
    if (!settingsHtml) {
        const settingsUrl = new URL('settings.html', import.meta.url).href;
        const response = await fetch(settingsUrl);
        settingsHtml = await response.text();
    }

    $('#extensions_settings').append(settingsHtml);
    console.log('[Telegram Bridge] 设置 UI 已添加。');

    bindSettingsUI();
}

function bindSettingsUI() {
    const settings = getSettings();
    const { saveSettingsDebounced } = SillyTavern.getContext();

    $('#telegram_bridge_url').val(settings.bridgeUrl);
    $('#telegram_auto_connect').prop('checked', settings.autoConnect);
    $('#telegram_multiplayer_enabled').prop('checked', settings.multiplayerEnabled);
    $('#telegram_user_prefix').val(settings.userPrefix);
    $('#telegram_default_mode').val(settings.defaultMode);
    $('#telegram_buffer_window').val(settings.bufferWindowSeconds);
    $('#telegram_buffer_max').val(settings.bufferMaxMessages);

    $('#telegram_bridge_url').on('input', () => {
        getSettings().bridgeUrl = $('#telegram_bridge_url').val();
        saveSettingsDebounced();
    });

    $('#telegram_auto_connect').on('change', function () {
        getSettings().autoConnect = $(this).prop('checked');
        console.log(`[Telegram Bridge] 自动连接设置已更改为: ${getSettings().autoConnect}`);
        saveSettingsDebounced();
    });

    $('#telegram_multiplayer_enabled').on('change', function () {
        getSettings().multiplayerEnabled = $(this).prop('checked');
        console.log(`[Telegram Bridge] Multiplayer 模式: ${getSettings().multiplayerEnabled ? '启用' : '关闭'}`);
        // 切换时清空缓冲
        if (buffer) {
            if (buffer.timer) clearTimeout(buffer.timer);
            buffer = null;
        }
        saveSettingsDebounced();
    });

    $('#telegram_user_prefix').on('change', function () {
        getSettings().userPrefix = $(this).val();
        console.log(`[Telegram Bridge] 用户前缀格式: ${getSettings().userPrefix}`);
        saveSettingsDebounced();
    });

    $('#telegram_default_mode').on('change', function () {
        getSettings().defaultMode = $(this).val();
        console.log(`[Telegram Bridge] 默认模式: ${getSettings().defaultMode}`);
        if (buffer) {
            if (buffer.timer) clearTimeout(buffer.timer);
            buffer = null;
        }
        saveSettingsDebounced();
    });

    $('#telegram_buffer_window').on('change', function () {
        const value = parseInt($(this).val());
        getSettings().bufferWindowSeconds = isNaN(value) || value <= 0 ? 30 : value;
        saveSettingsDebounced();
    });

    $('#telegram_buffer_max').on('change', function () {
        const value = parseInt($(this).val());
        getSettings().bufferMaxMessages = isNaN(value) || value <= 0 ? 8 : value;
        saveSettingsDebounced();
    });

    $('#telegram_connect_button').on('click', connect);
    $('#telegram_disconnect_button').on('click', disconnect);

    if (settings.autoConnect) {
        console.log('[Telegram Bridge] 自动连接已启用，正在连接...');
        connect();
    }
}

// --- 生命周期钩子（官方推荐） ---

export function onActivate() {
    console.log('[Telegram Bridge] 扩展激活 (onActivate)');
    const { eventSource, event_types } = SillyTavern.getContext();

    // 全局事件监听器：生成结束后发送最终渲染文本
    eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);
    eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);

    // 角色/聊天切换时清理流式会话状态
    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log('[Telegram Bridge] 检测到聊天切换');
        cleanupStreamSession();
    });

    // APP_READY 后执行异步初始化（加载设置UI、自动连接）
    // 用 setTimeout 延迟，避免阻塞 APP_READY 事件处理器
    // 使用 on + removeListener 而非 once，保证无论 APP_READY 是否已触发过都能执行
    const onAppReady = () => {
        eventSource.removeListener(event_types.APP_READY, onAppReady);
        setTimeout(async () => {
            try {
                await loadSettingsUI();
            } catch (error) {
                console.error('[Telegram Bridge] 加载设置 UI 失败。', error);
            }
            console.log('[Telegram Bridge] 扩展已加载。');
        }, 0);
    };
    eventSource.on(event_types.APP_READY, onAppReady);
}
