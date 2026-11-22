import { isGenerating } from '/script.js';
import { getStringHash } from '/scripts/utils.js';
import { chatKey, plainMessage, sampleText } from '../recall.js';

const KEY = 'floorRecallDirectory';
const VERSION = 1;
const BATCH = 24;
const BATCHES_PER_GROUP = 6;
const RETRY_DELAYS = [1500, 3000, 6000];
const fingerprints = new WeakMap();

export function messageRevision(message) {
    const {mes, name, is_user, swipe_id} = message;
    // Tavern may fill in swipe 0 when rendering a chat that was saved without a swipe ID.
    const attributes = JSON.stringify([name ?? '', is_user === true, Number(swipe_id) || 0]);
    const known = fingerprints.get(message);
    if (known && known.mes === mes && known.attributes === attributes) return known.id;
    const id = `${String(mes ?? '').length}:${getStringHash(String(mes ?? ''), getStringHash(attributes))}`;
    fingerprints.set(message, {mes, attributes, id});
    return id;
}

function stamp(revisions) {
    return String(getStringHash(revisions.join('|')));
}

export function savedDirectory(ctx) {
    const state = ctx.chatMetadata?.[KEY];
    return state?.version === VERSION && state.batches && typeof state.batches === 'object' ? state : null;
}

function validateDescription(result, start, end) {
    if (typeof result?.title !== 'string' || !result.title.trim() || !Array.isArray(result.scenes) ||
        !result.scenes.length || result.scenes.length > end - start || result.scenes[0]?.start !== start) return false;
    return result.scenes.every((scene, i) => Number.isInteger(scene?.start) && scene.start < end &&
        (i === 0 || scene.start > result.scenes[i - 1].start) && typeof scene.title === 'string' && scene.title.trim() &&
        typeof scene.summary === 'string' && scene.summary.trim());
}

function acceptedBatch(state, start, end, revisionFor) {
    const batch = state?.batches[start];
    if (!batch || !Number.isInteger(batch.end) || batch.end <= start || batch.end > end ||
        !validateDescription(batch, start, batch.end)) return null;
    const actual = Array.from({length: batch.end - start}, (_, offset) => revisionFor(start + offset));
    return batch.stamp === stamp(actual) ? batch : null;
}

