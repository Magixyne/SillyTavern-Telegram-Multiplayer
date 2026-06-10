// index.js

// 只解构 getContext() 返回的对象中确实存在的属性
const {
    extensionSettings,
    deleteLastMessage, // 导入删除最后一条消息的函数
    saveSettingsDebounced, // 导入保存设置的函数
} = SillyTavern.getContext();

// getContext 函数是全局 SillyTavern 对象的一部分，我们不需要从别处导入它
// 在需要时直接调用 SillyTavern.getContext() 即可

// 从 script.js 导入所有需要的公共API函数
import {
    eventSource,
    event_types,
    getPastCharacterChats,
    sendMessageAsUser,
    doNewChat,
    selectCharacterById,
    openCharacterChat,
    Generate,
    setExternalAbortController,
    getRequestHeaders,
    characters,
} from "../../../../script.js";

import {
    oai_settings,
    openai_settings,
    openai_setting_names,
    chat_completion_sources,
} from "../../../../scripts/openai.js";

import {
    SECRET_KEYS,
    writeSecret,
} from "../../../../scripts/secrets.js";

const MODULE_NAME = 'SillyTavern-Telegram-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
};

let ws = null; // WebSocket实例
let lastProcessedChatId = null; // 用于存储最后处理过的Telegram chatId

// 添加一个全局变量来跟踪当前是否处于流式模式
let isStreamingMode = false;

// 添加一个全局变量来跟踪当前是否正在生成回复
let isGenerating = false;

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
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
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
 * 重置心跳超时定时器
 * 每次收到心跳消息时调用，重新开始45秒倒计时
 */
function resetHeartbeatTimeout() {
    // 清除旧的超时定时器
    if (heartbeatTimeoutTimer) {
        clearTimeout(heartbeatTimeoutTimer);
    }

    lastHeartbeatTime = Date.now();

    // 设置新的超时定时器
    heartbeatTimeoutTimer = setTimeout(() => {
        console.log('[Telegram Bridge] 心跳超时，连接可能已断开');
        updateStatus('连接超时', 'red');
        // 标记连接断开并触发重连
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
 * @param {Object} data - 心跳消息数据
 */
function handleHeartbeat(data) {
    console.log('[Telegram Bridge] 收到心跳包');

    // 重置超时定时器
    resetHeartbeatTimeout();

    // 发送心跳响应
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'heartbeat_ack',
            timestamp: data.timestamp
        }));
    }
}

/**
 * 尝试自动重连
 * 最多重试3次，每次间隔5秒
 */
function attemptReconnect() {
    // 如果已经在重连中或达到最大重试次数，则不再尝试
    if (isReconnecting) {
        return;
    }

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

    // 清除可能存在的旧重连定时器
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
        isReconnecting = false;
        console.log(`[Telegram Bridge] 正在尝试第${reconnectAttempts}次重连...`);
        connect();
    }, RECONNECT_DELAY);
}

/**
 * 重置重连状态
 * 连接成功时调用
 */
function resetReconnectState() {
    reconnectAttempts = 0;
    isReconnecting = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

/**
 * 取消重连
 * 手动断开连接时调用
 */
function cancelReconnect() {
    resetReconnectState();
    console.log('[Telegram Bridge] 已取消自动重连');
}

function reloadPage() {
    window.location.reload();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getBridgeConfig(data = {}) {
    return data.bridgeConfig || { models: {}, profiles: {}, options: {} };
}

function sendBridgeReply(chatId, text, replyMarkup = null) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = { type: 'ai_reply', chatId, text };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    ws.send(JSON.stringify(payload));
}

function base64ToFile(base64, fileName) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], fileName);
}

function safePresetName(fileName) {
    return String(fileName || 'Imported Preset').replace(/\.[^/.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'Imported Preset';
}

function uniquePresetName(baseName) {
    let name = baseName;
    let i = 1;
    while (Object.prototype.hasOwnProperty.call(openai_setting_names, name)) {
        name = `${baseName}_${i++}`;
    }
    return name;
}

async function importBridgeCharacterUpload(upload, switchAfter = false) {
    const file = base64ToFile(upload.dataBase64, upload.fileName);
    const ext = String(upload.fileName || '').split('.').pop().toLowerCase();
    if (!['png', 'json'].includes(ext)) throw new Error(`Unsupported character file: ${ext}`);
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', ext);
    formData.append('preserved_name', safePresetName(upload.fileName));
    const result = await fetch('/api/characters/import', {
        method: 'POST',
        body: formData,
        headers: getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });
    if (!result.ok) throw new Error(`Import failed: HTTP ${result.status}`);
    const data = await result.json();
    if (data.error || !data.file_name) throw new Error('SillyTavern rejected the character file');

    if (switchAfter) {
        await sleep(800);
        const avatarName = `${data.file_name}.png`;
        const index = characters.findIndex(c => c.avatar === avatarName || c.name === data.file_name);
        if (index >= 0) {
            await selectCharacterById(index);
        } else {
            // Fallback: reload to refresh the character list if the imported card is not in the in-memory list yet.
            setTimeout(() => window.location.reload(), 1200);
        }
    } else {
        setTimeout(() => window.location.reload(), 1200);
    }
    return `${data.file_name}.png`;
}

async function importBridgeOpenAIPresetUpload(upload, switchAfter = false) {
    const text = atob(upload.dataBase64);
    let presetBody;
    try {
        presetBody = JSON.parse(text);
    } catch (error) {
        throw new Error('Invalid JSON preset');
    }
    const sensitiveFields = ['api_key', 'api_key_openai', 'api_key_custom', 'custom_url', 'proxy_password', 'reverse_proxy', 'chat_completion_proxy'];
    // For Telegram import, remove endpoint/key-like fields by default. Connection profile switching manages keys separately.
    sensitiveFields.forEach(field => {
        if (Object.prototype.hasOwnProperty.call(presetBody, field)) delete presetBody[field];
    });
    const name = uniquePresetName(safePresetName(upload.fileName));
    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ apiId: 'openai', name, preset: presetBody }),
    });
    if (!response.ok) throw new Error(`Preset save failed: HTTP ${response.status}`);
    const data = await response.json();
    if (switchAfter) {
        openai_settings.push(presetBody);
        openai_setting_names[data.name] = openai_settings.length - 1;
        oai_settings.preset_settings_openai = data.name;
        const option = document.createElement('option');
        option.selected = true;
        option.value = String(openai_settings.length - 1);
        option.innerText = data.name;
        $('#settings_preset_openai').append(option).trigger('change');
        saveSettingsDebounced();
    }
    return data.name;
}


