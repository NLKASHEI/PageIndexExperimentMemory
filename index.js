import { getRequestHeaders } from '/script.js';
import { getStringHash } from '/scripts/utils.js';
import { archiveFloors } from './recall.js';
import { installAutomation } from './automation.js';
import { installModelPanel } from './panels.js';
import { installFloatingPanel } from './floating.js';
import { browserModelAvailable, openTavernConnection } from './browser/model.js';
import { browserIntent, browserRecall } from './browser/recall.js';

const RUNTIME_KEY = 'floor-recall-runtime';
let runtime = 'browser';
try {
    if (localStorage.getItem(RUNTIME_KEY) === 'native') runtime = 'native';
} catch {}

function identity(context) {
    return JSON.stringify([context.groupId ?? null, context.groupId ? null : context.characterId, context.chatId]);
}

async function postNative(route, body, signal) {
    const local = ['http://127.0.0.1:8000', 'http://localhost:8000'].includes(location.origin);
    const base = local ? 'http://127.0.0.1:17655' : '/api/plugins/floor-recall';
    const headers = local ? {'Content-Type': 'application/json'} : getRequestHeaders();
    let response;
    try {
        response = await fetch(`${base}/${route}`, {method: 'POST', signal, headers, body: JSON.stringify(body)});
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error('无法连接 PageIndex 桥接服务。请核对安装说明和服务是否启动。');
    }
    if (!local && response.status === 404) throw new Error('远程访问需要在酒馆服务器安装楼层回溯网关。');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'PageIndex 服务请求失败。');
    return result;
}

function post(route, body, signal) {
    if (runtime === 'native') return postNative(route, body, signal);
    const connection = openTavernConnection();
    return route === 'intent' ? browserIntent(body, connection, signal) : browserRecall(body, connection, signal);
}

