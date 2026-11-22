import { getStringHash } from '/scripts/utils.js';
import { archiveFloors, chatKey, storyText } from './recall.js';
import { installAutomation } from './automation.js';
import { installFloatingPanel } from './floating.js';
import { browserModelAvailable, installModelPicker, openTavernConnection } from './browser/model.js';
import { browserIntent, browserRecall } from './browser/recall.js';
import { installDirectory, messageRevision, savedDirectory } from './browser/directory.js';

function post(route, body, signal) {
    const connection = openTavernConnection();
    return route === 'intent' ? browserIntent(body, connection, signal) : browserRecall(body, connection, signal);
}

async function recallWithPageIndex(chat, question, bm25f, signal, chatScope, recent = [], retry = false) {
    const ctx = SillyTavern.getContext();
    const directory = chatKey(ctx) === chatScope ? savedDirectory(ctx) : null;
    const records = archiveFloors(chat);
    for (const record of records) {
        signal.throwIfAborted();
        const {floor} = record;
        const live = ctx.chat[floor];
        const saved = chat[floor];
        record.revision = messageRevision(live && live.mes === saved.mes && live.swipe_id === saved.swipe_id &&
            live.name === saved.name && live.is_user === saved.is_user ? live : saved);
    }
    const revision = String(getStringHash(records.map(record => `${record.floor}:${record.revision}`).join('|')));
    const directory_revision = directory ? String(getStringHash(JSON.stringify(directory.batches))) : '';
    return post('recall', {question, bm25f, chat_scope: chatScope, archive_revision: revision, recent, retry,
        records, directory, directory_revision}, signal);
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
        <details class="floor-recall-drawer" data-directory-panel>
            <summary>聊天区段目录</summary>
            <progress data-directory-progress max="1" value="0" aria-label="目录构造进度"></progress>
            <p data-directory-status role="status"></p>
            <div class="floor-recall-controls">
                <button type="button" class="menu_button" data-build-directory>构造目录</button>
                <button type="button" class="menu_button" data-pause-directory disabled>暂停构造</button>
            </div>
        </details>
        <details class="floor-recall-drawer" data-model-panel>
            <summary>检索 API</summary>
            <label class="floor-recall-profile-picker">连接方案
                <select data-connection-profile class="text_pole"></select>
            </label>
            <div class="floor-recall-controls"><button type="button" class="menu_button" data-connection-new>新建自定义方案</button></div>
            <section data-custom-connection hidden>
                <label class="floor-recall-profile-picker">方案名称<input class="text_pole" data-custom-name type="text" maxlength="60"></label>
                <label class="floor-recall-profile-picker">API 地址<input class="text_pole" data-custom-url type="url" placeholder="https://example.com/v1"></label>
                <label class="floor-recall-profile-picker">API 密钥<input class="text_pole" data-custom-key type="password" autocomplete="new-password" placeholder="留空沿用已保存密钥"></label>
                <label class="floor-recall-profile-picker">模型 ID<input class="text_pole" data-custom-model type="text" placeholder="可手动填写"></label>
                <label class="floor-recall-profile-picker" data-custom-model-list hidden>从列表选模型<select class="text_pole" data-custom-models></select></label>
                <div class="floor-recall-controls">
                    <button type="button" class="menu_button" data-custom-fetch>获取模型列表</button>
                    <button type="button" class="menu_button" data-custom-save>保存方案</button>
                    <button type="button" class="menu_button" data-custom-copy>另存为</button>
                    <button type="button" class="menu_button" data-custom-delete>删除方案</button>
                </div>
            </section>
            <label class="floor-recall-profile-picker" hidden>DeepSeek 思考模式
                <select data-connection-thinking class="text_pole">
                    <option value="default">跟随方案</option><option value="disabled">关闭</option><option value="enabled">开启</option>
                </select>
            </label>
            <label class="floor-recall-profile-picker" hidden>检索附加 JSON
                <textarea data-connection-extra class="text_pole" rows="3" placeholder="{}"></textarea>
            </label>
            <p data-model-status role="status"></p>
        </details>`;
    document.body.append(panel);
    installFloatingPanel(panel);
    installModelPicker(panel);
    installAutomation(panel, post, recallWithPageIndex, browserModelAvailable);
    installDirectory(panel, openTavernConnection, browserModelAvailable);
    const form = panel.querySelector(':scope > form');
    const questionBox = form.querySelector('textarea');
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
    for (const type of ['CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) {
        if (events?.[type]) context.eventSource.on(events[type], invalidate);
    }
    panel.addEventListener('floor-recall-connection-changed', invalidate);
    cancel.addEventListener('click', invalidate);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const question = questionBox.value.trim();
        const start = SillyTavern.getContext();
        if (!question || !start.chat.length || pending) return;
        const scope = chatKey(start);
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
            if (controller.signal.aborted || revision !== startRevision || scope !== chatKey(now) || snapshot.length !== now.chat.length || snapshot.some((message, index) => storyText(message.mes) !== storyText(now.chat[index]?.mes) || message.swipe_id !== now.chat[index]?.swipe_id)) {
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
                `档案 ${result.total_floors} 楼 · 已建目录 ${result.indexed_floors} 楼${result.bm25f_enabled ? ' · BM25F 辅助' : ''} · 读取 ${result.pages_read} 楼`;
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