function getCurrentModelSelector(source = oai_settings.chat_completion_source) {
    const map = {
        [chat_completion_sources.DEEPSEEK]: { selector: '#model_deepseek_select', setting: 'deepseek_model' },
        [chat_completion_sources.CUSTOM]: { selector: '#model_custom_select', input: '#custom_model_id', setting: 'custom_model' },
        [chat_completion_sources.OPENROUTER]: { selector: '#model_openrouter_select', setting: 'openrouter_model' },
        [chat_completion_sources.OPENAI]: { selector: '#model_openai_select', setting: 'openai_model' },
        [chat_completion_sources.CLAUDE]: { selector: '#model_claude_select', setting: 'claude_model' },
        [chat_completion_sources.MAKERSUITE]: { selector: '#model_google_select', setting: 'google_model' },
        [chat_completion_sources.VERTEXAI]: { selector: '#model_vertexai_select', setting: 'vertexai_model' },
        [chat_completion_sources.GROQ]: { selector: '#model_groq_select', setting: 'groq_model' },
        [chat_completion_sources.MISTRALAI]: { selector: '#model_mistralai_select', setting: 'mistralai_model' },
        [chat_completion_sources.COHERE]: { selector: '#model_cohere_select', setting: 'cohere_model' },
        [chat_completion_sources.PERPLEXITY]: { selector: '#model_perplexity_select', setting: 'perplexity_model' },
        [chat_completion_sources.AIMLAPI]: { selector: '#model_aimlapi_select', setting: 'aimlapi_model' },
        [chat_completion_sources.XAI]: { selector: '#model_xai_select', setting: 'xai_model' },
        [chat_completion_sources.POLLINATIONS]: { selector: '#model_pollinations_select', setting: 'pollinations_model' },
        [chat_completion_sources.MOONSHOT]: { selector: '#model_moonshot_select', setting: 'moonshot_model' },
        [chat_completion_sources.COMETAPI]: { selector: '#model_cometapi_select', setting: 'cometapi_model' },
        [chat_completion_sources.CHUTES]: { selector: '#model_chutes_select', setting: 'chutes_model' },
        [chat_completion_sources.SILICONFLOW]: { selector: '#model_siliconflow_select', setting: 'siliconflow_model' },
        [chat_completion_sources.ELECTRONHUB]: { selector: '#model_electronhub_select', setting: 'electronhub_model' },
        [chat_completion_sources.NANOGPT]: { selector: '#model_nanogpt_select', setting: 'nanogpt_model' },
        [chat_completion_sources.MINIMAX]: { selector: '#model_minimax_select', setting: 'minimax_model' },
        [chat_completion_sources.ZAI]: { selector: '#model_zai_select', setting: 'zai_model' },
        [chat_completion_sources.WORKERS_AI]: { selector: '#model_workers_ai_select', setting: 'workers_ai_model' },
    };
    return map[source] || null;
}

function getCurrentModelId() {
    const source = oai_settings.chat_completion_source;
    const info = getCurrentModelSelector(source);
    if (info?.setting && oai_settings[info.setting]) return oai_settings[info.setting];
    if (source === chat_completion_sources.CUSTOM) return oai_settings.custom_model || $('#custom_model_id').val() || '';
    return '';
}

function discoverCurrentModels() {
    const source = oai_settings.chat_completion_source;
    const info = getCurrentModelSelector(source);
    const models = [];
    if (info?.selector && $(info.selector).length) {
        $(info.selector).find('option').each(function () {
            const value = String($(this).val() || '').trim();
            const label = String($(this).text() || value).trim();
            if (value) models.push({ id: value, label });
        });
    }
    const current = getCurrentModelId();
    if (current && !models.some(m => m.id === current)) {
        models.unshift({ id: current, label: current });
    }
    return { source, models };
}

function normalizeUrlForCompare(value) {
    return String(value || '').replace(/\/+$/, '');
}

function getProviderList(config = null) {
    const configured = Object.entries((config && config.providers) || {})
        .filter(([, provider]) => provider && provider.enabled !== false)
        .map(([id, provider], index) => {
            const source = provider.source || id;
            const customUrl = provider.customUrl || '';
            const current = source === chat_completion_sources.CUSTOM && customUrl
                ? oai_settings.chat_completion_source === chat_completion_sources.CUSTOM && normalizeUrlForCompare(oai_settings.custom_url) === normalizeUrlForCompare(customUrl)
                : source === oai_settings.chat_completion_source;
            return {
                index: index + 1,
                id,
                source,
                customUrl,
                defaultModel: provider.defaultModel || '',
                label: provider.label || id,
                current,
                note: provider.note || '',
            };
        });

    // Default behavior: show only Bridge-configured/imported connection profiles, not every SillyTavern-supported source.
    if (configured.length || config?.options?.providersMode === 'configured') {
        return configured;
    }

    const providers = [];
    const select = $('#chat_completion_source');
    if (!select.length) return providers;
    select.find('option').each(function (index) {
        const id = String($(this).val() || '').trim();
        const label = String($(this).text() || id).trim();
        if (id) providers.push({ index: index + 1, id, source: id, customUrl: '', defaultModel: '', label, current: id === oai_settings.chat_completion_source, note: '' });
    });
    return providers;
}
function findProviderByArg(arg, config = null) {
    const providers = getProviderList(config);
    const text = String(arg || '').trim();
    if (/^\d+$/.test(text)) return providers[Number(text) - 1] || null;
    return providers.find(p =>
        p.id.toLowerCase() === text.toLowerCase()
        || p.source.toLowerCase() === text.toLowerCase()
        || p.label.toLowerCase() === text.toLowerCase()
    ) || null;
}

