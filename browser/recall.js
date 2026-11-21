import { lexicalFloors, queryAnchors } from './search.js';
import { cachedResult, noteFloors, rememberNote, rememberResult, resultKey } from './cache.js';

const FLOORS_PER_SECTION = 24;
const PAGE_CHAR_BUDGET = 95_000;
const MAX_TOOL_TURNS = 10;
const MAX_ANSWER_CHARS = 240;
const ENGINE = 'PageIndex 流程（浏览器）';
const SYSTEM = '你负责找出酒馆本轮用得上的历史背景。玩家下达行动或续写指令时，回溯相关的既有剧情。'
    + '玩家直接询问历史时，回答所问的历史事实。'
    + '用 PageIndex 的目录和读页工具查当前聊天。小纪要和候选楼层用于定位，回读原文取证，按需要跨区段扩查。'
    + '同等相关时从新到旧，有明确时间要求时按题意查找。原楼层号等于页码减 1。'
    + `返回一个 JSON 对象。answer 是面向本轮的历史结论，最多 ${MAX_ANSWER_CHARS} 字。`
    + 'evidence 最多 5 条，填写支持结论的原楼层号和逐字短引文（建议 8–32 字）。'
    + '格式为 {"evidence":[{"floor":0,"quote":"已读原文短句"}],"answer":"本轮需要的历史背景"}。';

const TOOLS = [
    {type: 'function', function: {name: 'get_document_structure', description: '读取聊天的树形区段目录，返回按时间倒序排列的区段、页码范围及代表性楼层预览。',
        parameters: {type: 'object', properties: {}, additionalProperties: false}}},
    {type: 'function', function: {name: 'get_page_content', description: '读取指定页码的聊天原文。使用单页、逗号列表或范围，例如 1,7,20-25。结果会标记尚待回读的页。',
        parameters: {type: 'object', properties: {pages: {type: 'string'}}, required: ['pages'], additionalProperties: false}}},
];

function answerJson(choice, matches) {
    const raw = choice.message.content;
    const text = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw.map(item => item?.text ?? '').join('') : '');
    const opening = text.indexOf('{');
    const closing = text.lastIndexOf('}');
    if (opening !== -1 && closing > opening) {
        try {
            const answer = JSON.parse(text.slice(opening, closing + 1));
            if (matches(answer)) return answer;
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    }
    if (['length', 'max_tokens'].includes(choice.finish_reason)) throw new Error('模型回答达到输出上限，结果被截断。');
    throw new Error('模型返回的答案格式不符。请确认当前酒馆模型支持工具调用。');
}

export async function browserIntent(request, connection, signal) {
    const lines = (request.recent ?? []).slice(-15).map(line => line.slice(0, 170)).join('\n');
    const text = '判断本轮是否需要近期对话之外的剧情背景，用 recall 表示是否需要查旧楼。'
        + '用 requires_context 表示是否需要近期对话才能确定对象或指代。'
        + '返回 JSON 对象 {"recall":true,"requires_context":false}。'
        + `\n最近对话：\n${lines}\n玩家本轮输入：${request.question}`;
    const response = await connection.complete([{role: 'user', content: text}], signal);
    const plan = answerJson(response.choices[0], item => typeof item?.recall === 'boolean');
    return {query: plan.recall ? request.question : '', requires_context: plan.requires_context === true, usage: response.usage ?? {}};
}

function label(record) {
    return (record.is_user ? '玩家' : '角色') + (record.speaker ? ` · ${record.speaker}` : '');
}

function makeTree(records) {
    const sections = [];
    for (let start = 0; start < records.length; start += FLOORS_PER_SECTION) {
        const end = Math.min(start + FLOORS_PER_SECTION, records.length);
        const preview = [];
        for (let at = start; at < end; at += 8) {
            const sample = records.slice(at, Math.min(at + 8, end)).find(row => row.text);
            if (sample) preview.push(`${sample.floor}楼 ${label(sample)}：${sample.text.replace(/\s+/g, ' ').slice(0, 72)}`);
        }
        sections.push({title: `第 ${start}–${end - 1} 楼`, start_index: start + 1, end_index: end, summary: preview.join('\n')});
    }
    return sections.reverse();
}

function pageNumbers(spec, count) {
    if (typeof spec !== 'string' || !/^\s*\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*\s*$/.test(spec)) {
        throw new Error('页码格式应为 1,7,20-25。');
    }
    const pages = new Set();
    for (const range of spec.split(',')) {
        const [start, end = start] = range.split(/[-–]/).map(Number);
        if (start < 1 || end < start) throw new Error('页码从 1 开始，范围结束页不得早于开始页。');
        for (let page = start; page <= Math.min(end, count); page++) pages.add(page);
    }
    if (!pages.size) throw new Error(`档案共有 ${count} 页，请使用有效页码。`);
    return [...pages].sort((a,b) => a - b);
}

function readPages(records, spec, read) {
    const pages = pageNumbers(spec, records.length);
    const content = [];
    let size = 0;
    for (const page of pages) {
        const record = records[page - 1];
        const text = `原聊天楼层 ${record.floor}\n${label(record)}：\n${record.text}`;
        const entry = read.has(page - 1) ? {page, already_read: true} : {page, text};
        const length = JSON.stringify(entry).length + 2;
        if (content.length && size + length > PAGE_CHAR_BUDGET) break;
        size += length;
        read.set(page - 1, record.text);
        content.push(entry);
    }
    return {content, remaining_pages: pages.slice(content.length)};
}

