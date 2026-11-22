import { hideChatMessageRange } from '/scripts/chats.js';
import { extension_prompt_roles, extension_prompt_types } from '/script.js';
import { chatKey, plainMessage, storyFloors, storyText } from './recall.js';

const DEFAULT_KEEP = 30;
const RECENT_RECALL_WINDOW = 15;
const SETTINGS_KEY = 'floorRecallSettings';
const OWNED_HIDE = 'floorRecallAutoHidden';
const PROMPT_KEY = 'floorRecallEvidence';
const context = () => SillyTavern.getContext();

function settings(ctx) {
    const config = ctx.chatMetadata?.[SETTINGS_KEY];
    return {
        hide: config?.hide !== false,
        recall: config?.recall !== false,
        bm25f: config?.bm25f === true,
        keep: Number.isInteger(config?.keep) && config.keep >= 1 && config.keep <= 999 ? config.keep : DEFAULT_KEEP,
    };
}

function getOwner(message) {
    return message.extra?.[OWNED_HIDE] === true;
}

function samePrefix(snapshot, chat) {
    return snapshot.length <= chat.length && snapshot.every((message, floor) => {
        const current = chat[floor];
        return current && storyText(message.mes) === storyText(current.mes) && message.swipe_id === current.swipe_id &&
            message.is_user === current.is_user && message.name === current.name;
    });
}

function recallEvidence(result, historyLength) {
    const sources = (result.floors ?? []).filter(floor => Number.isInteger(floor) && floor >= 0 && floor < historyLength);
    const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
    const citations = sources.map(floor => `第 ${floor} 楼`).join('、');
    return {sources, answer, citations};
}

async function syncHidden(ctx) {
    if (!ctx.chatId) return false;
    const key = chatKey(ctx);
    const config = settings(ctx);
    const floors = storyFloors(ctx.chat);
    const cutoff = config.hide && floors.length > config.keep ? floors.at(-config.keep).floor : 0;
    const restore = [];
    for (let floor = cutoff; floor < ctx.chat.length; floor++) {
        const message = ctx.chat[floor];
        if (!getOwner(message)) continue;
        const previous = restore.at(-1);
        if (previous?.end === floor - 1) previous.end = floor;
        else restore.push({start: floor, end: floor});
    }
    let changed = false;
    for (const range of restore) {
        if (chatKey(context()) !== key) return changed;
        for (let floor = range.start; floor <= range.end; floor++) delete ctx.chat[floor].extra[OWNED_HIDE];
        await hideChatMessageRange(range.start, range.end, true);
        changed = true;
    }
    if (chatKey(context()) !== key) return changed;
    let hasNewHides = false;
    for (let floor = 0; floor < cutoff; floor++) {
        const message = ctx.chat[floor];
        if (!message.is_system) {
            message.extra ??= {};
            message.extra[OWNED_HIDE] = true;
            hasNewHides = true;
        }
    }
    if (hasNewHides) {
        await hideChatMessageRange(0, cutoff - 1, false);
        changed = true;
    }
    return changed;
}