function parseModelListArgs(args = []) {
    const joined = args.join(' ').trim();
    let page = 1;
    let query = '';
    if (/^\d+$/.test(joined)) {
        page = Number(joined);
    } else {
        query = joined.toLowerCase();
        const last = args[args.length - 1];
        if (args.length > 1 && /^\d+$/.test(last)) {
            page = Number(last);
            query = args.slice(0, -1).join(' ').trim().toLowerCase();
        }
    }
    return { page: Math.max(1, page || 1), query };
}

function getFilteredCurrentProviderModels(args = []) {
    const { page, query } = parseModelListArgs(args);
    const discovered = discoverCurrentModels();
    const filtered = query
        ? discovered.models.filter(m => m.id.toLowerCase().includes(query) || m.label.toLowerCase().includes(query))
        : discovered.models;
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    return {
        source: discovered.source,
        query,
        page: currentPage,
        totalPages,
        pageSize,
        total: filtered.length,
        models: filtered.slice(start, start + pageSize).map((m, i) => ({ ...m, index: start + i + 1 })),
    };
}

function resolveCurrentProviderModelArg(arg, args = []) {
    const text = String(arg || '').trim();
    if (!text) return null;
    const list = getFilteredCurrentProviderModels(args);
    if (/^\d+$/.test(text)) {
        const idx = Number(text);
        return list.models.find(m => m.index === idx) || discoverCurrentModels().models[idx - 1] || null;
    }
    return discoverCurrentModels().models.find(m => m.id === text || m.id.toLowerCase() === text.toLowerCase()) || { id: text, label: text };
}

function getPresetList() {
    const presets = [];
    $('#settings_preset_openai option').each(function (index) {
        const value = String($(this).val() || '').trim();
        const name = String($(this).text() || value).trim();
        if (name) presets.push({ index: index + 1, value, name });
    });
    return presets;
}

function findPresetByArg(arg) {
    const presets = getPresetList();
    const text = String(arg || '').trim();
    if (/^\d+$/.test(text)) return presets[Number(text) - 1] || null;
    return presets.find(p => p.name === text || p.value === text) || null;
}

function getEnabledModelEntries(config) {
    return Object.entries(config.models || {}).filter(([, model]) => model && model.enabled !== false);
}

function resolveModelArg(arg, config) {
    const text = String(arg || '').trim();
    if (!text) return null;
    const entries = getEnabledModelEntries(config);
    const byAlias = entries.find(([alias]) => alias.toLowerCase() === text.toLowerCase());
    if (byAlias) return { alias: byAlias[0], ...byAlias[1] };
    const byModel = entries.find(([, model]) => String(model.model || '').toLowerCase() === text.toLowerCase());
    if (byModel) return { alias: byModel[0], ...byModel[1] };
    if (config.options?.allowDiscoveredModels) {
        const discovered = discoverCurrentModels().models.find(m => m.id.toLowerCase() === text.toLowerCase());
        if (discovered) return { alias: discovered.id, label: discovered.label, source: oai_settings.chat_completion_source, model: discovered.id, enabled: true };
    }
    return null;
}

async function switchChatCompletionSourceIfNeeded(source) {
    if (!source || source === oai_settings.chat_completion_source) return;
    const sourceSelect = $('#chat_completion_source');
    if (!sourceSelect.length) throw new Error('找不到 chat_completion_source 控件');
    if (!sourceSelect.find(`option[value="${source}"]`).length) throw new Error(`当前酒馆不支持源: ${source}`);
    sourceSelect.val(source).trigger('change');
    await sleep(800);
}

async function refreshCurrentProviderModelList(expectedModel = '') {
    if (oai_settings.chat_completion_source !== chat_completion_sources.CUSTOM) {
        return discoverCurrentModels().models.length;
    }

    // Clear stale options from the previous custom endpoint before asking SillyTavern to reconnect.
    $('.model_custom_select').empty().append('<option value="">None</option>');
    $('#api_button_openai').trigger('click');

    const started = Date.now();
    let lastSignature = '';
    let stableSince = 0;
    let lastCount = 0;

    while (Date.now() - started < 15000) {
        await sleep(500);
        const models = discoverCurrentModels().models.filter(m => m.id);
        const signature = models.map(m => m.id).join('|');
        lastCount = models.length;

        if (signature && signature === lastSignature) {
            if (!stableSince) stableSince = Date.now();
            // Wait until the list is stable for at least 1.5s. Do not stop just because the default model appeared.
            if (Date.now() - stableSince >= 1500) {
                return models.length;
            }
        } else {
            lastSignature = signature;
            stableSince = signature ? Date.now() : 0;
        }
    }

    return lastCount;
}


async function applyProviderProfile(provider, selectedSecret = null) {
    await switchChatCompletionSourceIfNeeded(provider.source);

    if (provider.source === chat_completion_sources.CUSTOM) {
        if (provider.customUrl) {
            oai_settings.custom_url = provider.customUrl;
            $('#custom_api_url_text').val(provider.customUrl).trigger('input');
        }
        if (selectedSecret?.apiKey) {
            await writeSecret(SECRET_KEYS.CUSTOM, selectedSecret.apiKey, provider.label || provider.id);
        }
        saveSettingsDebounced();
        await refreshCurrentProviderModelList(provider.defaultModel || '');
    }

    if (provider.defaultModel) {
        await switchModelByDefinition({
            source: provider.source,
            model: provider.defaultModel,
            label: provider.defaultModel,
        });
    } else {
        saveSettingsDebounced();
        await sleep(300);
    }
}