function compact(text, limit) {
    return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function fallback(records, start, end) {
    const lines = [];
    for (let floor = start; floor < end; floor += 8) {
        const sample = records.slice(floor, Math.min(floor + 8, end)).find(record => record.text);
        if (sample) lines.push(`${sample.floor}楼 ${sample.speaker}：${compact(sample.text, 72)}`);
    }
    return {node_id: `range-${start}`, title: `第 ${start}–${end - 1} 楼`, start_index: start + 1, end_index: end,
        summary: lines.join('\n')};
}

export function makeDirectory(records, saved) {
    const batches = [];
    let indexed = 0;
    for (let start = 0; start < records.length; start += BATCH) {
        const end = Math.min(start + BATCH, records.length);
        const batch = acceptedBatch(saved, start, end, floor => records[floor].revision);
        if (!batch) {
            batches.push(fallback(records, start, end));
            continue;
        }
        const children = batch.scenes.map((scene, index) => ({node_id: `scene-${scene.start}`, title: scene.title,
            start_index: scene.start + 1, end_index: batch.scenes[index + 1]?.start ?? batch.end, summary: scene.summary}));
        if (batch.end < end) children.push(fallback(records, batch.end, end));
        batches.push({node_id: `batch-${start}`, title: batch.title, start_index: start + 1, end_index: end,
            summary: children.map(child => child.title).join('、'), children});
        indexed += batch.end - start;
    }

    if ((!indexed && batches.length <= 250) || batches.length <= BATCHES_PER_GROUP) return {nodes: batches.reverse(), indexed};
    const groups = [];
    for (let at = 0; at < batches.length; at += BATCHES_PER_GROUP) {
        const children = batches.slice(at, at + BATCHES_PER_GROUP);
        const start = children[0].start_index;
        const end = children.at(-1).end_index;
        groups.push({node_id: `group-${start}`, title: `第 ${start - 1}–${end - 1} 楼`, start_index: start,
            end_index: end, summary: children.map(child => compact(child.children ? `${child.title}：${child.summary}` : child.summary, 100)).join('\n'),
            children: children.reverse()});
    }
    return {nodes: groups.reverse(), indexed};
}

function findNode(nodes, id) {
    for (const node of nodes) {
        if (node.node_id === id) return node;
        const match = node.children && findNode(node.children, id);
        if (match) return match;
    }
}

export function outlineFor(nodes, id, total, indexed) {
    const node = id ? findNode(nodes, id) : null;
    if (id && !node) throw new Error('区段不存在，请从目录重新选择。');
    const children = node ? node.children ?? [node] : nodes;
    return {total_pages: total, indexed_floors: indexed, structure: children.map(({children, ...entry}) =>
        ({...entry, has_children: Boolean(children?.length)}))};
}

async function describeBatch(messages, start, connection, signal) {
    const end = start + messages.length;
    const lines = messages.map((message, i) =>
        `#${start + i} ${compact(String(message.name ?? ''), 36)}\n${plainMessage(sampleText(String(message.mes ?? ''), 720))}`);
    const prompt = `为一段角色扮演聊天建立可查找剧情的目录。按场景变化分段，连续楼层只属于一个场景，首个场景从 ${start} 楼开始。` +
        '标题写清实际发生的事，摘要写简短的事件、地点、当事人以及变化，供定位。只输出 JSON，形如 ' +
        '{"title":"整个区段的主要事件","scenes":[{"start":首楼号,"title":"场景标题","summary":"定位说明"}]}。\n\n' + lines.join('\n\n');
    const response = await connection.complete([{role: 'user', content: prompt}], signal, undefined, 'index');
    const choice = response?.choices?.[0];
    const content = choice?.message?.content;
    if (['length', 'max_tokens'].includes(choice?.finish_reason)) throw new Error('构造目录时模型输出被截断。');
    let data;
    if (typeof content === 'string') {
        const from = content.indexOf('{');
        const to = content.lastIndexOf('}');
        if (from >= 0 && to > from) {
            try { data = JSON.parse(content.slice(from, to + 1)); } catch {}
        }
    }
    if (!validateDescription(data, start, end)) throw new Error(`第 ${start}–${end - 1} 楼的目录格式无效。`);
    return {end, title: compact(data.title, 48), scenes: data.scenes.map(scene =>
        ({start: scene.start, title: compact(scene.title, 48), summary: compact(scene.summary, 120)}))};
}

function pendingBatches(ctx, state, fullOnly) {
    const ranges = [];
    let indexed = 0;
    for (let start = 0; start < ctx.chat.length; start += BATCH) {
        const end = Math.min(start + BATCH, ctx.chat.length);
        const batch = acceptedBatch(state, start, end, floor => messageRevision(ctx.chat[floor]));
        indexed += batch ? batch.end - start : 0;
        if (batch?.end !== end && (!fullOnly || end - start === BATCH)) ranges.push({start, end});
    }
    return {ranges, indexed};
}

function wait(ms, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        function cancel() {
            clearTimeout(timer);
            reject(signal.reason);
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', cancel);
            resolve();
        }, ms);
        signal.addEventListener('abort', cancel, {once: true});
    });
}