function compactAnswer(text) {
    if (text.length <= MAX_ANSWER_CHARS) return text;
    const prefix = text.slice(0, MAX_ANSWER_CHARS - 1);
    const end = Math.max(...[...'。！？.!?\n'].map(mark => prefix.lastIndexOf(mark) + 1));
    return (end >= MAX_ANSWER_CHARS / 2 ? prefix.slice(0, end) : prefix).trimEnd() + '…';
}

function citationsFor(evidence, read) {
    const floors = new Set();
    for (const claim of evidence) {
        if (!Number.isInteger(claim?.floor) || typeof claim.quote !== 'string' || !read.has(claim.floor)) continue;
        const quote = claim.quote.trim().replace(/^[“”"「」]+|[“”"「」]+$/g, '').replace(/\s+/g, '');
        if (quote.length < 4 || !read.get(claim.floor).replace(/\s+/g, '').includes(quote)) continue;
        floors.add(claim.floor);
        if (floors.size === 5) break;
    }
    return [...floors];
}

function promptFor(request, bm25f, notes) {
    const {records, question, recent} = request;
    const anchors = queryAnchors(records, question);
    const candidates = bm25f.length ? bm25f : [...anchors.keys()].slice(0, 12);
    const hints = candidates.map(floor => {
        const text = records[floor].text;
        const start = Math.max(0, Math.min((anchors.get(floor)?.at ?? 0) - 26, text.length - 80));
        return `楼 ${floor}（页 ${floor + 1}）：${text.slice(start, start + 80).replace(/\s+/g, ' ')}`;
    });
    const parts = [];
    if (notes.length) parts.push(`同题小纪要引用的原楼（定位线索）：${notes.map(floor => `${floor} 楼（页 ${floor + 1}）`).join('、')}`);
    if (hints.length) parts.push(`${bm25f.length ? 'BM25F 排序后的候选' : '字面匹配候选'}（定位线索）：\n${hints.join('\n')}`);
    if (recent?.length) parts.push('近期对话（指代上下文）：\n' + recent.slice(-4).map(line => line.slice(0, 140)).join('\n'));
    parts.push('玩家本轮输入：' + question);
    return parts.join('\n\n');
}

export async function browserRecall(request, connection, signal) {
    const {records} = request;
    if (!records.length || records.length > 6000) throw new Error('聊天档案须包含 1–6000 楼。');
    const key = resultKey(request, connection);
    const cached = request.retry ? undefined : cachedResult(key);
    if (cached) return cached;
    const tree = makeTree(records);
    const bm25f = request.bm25f ? lexicalFloors(records, request.question) : [];
    const notes = await noteFloors(request);
    const messages = [{role: 'system', content: SYSTEM + '已经读取的页可能返回 already_read，可从前面的工具结果核对。'},
        {role: 'user', content: promptFor(request, bm25f, notes)}];
    const meters = [];
    const read = new Map();
    const tools = new Set();
    let firstReadFloors = [];

    for (let turn = 1; turn <= MAX_TOOL_TURNS; turn++) {
        signal?.throwIfAborted();
        const response = await connection.complete(messages, signal, TOOLS);
        signal?.throwIfAborted();
        const choice = response.choices[0];
        if (response.usage) meters.push(response.usage);
        const assistant = choice.message;
        if (!assistant.tool_calls?.length) {
            const parsed = answerJson(choice, item => typeof item?.answer === 'string' && Array.isArray(item.evidence));
            const answer = compactAnswer(parsed.answer.trim());
            const floors = answer ? citationsFor(parsed.evidence, read) : [];
            const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(field =>
                [field, meters.reduce((sum, meter) => sum + (Number(meter[field]) || 0), 0)]));
            usage.total_tokens ||= usage.prompt_tokens + usage.completion_tokens;
            usage.request_usage_entries = meters;
            const result = {engine: ENGINE, answer: floors.length ? answer : '没有找到可核对的楼层证据。', floors,
                first_read_floors: firstReadFloors, scenes: tree.length, calls: turn, pages_read: read.size,
                tools: [...tools], usage, bm25f_enabled: request.bm25f, bm25f_floors: bm25f, notes_used: Number(notes.length > 0)};
            rememberResult(key, result);
            await rememberNote(request, result);
            return result;
        }

        messages.push({role: 'assistant', content: assistant.content ?? null, tool_calls: assistant.tool_calls,
            ...(assistant.reasoning_content ? {reasoning_content: assistant.reasoning_content} : {})});
        for (const call of assistant.tool_calls) {
            const name = call.function?.name;
            let output;
            try {
                if (name === 'get_document_structure') {
                    output = {total_pages: records.length, structure: tree};
                } else if (name === 'get_page_content') {
                    output = readPages(records, JSON.parse(call.function.arguments).pages, read);
                    if (!firstReadFloors.length) firstReadFloors = output.content.map(item => item.page - 1);
                } else {
                    throw new Error('可以读取区段目录或回读指定页。');
                }
                tools.add(name);
            } catch (error) {
                output = {error: error.message};
            }
            messages.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(output)});
        }
    }
    throw new Error('达到 10 轮工具调用上限，尚未形成可核对的回答。');
}