async function switchModelByDefinition(definition) {
    if (!definition?.model) throw new Error('模型定义缺少 model 字段');
    await switchChatCompletionSourceIfNeeded(definition.source);
    const source = oai_settings.chat_completion_source;
    const info = getCurrentModelSelector(source);
    if (!info) throw new Error(`当前源 ${source} 暂不支持 Telegram 切模型`);
    if (source === chat_completion_sources.CUSTOM) {
        if (info.selector && $(info.selector).length) {
            const select = $(info.selector);
            if (!select.find(`option[value="${definition.model}"]`).length) select.append(new Option(definition.model, definition.model));
            select.val(definition.model).trigger('change');
        }
        if (info.input && $(info.input).length) $(info.input).val(definition.model).trigger('input');
        oai_settings.custom_model = definition.model;
    } else {
        if (!$(info.selector).length) throw new Error(`找不到模型控件: ${info.selector}`);
        if (!$(info.selector).find(`option[value="${definition.model}"]`).length) throw new Error(`当前模型列表中未发现: ${definition.model}`);
        $(info.selector).val(definition.model).trigger('change');
        if (info.setting) oai_settings[info.setting] = definition.model;
    }
    saveSettingsDebounced();
    await sleep(300);
    const after = getCurrentModelId();
    if (after !== definition.model) throw new Error(`模型切换后回读不一致: ${after || '(空)'}`);
}

async function switchPresetByNameOrIndex(arg) {
    const preset = findPresetByArg(arg);
    if (!preset) throw new Error(`未找到预设: ${arg}`);
    const select = $('#settings_preset_openai');
    if (!select.length) throw new Error('找不到预设选择控件');
    select.val(preset.value).trigger('change');
    saveSettingsDebounced();
    await sleep(700);
    return preset;
}

function buildStatusText(config) {
    const enabledModels = getEnabledModelEntries(config).map(([alias, m]) => `${alias}: ${m.label || m.model} (${m.model})`);
    const profiles = Object.entries(config.profiles || {}).map(([name, p]) => `${name}: ${p.label || name} / model=${p.modelAlias || p.model || '-'} / preset=${p.preset || '-'}`);
    const providers = getProviderList(config).map(p => `${p.id}: ${p.label} -> ${p.source}${p.current ? ' ← 当前' : ''}`);
    return [
        '📊 Bridge状态', '',
        `当前源：${oai_settings.chat_completion_source}`,
        `当前模型：${getCurrentModelId() || '(未设置)'}`,
        `当前预设：${oai_settings.preset_settings_openai || '(未设置)'}`,
        `连接绑定：${oai_settings.bind_preset_to_connection ? '开启' : '关闭'}`, '',
        `已配置供应商：${providers.length || 0}`,
        ...(providers.length ? providers.map(x => `- ${x}`) : []), '',
        `已启用模型：${enabledModels.length || 0}`,
        ...(enabledModels.length ? enabledModels.map(x => `- ${x}`) : []), '',
        `Profiles：${profiles.length || 0}`,
        ...(profiles.length ? profiles.map(x => `- ${x}`) : []),
    ].join('\n');
}

