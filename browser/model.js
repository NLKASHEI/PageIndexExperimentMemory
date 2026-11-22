import { getRequestHeaders, main_api } from '/script.js';
import { createGenerationParameters, getChatCompletionModel, oai_settings } from '/scripts/openai.js';
import { yaml } from '/lib.js';
import { SECRET_KEYS, readSecretState } from '/scripts/secrets.js';
import { uuidv4 } from '/scripts/utils.js';

const SETTINGS = 'floorRecallConnection';
const INTENT_LIMIT = 1024;
const RECALL_LIMIT = 8092;
const NO_SECRET = 'floor-recall-no-key';

function profiles(ctx) {
    const service = ctx.ConnectionManagerRequestService;
    if (!service) return [];
    try {
        return service.getSupportedProfiles().filter(profile =>
            service.validateProfile(profile).selected === 'openai' && profile.model);
    } catch {
        return [];
    }
}

function connectionSettings(ctx) {
    const settings = ctx.extensionSettings[SETTINGS] ??= {id: '', options: {}};
    settings.custom ??= [];
    return settings;
}

function selected(ctx) {
    const {id, options, custom} = connectionSettings(ctx);
    const own = custom.find(item => item.id === id);
    if (own) return {own, model: own.model, source: 'custom', url: own.url, preset: {},
        deepseek: /deepseek/i.test(`${own.url} ${own.model}`), config: own};
    const profile = id ? profiles(ctx).find(item => item.id === id) : undefined;
    if (id && !profile) throw new Error('检索方案不可用，请重新选择酒馆的连接方案。');
    const preset = profile ? ctx.getPresetManager('openai')?.getCompletionPresetByName(profile.preset) ?? {} : oai_settings;
    const source = profile ? ctx.ConnectionManagerRequestService.validateProfile(profile).source : oai_settings.chat_completion_source;
    const url = profile ? profile['api-url'] : oai_settings.custom_url;
    const model = profile ? profile.model : getChatCompletionModel(oai_settings);
    const deepseek = source === 'deepseek' || (source === 'custom' && /deepseek/i.test(`${url} ${model}`));
    return {profile, model, source, url, preset, deepseek, config: options[id || 'current'] ?? {}};
}

export function browserModelAvailable() {
    try {
        const {profile, own, model} = selected(SillyTavern.getContext());
        return Boolean(model && (profile || own || main_api === 'openai'));
    } catch {
        return false;
    }
}

function requestBody(original, config, deepseek) {
    const extra = {...yaml.parse(original || '{}'), ...config.extra};
    for (const key of ['model', 'messages', 'stream', 'n', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice', 'stop']) delete extra[key];
    if (deepseek && ['enabled', 'disabled'].includes(config.thinking)) {
        extra.thinking = {type: config.thinking};
        if (config.thinking === 'disabled') delete extra.reasoning_effort;
    }
    return JSON.stringify(extra);
}

export function openTavernConnection() {
    const ctx = SillyTavern.getContext();
    const {profile, own, model, source, url, preset, config, deepseek} = selected(ctx);
    if (!model || (!profile && !own && main_api !== 'openai')) {
        throw new Error('请为楼层回溯选择支持工具调用的 Chat Completion 模型。');
    }
    const settings = {...preset, enable_web_search: false, bias_preset_selected: ''};
    const customBody = source === 'custom' ? requestBody(settings.custom_include_body, config, deepseek) : undefined;
    const modelKey = JSON.stringify([profile?.id ?? own?.id, own?.secretId, model, source, url, customBody, settings.custom_include_headers,
        settings.custom_exclude_body, settings.reverse_proxy, settings.reasoning_effort, settings.show_thoughts, config.thinking]);

    async function complete(messages, signal, tools, stage = 'recall') {
        signal?.throwIfAborted();
        const limit = stage === 'intent' ? INTENT_LIMIT : RECALL_LIMIT;
        const {generate_data: body} = await createGenerationParameters(
            {...oai_settings, ...settings, chat_completion_source: source}, model, 'quiet', messages.map(message => ({...message})));
        signal?.throwIfAborted();
        const usesCompletionLimit = body.max_completion_tokens !== undefined;
        const payload = {stream: false, n: 1, max_tokens: usesCompletionLimit ? undefined : limit,
            max_completion_tokens: usesCompletionLimit ? limit : undefined, enable_web_search: false, stop: undefined,
            tools, tool_choice: tools ? 'auto' : undefined};
        if (source === 'custom') payload.custom_include_body = customBody;
        if (source === 'deepseek' && ['enabled', 'disabled'].includes(config.thinking)) {
            payload.include_reasoning = config.thinking === 'enabled';
        }
        if (profile) {
            return ctx.ConnectionManagerRequestService.sendRequest(profile.id, messages, limit,
                {signal, extractData: false}, payload);
        }

        Object.assign(body, payload, {messages});
        if (own) Object.assign(body, {custom_url: url, secret_id: own.secretId || NO_SECRET,
            custom_include_headers: '', custom_exclude_body: '', custom_prompt_post_processing: '', reverse_proxy: '', proxy_password: ''});
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body), signal,
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.choices?.[0]?.message) {
            const error = result?.error?.message ?? result?.response;
            throw new Error(typeof error === 'string' ? error : `酒馆检索模型请求失败（HTTP ${response.status}）。`);
        }
        return result;
    }

    return {modelKey, complete};
}