async function digestText(text) {
    if (!globalThis.crypto?.subtle) return String(getStringHash(text));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function recallWithPageIndex(chat, question, bm25f, signal, chatScope, recent = [], retry = false) {
    const records = archiveFloors(chat);
    let revision;
    if (globalThis.crypto?.subtle || runtime === 'browser') {
        for (let start = 0; start < chat.length; start += 64) {
            signal.throwIfAborted();
            await Promise.all(chat.slice(start, start + 64).map(async ({mes, name, is_user, swipe_id}, offset) => {
                records[start + offset].revision = await digestText(JSON.stringify([mes, name, is_user, swipe_id]));
            }));
        }
        revision = await digestText(JSON.stringify(records.map(record => record.revision)));
    }
    signal.throwIfAborted();
    return post('recall', {question, bm25f, chat_scope: chatScope, archive_revision: revision, recent, retry, records}, signal);
}
function mount() {
    if (document.getElementById('floor-recall')) return;
    const panel = document.createElement('details');
    panel.id = 'floor-recall';
    panel.innerHTML = `<summary data-float-handle>楼层回溯</summary>
        <section class="floor-recall-controls" aria-label="本聊天设置">
            <label><input type="checkbox" data-auto-hide checked> 自动隐藏旧楼</label>
            <label>保留近期 <input type="number" data-keep min="1" max="999" value="30" aria-label="保留楼层数"> 楼</label>
            <label><input type="checkbox" data-auto-recall checked> 自动回溯</label>
        </section><p data-auto-status role="status"></p>
        <form><label for="floor-recall-question">查询当前聊天</label>
        <textarea id="floor-recall-question" rows="2" required maxlength="600"></textarea>
        <div class="floor-recall-controls">
            <label><input type="checkbox" data-bm25f> BM25F 辅助</label>
            <button type="submit" class="menu_button">查旧楼层</button>
            <button type="button" data-cancel class="menu_button" disabled>取消</button>
        </div></form>
        <p data-status role="status"></p><div data-result></div>
        <details class="floor-recall-drawer" data-inspector>
            <summary>查看最近回溯与注入</summary>
            <p data-injected-query></p><pre data-injected-content>这段聊天还没有回溯记录。</pre>
            <div class="floor-recall-controls">
                <button type="button" class="menu_button" data-retry-recall hidden>重试检索</button>
            </div>
            <p data-retry-status role="status" hidden></p>
        </details>
        <div class="floor-recall-drawer">
            <label class="floor-recall-profile-picker">检索运行方式
                <select data-runtime class="text_pole">
                    <option value="browser">浏览器 · 沿用酒馆的 API 连接</option>
                    <option value="native">原生 PageIndex · 本机桥接</option>
                </select>
            </label>
        </div>
        <details class="floor-recall-drawer" data-model-panel hidden>
            <summary>检索 API</summary>
            <label class="floor-recall-profile-picker">当前连接
                <select name="apiProfile" class="text_pole" disabled><option>正在读取方案…</option></select>
            </label>
            <p class="floor-recall-hints" data-profile-info hidden></p>
            <div class="floor-recall-controls">
                <button type="button" class="menu_button" data-model-new disabled>新建方案</button>
                <button type="button" class="menu_button" data-model-edit hidden>编辑方案</button>
                <button type="button" class="menu_button" data-model-key hidden>密钥</button>
                <button type="button" class="menu_button" data-model-test hidden>测试连接</button>
                <button type="button" class="menu_button" data-model-reload hidden>重新读取</button>
            </div>
            <p data-model-status role="status"></p>
        </details>`;
    document.body.append(panel);
    installFloatingPanel(panel);
    const mode = panel.querySelector('[data-runtime]');
    const nativePanel = panel.querySelector('[data-model-panel]');
    function showRuntime() {
        mode.value = runtime;
        nativePanel.hidden = runtime !== 'native';
        if (nativePanel.hidden) nativePanel.open = false;
    }
    showRuntime();
    mode.addEventListener('change', () => {
        runtime = mode.value;
        try { localStorage.setItem(RUNTIME_KEY, runtime); } catch {}
        showRuntime();
    });
    installAutomation(panel, post, recallWithPageIndex, () => runtime === 'native' || browserModelAvailable());
    installModelPanel(panel, postNative);
    const form = panel.querySelector(':scope > form');
    const questionBox = panel.querySelector('textarea');
    const submit = panel.querySelector('[type=submit]');
    const cancel = panel.querySelector('[data-cancel]');
    const assist = panel.querySelector('[data-bm25f]');
    const status = panel.querySelector('[data-status]');
    const output = panel.querySelector('[data-result]');
    const context = SillyTavern.getContext();
    let pending;
    let revision = 0;
    function invalidate() {
        revision++;
        pending?.abort();
        output.replaceChildren();
    }
    const events = context.eventTypes ?? context.event_types;
    for (const type of ['CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED']) {
        if (events?.[type]) context.eventSource.on(events[type], invalidate);
    }
    mode.addEventListener('change', invalidate);
    cancel.addEventListener('click', invalidate);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const question = questionBox.value.trim();
        const start = SillyTavern.getContext();
        if (!question || !start.chat.length || pending) return;
        const scope = identity(start);
        const startRevision = revision;
        const snapshot = start.chat.map(({mes, swipe_id, is_user, name}) => ({mes, swipe_id, is_user, name}));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 65000);
        pending = controller;
        submit.disabled = true;
        assist.disabled = true;
        delete panel.dataset.bm25fFloors;
        cancel.disabled = false;
        output.replaceChildren();
        try {
            status.textContent = '正在让 PageIndex 检索当前聊天…';
            const result = await recallWithPageIndex(snapshot, question, assist.checked, controller.signal, scope);
            const now = SillyTavern.getContext();
            if (controller.signal.aborted || revision !== startRevision || scope !== identity(now) || snapshot.length !== now.chat.length || snapshot.some((message, index) => message.mes !== now.chat[index]?.mes || message.swipe_id !== now.chat[index]?.swipe_id)) {
                status.textContent = '聊天已变化，请重新检索。';
                return;
            }
            panel.dataset.pageindexTools = (result.tools ?? []).join(',');
            const lexicalFloors = result.bm25f_floors ?? [];
            panel.dataset.bm25fFloors = JSON.stringify(lexicalFloors);
            const usage = result.usage;
            panel.dataset.pageindexUsage = JSON.stringify(usage ?? {});
            const answer = document.createElement('p');
            answer.textContent = result.answer;
            output.append(answer);
            if (result.floors.length) {
                const sources = document.createElement('p');
                sources.textContent = '引用楼层：' + result.floors.map(floor => `#${floor}`).join('、');
                output.append(sources);
            }
            if (lexicalFloors.length) {
                const hints = document.createElement('p');
                hints.className = 'floor-recall-hints';
                hints.textContent = 'BM25F 候选：' + lexicalFloors.map(floor => `#${floor}`).join('、');
                output.append(hints);
            }
            status.textContent = result.result_cache_hit ? '已复用核验结果 · 本次检索 0 token' :
                `扫描 ${snapshot.length} 楼 · ${result.scenes} 个区段 · ${result.engine}${result.bm25f_enabled ? ' + BM25F' : ''} · 读取 ${result.pages_read} 楼`;
            if (result.notes_used) status.textContent += ` · 小纪要线索 ${result.notes_used} 条`;
            if (usage?.total_tokens > 0) {
                status.textContent += ` · ${usage.prompt_tokens.toLocaleString()} 输入 / ${usage.completion_tokens.toLocaleString()} 输出 token`;
            }
        } catch (error) {
            status.textContent = controller.signal.aborted ? '检索已取消、超时，或聊天已变化。' : error.message;
        } finally {
            clearTimeout(timeout);
            submit.disabled = false;
            assist.disabled = false;
            cancel.disabled = true;
            pending = undefined;
        }
    });
}

if (globalThis.SillyTavern?.getContext) mount();