async function handleBridgeControlCommand(data, context) {
    const config = getBridgeConfig(data);
    const command = data.command;
    const args = data.args || [];

    if (command === 'upload_import_char' || command === 'upload_import_switch') {
        try {
            if (!data.upload) throw new Error('Missing upload payload');
            const fileName = await importBridgeCharacterUpload(data.upload, command === 'upload_import_switch');
            const suffix = command === 'upload_import_switch' ? '\n已尝试切换到该角色。' : '\n角色列表将自动刷新。';
            sendBridgeReply(data.chatId, `已导入角色卡：${fileName}${suffix}`);
        } catch (error) {
            console.error('[Telegram Bridge] character import failed', error);
            sendBridgeReply(data.chatId, `角色卡导入失败：${error.message}`);
        }
        return true;
    }

    if (command === 'upload_import_preset' || command === 'upload_import_preset_switch') {
        try {
            if (!data.upload) throw new Error('Missing upload payload');
            const name = await importBridgeOpenAIPresetUpload(data.upload, command === 'upload_import_preset_switch');
            const suffix = command === 'upload_import_preset_switch' ? '\n已切换到该预设。' : '';
            sendBridgeReply(data.chatId, `已导入 OpenAI 预设：${name}${suffix}`);
        } catch (error) {
            console.error('[Telegram Bridge] preset import failed', error);
            sendBridgeReply(data.chatId, `预设导入失败：${error.message}`);
        }
        return true;
    }

    if (isGenerating && !['models', 'presets', 'profiles', 'providers', 'provider_models', 'provider-models', 'bridge_status'].includes(command)) {
        sendBridgeReply(data.chatId, '当前正在生成回复，请生成完成后再切换模型、预设或Profile。');
        return true;
    }
    if (command === 'providers') {
        const providers = getProviderList(config);
        const buttons = providers.map(p => ({ text: `${p.current ? '✓ ' : ''}${p.label}`, callback_data: `cmd_provider_${p.id}` }));
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
        keyboard.push([{ text: '🧩 当前源模型', callback_data: 'cmd_provider_models' }, { text: '📊 当前状态', callback_data: 'cmd_bridge_status' }]);
        const lines = providers.length ? providers.map(p => `${p.index}. ${p.label} (${p.id})${p.current ? ' ← 当前' : ''}`).join('\n') : '(未发现供应商下拉框)';
        sendBridgeReply(data.chatId, `🔌 连接档案列表\n\n当前源：${oai_settings.chat_completion_source}\n\n${lines}\n\n切换：/provider <ID或序号>`, { inline_keyboard: keyboard });
        return true;
    }

    if (command === 'provider') {
        const arg = args.join(' ');
        const provider = findProviderByArg(arg, config);
        if (!provider) {
            sendBridgeReply(data.chatId, `未找到供应商：${arg}\n请用 /providers 查看当前酒馆已有供应商。`);
            return true;
        }
        await applyProviderProfile(provider, config.selectedProviderSecret);
        const discovered = discoverCurrentModels();
        sendBridgeReply(data.chatId, `已切换连接档案：${provider.label} (${provider.source})\nEndpoint：${provider.customUrl || '(当前供应商默认)'}\n当前模型：${getCurrentModelId() || '(未设置)'}\n当前源发现模型数：${discovered.models.length}\n\n查看模型：/provider-models`);
        return true;
    }

    if (command === 'provider_models' || command === 'provider-models') {
        const list = getFilteredCurrentProviderModels(args);
        const buttons = list.models.map(m => ({ text: `${m.index}. ${m.id === getCurrentModelId() ? '✓ ' : ''}${m.label || m.id}`.slice(0, 60), callback_data: `cmd_provider_model_${m.index}` }));
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 1) keyboard.push([buttons[i]]);
        const nav = [];
        if (list.page > 1) nav.push({ text: '⬅️ 上页', callback_data: `cmd_provider_page_${list.page - 1}` });
        if (list.page < list.totalPages) nav.push({ text: '➡️ 下页', callback_data: `cmd_provider_page_${list.page + 1}` });
        if (nav.length) keyboard.push(nav);
        keyboard.push([{ text: '🔌 供应商', callback_data: 'cmd_providers' }, { text: '📊 当前状态', callback_data: 'cmd_bridge_status' }]);
        const lines = list.models.length ? list.models.map(m => `${m.index}. ${m.id}${m.id === getCurrentModelId() ? ' ← 当前' : ''}`).join('\n') : '(当前供应商未发现模型)';
        const q = list.query ? `\n搜索：${list.query}` : '';
        sendBridgeReply(data.chatId, `🧩 当前供应商模型\n\n供应商：${list.source}\n当前模型：${getCurrentModelId() || '(未设置)'}${q}\n页码：${list.page}/${list.totalPages}，共 ${list.total} 个\n\n${lines}\n\n切换：/provider-model <模型ID或序号>`, { inline_keyboard: keyboard });
        return true;
    }

    if (command === 'provider_model' || command === 'provider-model') {
        const arg = args.join(' ');
        const model = resolveCurrentProviderModelArg(arg, args);
        if (!model?.id) {
            sendBridgeReply(data.chatId, `未找到模型：${arg}\n请用 /provider-models 查看当前供应商模型。`);
            return true;
        }
        await switchModelByDefinition({ source: oai_settings.chat_completion_source, model: model.id, label: model.label || model.id });
        sendBridgeReply(data.chatId, `已切换当前供应商模型：${model.id}\n供应商：${oai_settings.chat_completion_source}\n当前模型：${getCurrentModelId() || '(未设置)'}`);
        return true;
    }

    if (command === 'models') {
        const discovered = discoverCurrentModels();
        const enabled = getEnabledModelEntries(config);
        const buttons = enabled.map(([alias, model]) => ({ text: model.label || alias, callback_data: `cmd_model_${alias}` }));
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
        keyboard.push([{ text: '📊 当前状态', callback_data: 'cmd_bridge_status' }]);
        const enabledLines = enabled.length ? enabled.map(([alias, model], i) => `${i + 1}. ${alias} — ${model.label || model.model} (${model.model})`).join('\n') : '(无)';
        const discoveredLines = discovered.models.length ? discovered.models.map((m, i) => `${i + 1}. ${m.id}${m.id === getCurrentModelId() ? ' ← 当前' : ''}`).join('\n') : '(当前源未发现模型下拉列表)';
        sendBridgeReply(data.chatId, `🤖 模型列表\n\n当前源：${discovered.source}\n当前模型：${getCurrentModelId() || '(未设置)'}\n\n已启用：\n${enabledLines}\n\n当前源发现：\n${discoveredLines}\n\n切换：/model <别名或模型ID>`, { inline_keyboard: keyboard });
        return true;
    }
    if (command === 'model' || /^model_/.test(command)) {
        const arg = command.startsWith('model_') ? command.replace(/^model_/, '') : args.join(' ');
        const model = resolveModelArg(arg, config);
        if (!model) { sendBridgeReply(data.chatId, `未找到或未启用模型：${arg}\n请用 /models 查看可用模型。`); return true; }
        await switchModelByDefinition(model);
        sendBridgeReply(data.chatId, `已切换模型：${model.label || model.alias}\n当前源：${oai_settings.chat_completion_source}\n当前模型：${getCurrentModelId()}`);
        return true;
    }
    if (command === 'presets') {
        const presets = getPresetList();
        const buttons = presets.map(p => ({ text: p.name, callback_data: `cmd_preset_${p.index}` }));
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
        keyboard.push([{ text: '📊 当前状态', callback_data: 'cmd_bridge_status' }]);
        const lines = presets.length ? presets.map(p => `${p.index}. ${p.name}${p.name === oai_settings.preset_settings_openai ? ' ← 当前' : ''}`).join('\n') : '(未发现预设)';
        sendBridgeReply(data.chatId, `🎛️ 预设列表\n\n当前预设：${oai_settings.preset_settings_openai || '(未设置)'}\n连接绑定：${oai_settings.bind_preset_to_connection ? '开启' : '关闭'}\n\n${lines}\n\n切换：/preset <名称> 或 /preset_数字`, { inline_keyboard: keyboard });
        return true;
    }
    if (command === 'preset' || /^preset_\d+$/.test(command)) {
        const arg = command.startsWith('preset_') ? command.replace(/^preset_/, '') : args.join(' ');
        const preset = await switchPresetByNameOrIndex(arg);
        sendBridgeReply(data.chatId, `已切换预设：${preset.name}\n当前模型：${getCurrentModelId() || '(未设置)'}\n连接绑定：${oai_settings.bind_preset_to_connection ? '开启' : '关闭'}`);
        return true;
    }
    if (command === 'profiles') {
        const entries = Object.entries(config.profiles || {});
        const buttons = entries.map(([name, profile]) => ({ text: profile.label || name, callback_data: `cmd_profile_${name}` }));
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
        keyboard.push([{ text: '📊 当前状态', callback_data: 'cmd_bridge_status' }]);
        const lines = entries.length ? entries.map(([name, profile], i) => `${i + 1}. ${name} — ${profile.label || name}\n   model=${profile.modelAlias || profile.model || '-'} preset=${profile.preset || '-'}`).join('\n') : '(无)';
        sendBridgeReply(data.chatId, `⚡ Profile列表\n\n${lines}\n\n切换：/profile <名称>`, { inline_keyboard: keyboard });
        return true;
    }
    if (command === 'profile' || /^profile_/.test(command)) {
        const name = command.startsWith('profile_') ? command.replace(/^profile_/, '') : args.join(' ');
        const profile = (config.profiles || {})[name];
        if (!profile) { sendBridgeReply(data.chatId, `未找到Profile：${name}\n请用 /profiles 查看。`); return true; }
        let preset = null;
        if (profile.preset) preset = await switchPresetByNameOrIndex(profile.preset);
        let modelDef = null;
        if (profile.modelAlias) modelDef = resolveModelArg(profile.modelAlias, config);
        else if (profile.model) modelDef = resolveModelArg(profile.model, config) || { source: profile.source, model: profile.model, label: profile.model };
        if (modelDef) await switchModelByDefinition(modelDef);
        sendBridgeReply(data.chatId, `已切换Profile：${profile.label || name}\n当前源：${oai_settings.chat_completion_source}\n当前模型：${getCurrentModelId() || '(未设置)'}\n当前预设：${preset?.name || oai_settings.preset_settings_openai || '(未设置)'}`);
        return true;
    }
    if (command === 'bridge_status' || command === 'bridge_reload') {
        sendBridgeReply(data.chatId, buildStatusText(config));
        return true;
    }
    return false;
}