function normalizeUrl(value) {
    let url;
    try { url = new URL(value.trim()); } catch {}
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('请输入有效的 HTTP(S) API 地址。');
    }
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '') || '/v1';
    return url.href;
}

function tavernPost(path, body, signal) {
    return fetch(path, {method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body), signal});
}

async function secretRequest(operation, data) {
    const response = await tavernPost(`/api/secrets/${operation}`, {key: SECRET_KEYS.CUSTOM, ...data});
    if (!response.ok) throw new Error(`酒馆密钥操作失败（HTTP ${response.status}）。`);
    return response;
}

async function writeCustomKey(value, name) {
    const stateResponse = await secretRequest('read');
    const state = await stateResponse.json();
    const active = state[SECRET_KEYS.CUSTOM]?.find(item => item.active)?.id;
    // Tavern activates every new key. Preserve the previous default, including a keyless default.
    const write = async (value, label) => {
        const {id} = await (await secretRequest('write', {value, label})).json();
        if (!id) throw new Error('酒馆未返回密钥 ID。');
        return id;
    };
    const restore = active || await write('', '默认自定义接口（无密钥）');
    const id = await write(value, `楼层回溯 · ${name}`);
    try {
        await secretRequest('rotate', {id: restore});
    } catch (error) {
        await secretRequest('delete', {id});
        throw error;
    }
    return id;
}