export function installDirectory(panel, openConnection, canRecall) {
    const context = () => SillyTavern.getContext();
    const build = panel.querySelector('[data-build-directory]');
    const pause = panel.querySelector('[data-pause-directory]');
    const progress = panel.querySelector('[data-directory-progress]');
    const status = panel.querySelector('[data-directory-status]');
    const drafts = new Map();
    let job;
    let timer;
    let outcome = '';

    function render() {
        const ctx = context();
        const state = savedDirectory(ctx);
        const {indexed} = pendingBatches(ctx, state, false);
        progress.max = ctx.chat.length || 1;
        progress.value = indexed;
        const plan = job?.key === chatKey(ctx) ? job : null;
        const total = ctx.chat.length;
        const hint = state ? `新满 ${BATCH} 楼后自动更新。` : '已有聊天点「构造目录」开始分批处理。';
        const activeLabel = plan && [`第 ${plan.batch} / ${plan.total} 批`, plan.waiting && '等待正文生成完成',
            plan.retry && `重试 ${plan.retry} / ${RETRY_DELAYS.length}`].filter(Boolean).join(' · ');
        status.textContent = !ctx.chatId ? '打开聊天后可构造目录。' :
            `已构造 ${indexed} / ${total} 楼 · ${activeLabel || outcome || (state?.paused ? '构造已暂停。' : hint)}`;
        build.disabled = Boolean(job) || !ctx.chatId || !total || (indexed === total && !state?.paused);
        pause.disabled = !plan || plan.controller.signal.aborted;
    }

    function getOrCreate(ctx) {
        return savedDirectory(ctx) ?? (ctx.chatMetadata[KEY] = {version: VERSION, batches: {}});
    }

    function queue() {
        clearTimeout(timer);
        timer = setTimeout(() => void run(false), 900);
    }

    async function run(manual) {
        const ctx = context();
        if (job || !ctx.chatId || !ctx.chat.length) return;
        const prior = savedDirectory(ctx);
        if (!manual && (!prior || prior.paused)) return;
        if (!canRecall()) {
            if (manual) { outcome = '请先选择可用的检索模型。'; render(); }
            return;
        }
        const {ranges} = pendingBatches(ctx, prior, !manual);
        if (!ranges.length) { render(); return; }
        const state = getOrCreate(ctx);
        state.paused = false;
        const runState = {key: chatKey(ctx), controller: new AbortController(), batch: 1, total: ranges.length};
        const {signal} = runState.controller;
        job = runState;
        const current = () => chatKey(context()) === runState.key && savedDirectory(context()) === state;
        let completed = false;
        try {
            const connection = openConnection();
            for (const [index, {start, end}] of ranges.entries()) {
                signal.throwIfAborted();
                runState.batch = index + 1;
                const messages = context().chat.slice(start, end);
                const revisions = messages.map(messageRevision);
                function checkSource() {
                    signal.throwIfAborted();
                    const active = context();
                    if (!current() || messages.length !== end - start || active.chat.length < end ||
                        revisions.some((value, i) => value !== messageRevision(active.chat[start + i]))) {
                        throw new Error('楼层已变化，请继续构造以重建受影响的区段。');
                    }
                }
                let batch;
                for (let attempt = 0; !batch; attempt++) {
                    runState.retry = attempt;
                    runState.waiting = isGenerating();
                    render();
                    if (attempt) await wait(RETRY_DELAYS[attempt - 1], signal);
                    while (isGenerating()) await wait(500, signal);
                    checkSource();
                    runState.waiting = false;
                    render();
                    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
                    try {
                        batch = await describeBatch(messages, start, connection, requestSignal);
                        requestSignal.throwIfAborted();
                    } catch (error) {
                        batch = undefined;
                        checkSource();
                        if (attempt >= RETRY_DELAYS.length) {
                            const message = requestSignal.aborted ? '单批目录构造超时。' : error.message;
                            throw new Error(`第 ${start}–${end - 1} 楼构造失败，已重试 ${attempt} 次。${message}`);
                        }
                    }
                }
                checkSource();
                state.batches[start] = {...batch, stamp: stamp(revisions)};
            }
            completed = true;
            if (current()) outcome = '本次构造完成，正在保存…';
        } catch (error) {
            if (current()) {
                state.paused = true;
                outcome = error.message;
            }
        } finally {
            if (current()) {
                try {
                    await context().saveMetadata();
                    if (completed && current()) outcome = '目录已随聊天保存。';
                } catch (error) {
                    if (current()) outcome = `目录保存失败：${error.message}`;
                }
            }
            if (!current()) {
                // A chat switch can replace the metadata while a request is pending.
                // Keep completed batches available for the next visit in this tab.
                drafts.set(runState.key, state);
                if (drafts.size > 4) drafts.delete(drafts.keys().next().value);
            }
            job = undefined;
            render();
            queue();
        }
    }

    function enter() {
        const ctx = context();
        const key = chatKey(ctx);
        if (job && job.key !== key) job.controller.abort(new Error('切换聊天，已停止当前构造。'));
        outcome = '';
        const draft = drafts.get(key);
        if (ctx.chatId && draft) {
            drafts.delete(key);
            const state = getOrCreate(ctx);
            for (const [key, batch] of Object.entries(draft.batches)) {
                const start = Number(key);
                const end = Math.min(start + BATCH, ctx.chat.length);
                if (acceptedBatch(draft, start, end, floor => messageRevision(ctx.chat[floor]))) state.batches[key] = batch;
            }
        }
        if (ctx.chatId && ctx.chat.length <= 2) getOrCreate(ctx);
        render();
        queue();
    }

    build.addEventListener('click', () => void run(true));
    pause.addEventListener('click', () => {
        job?.controller.abort(new Error('构造已暂停，可以继续。'));
        render();
    });
    panel.addEventListener('floor-recall-connection-changed', () => {
        job?.controller.abort(new Error('检索连接已变化，请继续构造。'));
        render();
        queue();
    });
    const {eventSource, eventTypes} = context();
    eventSource.on(eventTypes.CHAT_CHANGED, enter);
    for (const name of ['MESSAGE_SENT', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], () => { render(); queue(); });
    }
    enter();
}
