// SillyTavern Server Plugin: Telegram Bridge（启动器模式）
//
// 本插件不再在酒馆进程内实现 Telegram Bot / WebSocket 桥接（内置 Server 已移除，
// 避免与独立版 server.js 双实例轮询同一 token 造成回环）。
// 它只负责从 Web 界面启动/停止独立版桥接服务器（server/server.js），
// 前端扩展通过 /api/plugins/telegram-bridge/status 自动发现端口并连接。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PLUGIN_ID = 'telegram-bridge';
const CONFIG_FILE = path.join(__dirname, 'config.json');
// 独立版服务器路径：默认仓库布局 plugins/telegram-bridge → server/server.js
const DEFAULT_SERVER_PATH = path.join(__dirname, '..', '..', 'server', 'server.js');
const DEFAULT_WSS_PORT = 2333;

let express = null;
try { express = require('express'); } catch (e) { /* 仅在非酒馆环境出现 */ }

// --- 运行时状态 ---
let child = null;      // 独立版 server.js 子进程
let wssPort = DEFAULT_WSS_PORT;

// --- 工具 ---

function logWithTimestamp(level, ...args) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const prefix = `[${ts}] [TG-Bridge]`;
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
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

function resolveServerPath() {
    const cfg = readConfig();
    const p = process.env.BRIDGE_SERVER_PATH || cfg.serverPath || DEFAULT_SERVER_PATH;
    return path.resolve(p);
}

function isRunning() {
    return !!(child && child.exitCode === null && !child.killed);
}

async function stopServer() {
    if (!child) return;
    logWithTimestamp('log', '正在停止独立版服务器...');
    const proc = child;
    child = null;
    proc.kill('SIGTERM');
    // 5 秒内未退出则强杀
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 5000);
    await new Promise((resolve) => {
        proc.once('exit', () => { clearTimeout(killer); resolve(); });
        // 进程可能已退出，兜底
        setTimeout(resolve, 6000);
    });
    logWithTimestamp('log', '独立版服务器已停止');
}

async function startServer(token, extraEnv = {}) {
    await stopServer();
    if (!token) {
        throw new Error('未配置 Telegram Bot Token');
    }
    const serverPath = resolveServerPath();
    if (!fs.existsSync(serverPath)) {
        throw new Error(`未找到独立版服务器: ${serverPath}。请在插件 config.json 中设置 serverPath，或设置环境变量 BRIDGE_SERVER_PATH`);
    }

    const cfg = readConfig();
    wssPort = parseInt(process.env.WSS_PORT) || parseInt(extraEnv.WSS_PORT) || parseInt(cfg.wssPort) || DEFAULT_WSS_PORT;

    const env = Object.assign({}, process.env, {
        TELEGRAM_BOT_TOKEN: token,
        WSS_PORT: String(wssPort),
    });
    // 透传可选配置
    if (process.env.ALLOWED_USER_IDS) env.ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS;
    if (process.env.ALLOWED_CHAT_IDS) env.ALLOWED_CHAT_IDS = process.env.ALLOWED_CHAT_IDS;
    if (process.env.MESSAGE_PARSE_MODE) env.MESSAGE_PARSE_MODE = process.env.MESSAGE_PARSE_MODE;

    logWithTimestamp('log', `启动独立版服务器: ${serverPath} (端口 ${wssPort})`);
    child = spawn(process.execPath, [serverPath], {
        cwd: path.dirname(serverPath),
        env,
        stdio: 'inherit',
        detached: false,
    });
    child.on('exit', (code, signal) => {
        logWithTimestamp('warn', `独立版服务器已退出 (code=${code}, signal=${signal})`);
        child = null;
    });
    child.on('error', (err) => {
        logWithTimestamp('error', '启动独立版服务器失败:', err.message);
        child = null;
    });
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
            await startServer(token);
        } catch (e) {
            logWithTimestamp('error', '自动启动独立版服务器失败:', e.message);
        }
    } else {
        logWithTimestamp('warn', '未配置 Telegram Bot Token。可在扩展设置面板中填写保存，然后点击「启动 Server」。');
    }

    // 状态查询（前端扩展用来自动发现端口）
    router.get('/status', (req, res) => {
        res.json({
            running: isRunning(),
            wssPort,
            configured: !!(process.env.TELEGRAM_BOT_TOKEN || readConfig().telegramToken),
            pluginPath: __dirname,
        });
    });

    // Token/配置保存（前端扩展设置面板写入）
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

    // 启动独立版服务器
    router.post('/start', jsonBody, async (req, res) => {
        const cfg = readConfig();
        const token = process.env.TELEGRAM_BOT_TOKEN || cfg.telegramToken || (req.body && req.body.telegramToken);
        if (!token) {
            res.status(400).json({ ok: false, error: '未配置 Token' });
            return;
        }
        try {
            await startServer(token, req.body || {});
            res.json({ ok: true, wssPort });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 停止独立版服务器
    router.post('/stop', async (req, res) => {
        try {
            await stopServer();
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    logWithTimestamp('log', 'Telegram Bridge Server 插件已加载（启动器模式）');
    return Promise.resolve();
}

async function exit() {
    await stopServer();
    return Promise.resolve();
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'Telegram Bridge (Server 启动器)',
        description: '从 Web 界面启动/停止独立版 Telegram Bridge 服务器（server/server.js），不再在酒馆进程内运行桥接。',
    },
};