export function installAutomation(panel, post, recall, canRecall) {
    const controls = {
        hide: panel.querySelector('[data-auto-hide]'),
        recall: panel.querySelector('[data-auto-recall]'),
        bm25f: panel.querySelector('[data-bm25f]'),
        keep: panel.querySelector('[data-keep]'),
    };
    const status = panel.querySelector('[data-auto-status]');
    const inspectorQuery = panel.querySelector('[data-injected-query]');
    const inspectorContent = panel.querySelector('[data-injected-content]');
    const retryButton = panel.querySelector('[data-retry-recall]');
    const retryStatus = panel.querySelector('[data-retry-status]');
    let active;
    let receipt;
    let retryTask;
    let queue = Promise.resolve();
    const ready = context();
    ready.setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    const events = ready.eventTypes ?? ready.event_types;

    function refreshControls() {
        const ctx = context();
        const config = settings(ctx);
        controls.hide.checked = config.hide;
        controls.recall.checked = config.recall;
        controls.bm25f.checked = config.bm25f;
        controls.keep.value = config.keep;
        for (const control of Object.values(controls)) control.disabled = !ctx.chatId;
    }

    function clear() {
        active?.abort();
    }

    function showRetryStatus(text = '') {
        retryStatus.textContent = text;
        retryStatus.hidden = !text;
    }

    function setActive(controller) {
        active = controller;
        retryButton.disabled = Boolean(active);
    }

    function matchesReceipt(saved, ctx) {
        return saved?.key === chatKey(ctx) && samePrefix(saved.snapshot, ctx.chat);
    }

    async function retryRecall(saved) {
        if (!matchesReceipt(saved, context())) {
            retryButton.hidden = true;
            receipt = undefined;
            showRetryStatus('原楼层或历史已变化，请重新生成该轮后再试。');
            return;
        }
        const controller = new AbortController();
        setActive(controller);
        const timeout = setTimeout(() => controller.abort(), 65000);
        showRetryStatus(`正在重新检索第 ${saved.snapshot.length - 1} 楼…`);
        try {
            const result = await recall(saved.snapshot.slice(0, saved.historyLength), saved.question, saved.bm25f, controller.signal,
                saved.key, saved.recent, true);
            if (receipt !== saved || active !== controller) return;
            controller.signal.throwIfAborted();
            if (!matchesReceipt(saved, context())) {
                showRetryStatus('重试期间聊天已变化。');
                retryButton.hidden = true;
                receipt = undefined;
                return;
            }
            const {sources, answer, citations} = recallEvidence(result, saved.historyLength);
            if (!sources.length || !answer) {
                showRetryStatus('重试未找到可核对的楼层证据。');
                return;
            }
            saved.retried = true;
            panel.dataset.firstReadFloors = JSON.stringify(result.first_read_floors ?? []);
            inspectorContent.textContent = `${answer}\n依据：${citations}`;
            showRetryStatus('重试完成。重新生成这一楼时可使用新结果。');
        } catch (error) {
            if (receipt !== saved || active !== controller) return;
            showRetryStatus(controller.signal.aborted ? '重试已取消或超时。' : `重试失败：${error.message}`);
        } finally {
            clearTimeout(timeout);
            if (active === controller) setActive(undefined);
        }
    }

    retryButton.addEventListener('click', () => {
        if (active || retryTask || !receipt) return;
        retryTask = retryRecall(receipt).finally(() => { retryTask = undefined; });
    });

    function enqueue(action) {
        const key = chatKey(context());
        queue = queue.then(async () => {
            const ctx = context();
            if (chatKey(ctx) === key && ctx.chatId) await action(ctx);
        }).catch(error => { status.textContent = `自动隐藏失败：${error.message}`; });
        return queue;
    }

    const sync = () => enqueue(ctx => {
        if (!settings(ctx).hide || canRecall()) return syncHidden(ctx);
    });
    const onChatChanged = () => {
        clear();
        receipt = undefined;
        retryButton.hidden = true;
        showRetryStatus();
        status.textContent = '';
        inspectorQuery.textContent = '';
        inspectorContent.textContent = '这段聊天还没有回溯记录。';
        refreshControls();
        return sync();
    };
    ready.eventSource.on(events.CHAT_CHANGED, onChatChanged);
    ready.eventSource.on(events.MESSAGE_SENT, sync);
    ready.eventSource.on(events.MESSAGE_RECEIVED, sync);
    ready.eventSource.on(events.MESSAGE_DELETED, sync);
    ready.eventSource.on(events.GENERATION_STOPPED, generationId => {
        // TavernHelper includes its own request ID, while native Stop emits no ID.
        if (generationId === undefined) clear();
    });
    panel.addEventListener('floor-recall-connection-changed', onChatChanged);
    for (const control of Object.values(controls)) control.addEventListener('change', () => {
        const next = {
            hide: controls.hide.checked,
            recall: controls.recall.checked,
            bm25f: controls.bm25f.checked,
            keep: Math.min(999, Math.max(1, Math.trunc(Number(controls.keep.value) || DEFAULT_KEEP))),
        };
        clear();
        void enqueue(async ctx => {
            ctx.chatMetadata[SETTINGS_KEY] = next;
            const canSync = !next.hide || canRecall();
            if (!canSync || !await syncHidden(ctx)) await ctx.saveChat();
            if (chatKey(ctx) === chatKey(context())) refreshControls();
        });
    });
    refreshControls();
    void sync();

    globalThis.floorRecallBeforeGenerate = async (promptChat, _limit, _abort, type) => {
        if (!['normal', 'regenerate'].includes(type ?? 'normal')) return;
        if (type === 'regenerate' && retryTask && matchesReceipt(receipt, context()) &&
            receipt.snapshot.length === context().chat.length) {
            const key = chatKey(context());
            await retryTask;
            if (chatKey(context()) !== key) return;
        }
        clear();
        const ctx = context();
        if (!settings(ctx).recall || !canRecall()) return;
        const promptUser = promptChat.findLastIndex(message => message.is_user && !message.is_system);
        if (promptUser < 0) return;
        const floors = storyFloors(ctx.chat);
        const last = floors.at(-1)?.message;
        if (!last?.is_user) return;
        const historyCount = floors.length - 1 - RECENT_RECALL_WINDOW;
        const historyLength = floors[historyCount]?.floor;
        if (historyCount <= 0 || !floors.slice(0, historyCount).some(({message}) =>
            message.is_system && !Array.isArray(message.extra?.tool_invocations))) {
            status.textContent = '本轮无需查旧楼。';
            return;
        }
        const question = plainMessage(storyText(last.mes)).slice(0, 600);
        if (!question || /^(?:继续(?:剧情|写)?|接着(?:写|来)?|continue)[。！!\.\s]*$/i.test(question)) {
            status.textContent = '本轮沿用近期对话。';
            return;
        }
        const key = chatKey(ctx);
        const recent = floors.slice(historyCount, -1).filter(({message}) => !message.is_system)
            .map(({message}) => `${message.is_user ? '玩家' : '角色'}：${plainMessage(storyText(message.mes)).slice(-160)}`);
        const snapshot = ctx.chat.map(({mes, swipe_id, is_user, name}) => ({mes, swipe_id, is_user, name}));
        const bm25f = controls.bm25f.checked;
        const alreadyRetried = type === 'regenerate' && receipt?.retried && receipt.snapshot.length === snapshot.length &&
            receipt.bm25f === bm25f && matchesReceipt(receipt, ctx);
        const controller = new AbortController();
        setActive(controller);
        const timeout = setTimeout(() => controller.abort(), 45000);
        let query = '';
        try {
            let intent;
            if (!alreadyRetried) {
                status.textContent = '正在判断这轮是否需要回忆…';
                intent = await post('intent', {question, recent, chat_scope: key}, controller.signal);
                if (active !== controller || chatKey(context()) !== key) return;
                controller.signal.throwIfAborted();
                if (!intent.query) {
                    status.textContent = '本轮沿用近期对话。';
                    return;
                }
                receipt = {key, snapshot, historyLength, userFloor: floors.at(-1).floor, question, bm25f, recent: intent.requires_context ? recent.slice(-4) : []};
            }
            query = question;
            status.textContent = '正在回溯旧楼层…';
            inspectorQuery.textContent = `第 ${receipt.userFloor} 楼 · 检索问题：${query}`;
            inspectorContent.textContent = '正在检索…';
            retryButton.hidden = false;
            showRetryStatus();
            const result = await recall(snapshot.slice(0, historyLength), query, bm25f, controller.signal, key, receipt.recent);
            const now = context();
            if (active !== controller || chatKey(now) !== key) return;
            controller.signal.throwIfAborted();
            if (snapshot.length !== now.chat.length || !samePrefix(snapshot, now.chat)) {
                status.textContent = '聊天已变化，未注入回溯结果。';
                inspectorContent.textContent = `${status.textContent}\n${result.answer ?? ''}`;
                return;
            }
            panel.dataset.firstReadFloors = JSON.stringify(result.first_read_floors ?? []);
            const {sources, answer, citations} = recallEvidence(result, historyLength);
            if (!sources.length || !answer) {
                status.textContent = '检索完成，未找到有楼层依据的答案。';
                inspectorContent.textContent = answer || status.textContent;
                return;
            }
            if (!sources.some(floor => now.chat[floor].is_system && !Array.isArray(now.chat[floor].extra?.tool_invocations))) {
                status.textContent = '检索完成，引用楼层均未隐藏，未重复注入。';
                inspectorContent.textContent = `${status.textContent}\n\n${answer}\n依据：${citations}`;
                return;
            }
            const safeAnswer = answer.replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝');
            const injection = `本轮相关的历史回溯结论：\n${safeAnswer}\n依据：${citations}`;
            const userMessage = promptChat[promptUser];
            promptChat[promptUser] = {...userMessage, mes: `${injection}\n\n${userMessage.mes}`};
            inspectorContent.textContent = injection;
            const tokens = (intent?.usage?.total_tokens ?? 0) + (result.usage?.total_tokens ?? 0);
            const usageLabel = result.result_cache_hit ? ` · 已复用检索结果${tokens ? `，仅判读使用 ${tokens.toLocaleString()} token` : ''}` :
                (tokens ? ` · ${tokens.toLocaleString()} token` : '');
            const notesLabel = result.notes_used ? ` · 小纪要线索 ${result.notes_used} 条` : '';
            status.textContent = `本轮已注入回溯答案（${sources.length} 个来源）${usageLabel}${notesLabel}。`;
        } catch (error) {
            if (active !== controller || chatKey(context()) !== key) return;
            const stage = query ? '楼层检索' : '意图判读';
            if (!query) {
                receipt = undefined;
                retryButton.hidden = true;
                showRetryStatus();
            }
            status.textContent = `${stage}未完成，继续生成正文。`;
            inspectorQuery.textContent = `${query ? '检索问题' : '本轮输入'}：${query || question}`;
            inspectorContent.textContent = controller.signal.aborted ? `${stage}已取消或超时。` : `${stage}失败：${error.message}`;
        } finally {
            clearTimeout(timeout);
            if (active === controller) setActive(undefined);
        }
    };
}