export function installModelPicker(panel) {
    const ctx = SillyTavern.getContext();
    const settings = connectionSettings(ctx);
    const picker = panel.querySelector('[data-connection-profile]');
    const thinking = panel.querySelector('[data-connection-thinking]');
    const extra = panel.querySelector('[data-connection-extra]');
    const status = panel.querySelector('[data-model-status]');
    const change = () => panel.dispatchEvent(new Event('floor-recall-connection-changed'));
    const field = name => panel.querySelector(`[data-custom-${name}]`);
    const editor = panel.querySelector('[data-custom-connection]');
    const name = field('name');
    const url = field('url');
    const key = field('key');
    const model = field('model');
    const list = field('models');
    const fetchButton = field('fetch');
    const newButton = panel.querySelector('[data-connection-new]');
    let editing = null;
    let dirty = false;
    let busy = false;
    let listing;

    function resetModels() {
        listing?.abort();
        list.replaceChildren(new Option('选择模型', ''));
        field('model-list').hidden = true;
    }

    function updateThinking() {
        if (editing) thinking.closest('label').hidden = !/deepseek/i.test(`${url.value} ${model.value}`);
    }

    function refresh() {
        const options = [...settings.custom.map(profile => new Option(`${profile.name} · ${profile.model}`, profile.id)),
            ...profiles(ctx).map(profile => new Option(`酒馆 · ${profile.name} · ${profile.model}`, profile.id))];
        if (settings.id && !options.some(option => option.value === settings.id)) {
            options.push(new Option('已保存的方案不可用', settings.id));
        }
        picker.replaceChildren(new Option('跟随正文连接', ''), ...options);
        picker.value = settings.id;
        editing = settings.custom.find(item => item.id === settings.id) ?? null;
        editor.hidden = !editing;
        if (editing) showEditor(editing);
        else resetModels();
        dirty = false;
        const config = editing ?? settings.options[settings.id || 'current'] ?? {};
        thinking.value = config.thinking ?? 'default';
        extra.value = config.extra ? JSON.stringify(config.extra, null, 2) : '';
        let source;
        let deepseek;
        try { ({source, deepseek} = selected(ctx)); } catch {}
        thinking.closest('label').hidden = !deepseek;
        extra.closest('label').hidden = source !== 'custom';
        status.textContent = '';
    }

    function showEditor(profile) {
        editor.hidden = false;
        name.value = profile.name ?? '';
        url.value = profile.url ?? '';
        key.value = '';
        key.placeholder = profile.secretId ? '已保存密钥，留空沿用' : '输入 API 密钥';
        model.value = profile.model ?? '';
        field('copy').hidden = field('delete').hidden = !profile.id;
        resetModels();
    }

    function extraJson() {
        const value = JSON.parse(extra.value.trim() || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('附加参数须为 JSON 对象。');
        return value;
    }

    async function saveProfile(copy) {
        const current = editing;
        let label = name.value.trim();
        const base = normalizeUrl(url.value);
        const modelId = model.value.trim();
        const extra = extraJson();
        const secret = key.value.trim();
        if (copy) {
            label = await ctx.Popup.show.input('另存检索方案', '输入新方案名称', `${label} 副本`);
            if (label == null) return;
            label = String(label).trim();
        }
        if (!label || label.length > 60 || !modelId) throw new Error('请填写方案名称和模型 ID。');
        if (settings.custom.some(item => item.name === label && (copy || item.id !== current.id))) {
            throw new Error('已有同名检索方案。');
        }
        const sameOrigin = current.url && new URL(current.url).origin === new URL(base).origin;
        const retainedId = sameOrigin ? current.secretId : undefined;
        const secretId = secret ? await writeCustomKey(secret, label) : retainedId;
        const saved = {id: (!copy && current.id) || `floor-recall:${uuidv4()}`, name: label, url: base, model: modelId,
            secretId, extra, thinking: thinking.value};
        settings.custom = [...settings.custom.filter(item => item.id !== saved.id), saved];
        settings.id = saved.id;
        ctx.saveSettingsDebounced();
        refresh();
        change();
        if (!copy && current.secretId !== secretId) await removeUnusedKey(current.secretId);
        if (secret) await readSecretState();
        status.textContent = '方案已保存并启用。';
    }

    async function removeUnusedKey(id) {
        if (id && !settings.custom.some(item => item.secretId === id)) {
            await secretRequest('delete', {id});
            await readSecretState();
        }
    }

    async function deleteProfile() {
        const {id, secretId} = editing;
        if (!await ctx.Popup.show.confirm('删除检索方案', '删除后会切回正文连接。')) return;
        settings.custom = settings.custom.filter(item => item.id !== id);
        settings.id = '';
        ctx.saveSettingsDebounced();
        refresh();
        change();
        await removeUnusedKey(secretId);
        status.textContent = '方案已删除。';
    }

    function editAction(action) {
        return async () => {
            if (busy || !editing) return;
            resetModels();
            busy = true;
            for (const control of [picker, newButton, ...editor.querySelectorAll('input, button'), thinking, extra]) control.disabled = true;
            try { await action(); }
            catch (error) { status.textContent = error.message; }
            finally {
                busy = false;
                for (const control of [picker, newButton, ...editor.querySelectorAll('input, button'), thinking, extra]) control.disabled = false;
                fetchButton.disabled = Boolean(listing);
            }
        };
    }

    fetchButton.addEventListener('click', async () => {
        if (listing || busy || !editing) return;
        const controller = new AbortController();
        listing = controller;
        fetchButton.disabled = true;
        const timeout = setTimeout(() => controller.abort(new Error('获取模型列表超时。')), 20000);
        try {
            const base = normalizeUrl(url.value);
            const retained = editing.url && new URL(editing.url).origin === new URL(base).origin ? editing.secretId : undefined;
            const entered = key.value.trim();
            status.textContent = '正在获取模型列表…';
            const response = await tavernPost('/api/backends/chat-completions/status', {
                chat_completion_source: 'custom', custom_url: base, secret_id: retained || NO_SECRET,
                custom_include_headers: entered ? JSON.stringify({Authorization: `Bearer ${entered}`}) : undefined,
            }, controller.signal);
            const json = await response.json().catch(() => null);
            if (!response.ok || json?.error) throw new Error(`获取模型列表失败（HTTP ${response.status}）。`);
            controller.signal.throwIfAborted();
            const ids = [...new Set((Array.isArray(json?.data) ? json.data : [])
                .map(item => item?.id ?? item?.name).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))].sort();
            list.replaceChildren(new Option('选择模型', ''), ...ids.map(id => new Option(id, id)));
            list.value = ids.includes(model.value) ? model.value : '';
            field('model-list').hidden = !ids.length;
            status.textContent = ids.length ? `已获取 ${ids.length} 个模型。` : '接口未返回模型，可手动填写模型 ID。';
        } catch (error) {
            if (!controller.signal.aborted || controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError') {
                status.textContent = controller.signal.reason?.message ?? error.message;
            }
        } finally {
            clearTimeout(timeout);
            if (listing === controller) listing = undefined;
            fetchButton.disabled = busy;
        }
    });

    function save() {
        if (editing) { dirty = true; return; }
        try {
            settings.options[settings.id || 'current'] = {thinking: thinking.value, extra: extraJson()};
            ctx.saveSettingsDebounced();
            status.textContent = '';
            change();
        } catch {
            status.textContent = '附加参数须为 JSON 对象，已保留上次保存的设置。';
        }
    }

    async function canDiscard() {
        return !dirty || await ctx.Popup.show.confirm('放弃未保存的修改', '当前检索方案有未保存的修改。');
    }

    picker.addEventListener('change', async () => {
        const next = picker.value;
        picker.value = settings.id;
        if (!await canDiscard()) return;
        settings.id = next;
        ctx.saveSettingsDebounced();
        refresh();
        change();
    });
    newButton.addEventListener('click', async () => {
        if (!await canDiscard()) return;
        editing = {};
        showEditor(editing);
        dirty = false;
        thinking.value = 'default';
        extra.value = '';
        extra.closest('label').hidden = false;
        updateThinking();
        status.textContent = '填写并保存后启用新方案。';
        name.focus();
    });
    field('save').addEventListener('click', editAction(() => saveProfile(false)));
    field('copy').addEventListener('click', editAction(() => saveProfile(true)));
    field('delete').addEventListener('click', editAction(deleteProfile));
    for (const input of [name, url, key, model]) input.addEventListener('input', () => {
        dirty = true;
        if (input === url || input === key) resetModels();
        if (input === model) list.value = model.value;
        updateThinking();
    });
    list.addEventListener('change', () => {
        if (list.value) { model.value = list.value; dirty = true; updateThinking(); }
    });
    thinking.addEventListener('change', save);
    extra.addEventListener('change', save);
    panel.querySelector('[data-model-panel]').addEventListener('toggle', event => {
        if (event.target.open && !dirty && !editing && !busy) refresh();
    });
    for (const name of ['CREATED', 'UPDATED', 'DELETED', 'LOADED']) {
        const event = ctx.eventTypes[`CONNECTION_PROFILE_${name}`];
        if (event) ctx.eventSource.on(event, () => { if (!dirty && !busy && (!editing || editing.id)) refresh(); change(); });
    }
    refresh();
}