// 连接到WebSocket服务器
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
        // 重置重连状态
        resetReconnectState();
        // 启动心跳超时检测
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

                // 检查是否正在生成回复，如果是则拦截消息
                if (isGenerating) {
                    console.log('[Telegram Bridge] 正在生成回复中，拦截新消息');
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'ai_reply',
                            chatId: data.chatId,
                            text: '⏳ AI正在生成回复中，请稍候...\n您的消息将在当前回复完成后处理。',
                        }));
                    }
                    return;
                }

                // 标记开始生成
                isGenerating = true;

                // 存储当前处理的chatId
                lastProcessedChatId = data.chatId;

                // 默认情况下，假设不是流式模式
                isStreamingMode = false;

                // 1. 立即向Telegram发送“输入中”状态（无论是否流式）
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                // 2. 将用户消息添加到SillyTavern
                await sendMessageAsUser(data.text);

                // 3. 设置流式传输的回调
                const streamCallback = (...args) => {
                    // 调试：打印接收到的参数
                    console.log('[Telegram Bridge] STREAM_TOKEN_RECEIVED 参数:', args);

                    // 标记为流式模式
                    isStreamingMode = true;

                    // 获取累计文本 - 尝试多种可能的参数格式
                    let cumulativeText = '';
                    if (typeof args[0] === 'string') {
                        cumulativeText = args[0];
                    } else if (args[0] && typeof args[0].text === 'string') {
                        cumulativeText = args[0].text;
                    } else if (args[0] && typeof args[0].message === 'string') {
                        cumulativeText = args[0].message;
                    }

                    // 将每个文本块通过WebSocket发送到服务端
                    if (ws && ws.readyState === WebSocket.OPEN && cumulativeText) {
                        ws.send(JSON.stringify({
                            type: 'stream_chunk',
                            chatId: data.chatId,
                            text: cumulativeText,
                        }));
                    }
                };
                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

                // 4. 定义一个清理函数
                const cleanup = () => {
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
                    if (ws && ws.readyState === WebSocket.OPEN && isStreamingMode) {
                        // 仅在没有错误且确实处于流式模式时发送stream_end
                        if (!data.error) {
                            ws.send(JSON.stringify({ type: 'stream_end', chatId: data.chatId }));
                        }
                    }
                    // 注意：不在这里重置isStreamingMode，让handleFinalMessage函数来处理
                    // 重置生成状态标志
                    isGenerating = false;
                };

                // 5. 监听生成结束事件，确保无论成功与否都执行清理
                // 注意: 我们现在使用once来确保这个监听器只执行一次，避免干扰后续的全局监听器
                eventSource.once(event_types.GENERATION_ENDED, cleanup);
                // 添加对手动停止生成的处理
                eventSource.once(event_types.GENERATION_STOPPED, cleanup);

                // 6. 触发SillyTavern的生成流程，并用try...catch包裹
                try {
                    const abortController = new AbortController();
                    setExternalAbortController(abortController);
                    await Generate('normal', { signal: abortController.signal });
                } catch (error) {
                    console.error("[Telegram Bridge] Generate() 错误:", error);

                    // a. 从SillyTavern聊天记录中删除导致错误的用户消息
                    await deleteLastMessage();
                    console.log('[Telegram Bridge] 已删除导致错误的用户消息。');

                    // b. 准备并发送错误信息到服务端
                    const errorMessage = `抱歉，AI生成回复时遇到错误。\n您的上一条消息已被撤回，请重试或发送不同内容。\n\n错误详情: ${error.message || '未知错误'}`;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error_message',
                            chatId: data.chatId,
                            text: errorMessage,
                        }));
                    }

                    // c. 标记错误以便cleanup函数知道
                    data.error = true;
                    cleanup(); // 确保清理监听器
                }

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

                // 显示“输入中”状态
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                let replyText = '命令执行失败，请稍后重试。';

                // 直接调用全局的 SillyTavern.getContext()
                const context = SillyTavern.getContext();
                let commandSuccess = false;

                try {
                    if (await handleBridgeControlCommand(data, context)) {
                        return;
                    }

                    switch (data.command) {
                        case 'new':
                            await doNewChat({ deleteCurrentChat: false });
                            replyText = '新的聊天已经开始。';
                            commandSuccess = true;
                            break;
                        case 'listchars': {
                            const characters = context.characters.slice(1);
                            if (characters.length > 0) {
                                // 分页参数：每页显示10个角色（避免消息过长）
                                const PAGE_SIZE = 10;
                                const pageArg = data.args && data.args[0] ? parseInt(data.args[0]) : 1;
                                const page = isNaN(pageArg) ? 1 : pageArg;
                                const totalPages = Math.ceil(characters.length / PAGE_SIZE);
                                const currentPage = Math.max(1, Math.min(page, totalPages));
                                const startIndex = (currentPage - 1) * PAGE_SIZE;
                                const endIndex = Math.min(startIndex + PAGE_SIZE, characters.length);
                                const pageChars = characters.slice(startIndex, endIndex);

                                replyText = `📋 角色 (${currentPage}/${totalPages}页)\n`;
                                pageChars.forEach((char, index) => {
                                    const globalIndex = startIndex + index + 1;
                                    // 截断过长的角色名
                                    const charName = char.name.length > 20 ? char.name.substring(0, 20) + '..' : char.name;
                                    replyText += `${globalIndex}. ${charName}\n`;
                                });
                                replyText += `\n切换: /switchchar_数字`;

                                const charButtons = pageChars.map((char, index) => {
                                    const globalIndex = startIndex + index + 1;
                                    const label = `${globalIndex}. ${char.name}`.slice(0, 60);
                                    return [{ text: label, callback_data: `cmd_switchchar_${globalIndex}` }];
                                });

                                // 发送带分页和切换按钮的回复
                                if (ws && ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({
                                        type: 'ai_reply',
                                        chatId: data.chatId,
                                        text: replyText,
                                        reply_markup: {
                                            inline_keyboard: charButtons
                                        },
                                        pagination: {
                                            currentPage,
                                            totalPages,
                                            type: 'listchars'
                                        }
                                    }));
                                }
                                return;
                            } else {
                                replyText = '没有找到可用角色。';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchar': {
                            if (!data.args || data.args.length === 0) {
                                replyText = '请提供角色名称或序号。用法: /switchchar <角色名称> 或 /switchchar_数字';
                                break;
                            }
                            const targetName = data.args.join(' ');
                            const characters = context.characters;
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
                            if (context.characterId === undefined) {
                                replyText = '请先选择一个角色。';
                                break;
                            }
                            const chatFiles = await getPastCharacterChats(context.characterId);
                            if (chatFiles.length > 0) {
                                // 分页参数：每页显示10个聊天记录
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
                                    // 截断过长的聊天名
                                    chatName = chatName.length > 20 ? chatName.substring(0, 20) + '..' : chatName;
                                    replyText += `${globalIndex}. ${chatName}\n`;
                                });
                                replyText += `\n切换: /switchchat_数字`;

                                const chatButtons = pageChats.map((chat, index) => {
                                    const globalIndex = chatStartIndex + index + 1;
                                    let chatName = chat.file_name.replace('.jsonl', '');
                                    const label = `${globalIndex}. ${chatName}`.slice(0, 60);
                                    return [{ text: label, callback_data: `cmd_switchchat_${globalIndex}` }];
                                });

                                // 发送带分页和切换按钮的回复
                                if (ws && ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({
                                        type: 'ai_reply',
                                        chatId: data.chatId,
                                        text: replyText,
                                        reply_markup: {
                                            inline_keyboard: chatButtons
                                        },
                                        pagination: {
                                            currentPage: chatCurrentPage,
                                            totalPages: chatTotalPages,
                                            type: 'listchats'
                                        }
                                    }));
                                }
                                return;
                            } else {
                                replyText = '当前角色没有任何聊天记录。';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchat': {
                            if (!data.args || data.args.length === 0) {
                                replyText = '请提供聊天记录名称。用法： /switchchat <聊天记录名称>';
                                break;
                            }
                            const targetChatFile = `${data.args.join(' ')}`;
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
                            // 处理特殊格式的命令，如 switchchar_1, switchchat_2 等
                            const charMatch = data.command.match(/^switchchar_(\d+)$/);
                            if (charMatch) {
                                const index = parseInt(charMatch[1]) - 1;
                                const characters = context.characters.slice(1);
                                if (index >= 0 && index < characters.length) {
                                    const targetChar = characters[index];
                                    const charIndex = context.characters.indexOf(targetChar);
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
                                if (context.characterId === undefined) {
                                    replyText = '请先选择一个角色。';
                                    break;
                                }
                                const index = parseInt(chatMatch[1]) - 1;
                                const chatFiles = await getPastCharacterChats(context.characterId);

                                if (index >= 0 && index < chatFiles.length) {
                                    const targetChat = chatFiles[index];
                                    const chatName = targetChat.file_name.replace('.jsonl', '');
                                    try {
                                        await openCharacterChat(chatName);
                                        replyText = `已加载聊天记录： ${chatName}`;
                                        commandSuccess = true;
                                    } catch (err) {
                                        console.error(err);
                                        replyText = `加载聊天记录失败。`;
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
                    // 发送命令执行结果到Telegram
                    ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: replyText }));

                    // 发送命令执行状态反馈到服务器
                    ws.send(JSON.stringify({
                        type: 'command_executed',
                        command: data.command,
                        success: commandSuccess,
                        message: replyText
                    }));
                }

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
        // 清除心跳超时定时器
        clearHeartbeatTimeout();
        ws = null;

        // 如果启用了自动连接，尝试重连
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
        // 清除心跳超时定时器
        clearHeartbeatTimeout();
        // 注意：onerror后通常会触发onclose，所以这里不需要重复触发重连
        // 只更新状态，让onclose处理重连逻辑
        updateStatus('连接错误', 'red');
    };
}

