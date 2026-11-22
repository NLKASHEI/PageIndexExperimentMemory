import { getRequestHeaders, main_api } from '/script.js';
import { createGenerationParameters, getChatCompletionModel, oai_settings } from '/scripts/openai.js';
import { yaml } from '/lib.js';

const SETTINGS = 'floorRecallConnection';
const INTENT_LIMIT = 1024;
const RECALL_LIMIT = 8092;

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
    return ctx.extensionSettings[SETTINGS] ??= {id: '', options: {}};
}

function selected(ctx) {
    const {id, options} = connectionSettings(ctx);
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
        const {profile, model} = selected(SillyTavern.getContext());
        return Boolean(model && (profile || main_api === 'openai'));
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
    const {profile, model, source, url, preset, config, deepseek} = selected(ctx);
    if (!model || (!profile && main_api !== 'openai')) {
        throw new Error('请为楼层回溯选择支持工具调用的 Chat Completion 模型。');
    }
    const settings = {...preset, enable_web_search: false, bias_preset_selected: ''};
    const customBody = source === 'custom' ? requestBody(settings.custom_include_body, config, deepseek) : undefined;
    const modelKey = JSON.stringify([profile?.id, model, source, url, customBody, settings.custom_include_headers,
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

export function installModelPicker(panel) {
    const ctx = SillyTavern.getContext();
    const settings = connectionSettings(ctx);
    const picker = panel.querySelector('[data-connection-profile]');
    const thinking = panel.querySelector('[data-connection-thinking]');
    const extra = panel.querySelector('[data-connection-extra]');
    const status = panel.querySelector('[data-model-status]');
    const change = () => panel.dispatchEvent(new Event('floor-recall-connection-changed'));

    function refresh() {
        const options = profiles(ctx).map(profile => new Option(`${profile.name} · ${profile.model}`, profile.id));
        if (settings.id && !options.some(option => option.value === settings.id)) {
            options.push(new Option('已保存的方案不可用', settings.id));
        }
        picker.replaceChildren(new Option('跟随正文连接', ''), ...options);
        picker.value = settings.id;
        const config = settings.options[settings.id || 'current'] ?? {};
        thinking.value = config.thinking ?? 'default';
        extra.value = config.extra ? JSON.stringify(config.extra, null, 2) : '';
        let source;
        let deepseek;
        try { ({source, deepseek} = selected(ctx)); } catch {}
        thinking.closest('label').hidden = !deepseek;
        extra.closest('label').hidden = source !== 'custom';
        status.textContent = '';
    }

    function save() {
        try {
            const parsed = JSON.parse(extra.value.trim() || '{}');
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            settings.options[settings.id || 'current'] = {thinking: thinking.value, extra: parsed};
            ctx.saveSettingsDebounced();
            status.textContent = '';
            change();
        } catch {
            status.textContent = '附加参数须为 JSON 对象，已保留上次保存的设置。';
        }
    }

    picker.addEventListener('change', () => {
        settings.id = picker.value;
        ctx.saveSettingsDebounced();
        refresh();
        change();
    });
    thinking.addEventListener('change', save);
    extra.addEventListener('change', save);
    panel.querySelector('[data-model-panel]').addEventListener('toggle', event => {
        if (event.target.open) refresh();
    });
    for (const name of ['CREATED', 'UPDATED', 'DELETED', 'LOADED']) {
        const event = ctx.eventTypes[`CONNECTION_PROFILE_${name}`];
        if (event) ctx.eventSource.on(event, () => { refresh(); change(); });
    }
    refresh();
}
