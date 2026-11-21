import { getRequestHeaders, main_api } from '/script.js';
import { createGenerationParameters, getChatCompletionModel, oai_settings } from '/scripts/openai.js';

export function browserModelAvailable() {
    return main_api === 'openai' && Boolean(getChatCompletionModel(oai_settings));
}

export function openTavernConnection() {
    if (!browserModelAvailable()) throw new Error('请在酒馆的 API 连接里选择支持工具调用的 Chat Completion 模型。');
    const settings = {...oai_settings};
    const model = getChatCompletionModel(settings);
    const modelKey = JSON.stringify([model, settings.chat_completion_source, settings.custom_url,
        settings.custom_include_body, settings.custom_include_headers, settings.custom_exclude_body,
        settings.reverse_proxy, settings.reasoning_effort]);

    async function complete(messages, signal, tools) {
        signal?.throwIfAborted();
        const params = {...settings, enable_web_search: false, show_thoughts: false, bias_preset_selected: ''};
        const {generate_data: body} = await createGenerationParameters(params, model, 'quiet', messages);
        signal?.throwIfAborted();
        body.messages = messages;
        body.stream = false;
        body.n = 1;
        body.enable_web_search = false;
        delete body.stop;
        const budget = tools ? 1024 : 768;
        if (body.max_completion_tokens !== undefined) body.max_completion_tokens = budget;
        else body.max_tokens = budget;
        if (tools) {
            body.tools = tools;
            body.tool_choice = 'auto';
        } else {
            delete body.tools;
            delete body.tool_choice;
        }
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body), signal,
        });
        const result = await response.json().catch(() => null);
        signal?.throwIfAborted();
        if (!response.ok || !result?.choices?.[0]?.message) {
            const error = result?.error?.message ?? result?.response;
            throw new Error(typeof error === 'string' ? error : `酒馆检索模型请求失败（HTTP ${response.status}）。`);
        }
        return result;
    }

    return {modelKey, complete};
}