function disconnect() {
    // 取消自动重连
    cancelReconnect();
    if (ws) {
        ws.close();
    }
}

// 扩展加载时执行的函数
jQuery(async () => {
    console.log('[Telegram Bridge] 正在尝试加载设置 UI...');
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        console.log('[Telegram Bridge] 设置 UI 应该已经被添加。');

        const settings = getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);

        $('#telegram_bridge_url').on('input', () => {
            const settings = getSettings();
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            // 确保调用saveSettingsDebounced保存设置
            saveSettingsDebounced();
        });

        $('#telegram_auto_connect').on('change', function () {
            const settings = getSettings();
            settings.autoConnect = $(this).prop('checked');
            // 确保调用saveSettingsDebounced保存设置
            console.log(`[Telegram Bridge] 自动连接设置已更改为: ${settings.autoConnect}`);
            saveSettingsDebounced();
        });

        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        if (settings.autoConnect) {
            console.log('[Telegram Bridge] 自动连接已启用，正在连接...');
            connect();
        }

    } catch (error) {
        console.error('[Telegram Bridge] 加载设置 HTML 失败。', error);
    }
    console.log('[Telegram Bridge] 扩展已加载。');
});

/**
 * 从DOM元素中提取文本，保留换行符和基本格式标记
 * @param {jQuery} messageTextElement - 消息文本的jQuery元素
 * @returns {string} 提取的文本，保留格式标记
 */
