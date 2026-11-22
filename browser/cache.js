const resultCache = new Map();
const RESULT_TTL = 10 * 60 * 1000;
const MAX_RESULTS = 64;
const MAX_CHAT_NOTES = 128;
const MAX_NOTES = 4096;
const STORAGE = 'floor-recall-browser-v1:notes';

export function resultKey(request, connection) {
    if (!request.chat_scope || !request.archive_revision) return null;
    return JSON.stringify([request.chat_scope, request.archive_revision, request.directory_revision, request.question,
        request.recent, request.bm25f, connection.modelKey]);
}

export function cachedResult(key) {
    const cached = resultCache.get(key);
    if (!cached) return undefined;
    resultCache.delete(key);
    if (Date.now() - cached.at >= RESULT_TTL) return undefined;
    resultCache.set(key, cached);
    return {...cached.result, result_cache_hit: true, pages_read: 0, calls: 0, tools: [], notes_used: 0,
        first_read_floors: [], usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}};
}

export function rememberResult(key, result) {
    if (!key || !result.floors.length) return;
    resultCache.delete(key);
    resultCache.set(key, {at: Date.now(), result});
    if (resultCache.size > MAX_RESULTS) resultCache.delete(resultCache.keys().next().value);
}

function canStore(request) {
    return request.chat_scope && request.archive_revision && !request.recent?.length;
}

function normalize(question) {
    return question.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function readNotes() {
    const storage = globalThis.SillyTavern?.libs?.localforage ?? globalThis.localforage;
    return {storage, notes: (await storage?.getItem(STORAGE)) ?? []};
}

export async function noteFloors(request) {
    if (!canStore(request) || request.retry) return [];
    try {
        const {notes} = await readNotes();
        const question = normalize(request.question);
        const note = notes.find(entry => entry.scope === request.chat_scope && entry.question === question);
        if (note?.sources.every(([floor, revision]) => request.records[floor]?.revision === revision)) {
            return note.sources.map(([floor]) => floor);
        }
    } catch {}
    return [];
}

export async function rememberNote(request, result) {
    if (!canStore(request) || !result.floors.length) return;
    const sources = result.floors.map(floor => [floor, request.records[floor]?.revision]);
    if (sources.some(([, revision]) => !revision)) return;
    try {
        const {storage, notes} = await readNotes();
        const question = normalize(request.question);
        const scope = request.chat_scope;
        const note = {scope, question, answer: result.answer, sources};
        let otherChatEntries = 0;
        const retained = notes.filter(entry => entry.scope !== scope
            || (entry.question !== question && ++otherChatEntries < MAX_CHAT_NOTES));
        await storage?.setItem(STORAGE, [note, ...retained].slice(0, MAX_NOTES));
    } catch {}
}