function extractTextFromDOM(messageTextElement) {
    // 克隆元素以避免修改原始DOM
    const clone = messageTextElement.clone();

    // 处理换行相关标签
    clone.find('br').replaceWith('\n');
    clone.find('p').each(function () {
        $(this).prepend('\n\n').append('\n\n');
    });
    clone.find('div').each(function () {
        $(this).append('\n');
    });

    // 保留粗体格式标记 - 转换为 **text**
    clone.find('b, strong').each(function () {
        const text = $(this).text();
        $(this).replaceWith(`**${text}**`);
    });

    // 保留斜体格式标记 - 转换为 *text*
    clone.find('i, em').each(function () {
        const text = $(this).text();
        $(this).replaceWith(`*${text}*`);
    });

    // 保留代码块格式 - 转换为 `code` 或 ```code```
    clone.find('code').each(function () {
        const text = $(this).text();
        // 检查是否是多行代码块
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

    // 获取处理后的文本内容
    let text = clone.text();

    // 解码HTML实体
    text = decodeHtmlEntities(text);

    // 清理多余的空行（超过2个连续换行符的替换为2个）
    text = text.replace(/\n{3,}/g, '\n\n');

    // 去除首尾空白
    text = text.trim();

    return text;
}

/**
 * 解码HTML实体
 * @param {string} text - 包含HTML实体的文本
 * @returns {string} 解码后的文本
 */
function decodeHtmlEntities(text) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = text;
    return tempDiv.textContent || tempDiv.innerText || '';
}

// 全局事件监听器，用于最终消息更新
function handleFinalMessage(lastMessageIdInChatArray) {
    console.log(`[Telegram Bridge] handleFinalMessage 被调用, lastMessageId: ${lastMessageIdInChatArray}, lastProcessedChatId: ${lastProcessedChatId}, isStreamingMode: ${isStreamingMode}`);

    // 确保WebSocket已连接，并且我们有一个有效的chatId来发送更新
    if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) {
        console.log('[Telegram Bridge] handleFinalMessage 提前返回: ws状态或chatId无效');
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    // 延迟以确保DOM更新完成
    setTimeout(() => {
        // 直接调用全局的 SillyTavern.getContext()
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        // 确认这是我们刚刚通过Telegram触发的AI回复
        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);

            if (messageElement.length > 0) {
                // 获取消息文本元素
                const messageTextElement = messageElement.find('.mes_text');

                // 使用优化后的DOM文本提取函数
                const renderedText = extractTextFromDOM(messageTextElement);

                console.log(`[Telegram Bridge] 捕获到最终渲染文本，准备发送更新到 chatId: ${lastProcessedChatId}`);

                // 判断是流式还是非流式响应
                if (isStreamingMode) {
                    // 流式响应 - 发送final_message_update
                    ws.send(JSON.stringify({
                        type: 'final_message_update',
                        chatId: lastProcessedChatId,
                        text: renderedText,
                    }));
                    // 重置流式模式标志
                    isStreamingMode = false;
                } else {
                    // 非流式响应 - 直接发送ai_reply
                    ws.send(JSON.stringify({
                        type: 'ai_reply',
                        chatId: lastProcessedChatId,
                        text: renderedText,
                    }));
                }

                // 重置chatId，避免意外更新其他用户的消息
                lastProcessedChatId = null;
            }
        }
        // 确保重置生成状态标志（无论是否成功发送消息）
        isGenerating = false;
    }, 100);
}

// 全局事件监听器，用于最终消息更新
eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);

// 添加对手动停止生成的处理
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);

/**
 * 清理流式会话状态
 * 当角色或聊天切换时调用，通知Bridge_Server清空旧的流式会话缓存
 */
function cleanupStreamSession() {
    console.log('[Telegram Bridge] 检测到角色/聊天切换，清理流式会话状态');

    // 重置本地状态
    isGenerating = false;
    isStreamingMode = false;

    // 如果有正在处理的chatId，发送清理消息到Bridge_Server
    if (ws && ws.readyState === WebSocket.OPEN && lastProcessedChatId) {
        ws.send(JSON.stringify({
            type: 'cleanup_session',
            chatId: lastProcessedChatId,
        }));
        console.log(`[Telegram Bridge] 已发送清理消息到 chatId: ${lastProcessedChatId}`);
    }

    // 重置chatId
    lastProcessedChatId = null;
}

// 监听角色切换事件
eventSource.on(event_types.CHAT_CHANGED, () => {
    console.log('[Telegram Bridge] 检测到聊天切换');
    cleanupStreamSession();
});

// 监听聊天加载事件（切换到不同聊天记录时触发）
eventSource.on(event_types.CHATLOADED, () => {
    console.log('[Telegram Bridge] 检测到聊天加载');
    cleanupStreamSession();
});

// 监听角色选择事件
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    // 这个事件在角色消息渲染时触发，可能表示角色切换
    // 但我们只在有活跃会话时才清理
    if (lastProcessedChatId) {
        console.log('[Telegram Bridge] 检测到角色消息渲染，检查是否需要清理');
    }
});
