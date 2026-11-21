"""Local bridge from SillyTavern chat snapshots to the official PageIndex agent."""

import argparse
import asyncio
from collections import Counter, OrderedDict
from hashlib import sha256
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from math import log
from pathlib import Path
import re
import secrets
from select import select
from socket import MSG_PEEK
import sys
from tempfile import TemporaryDirectory
from threading import Lock
from time import monotonic
from recall_model_config import ModelRequestError, list_models, load_profiles, normalize_config, public_profiles, send_model_request, update_profiles

from pageindex import PageIndexAPIError, PageIndexLocalClient, md_to_tree
from pageindex.local_store import DocStore
from bm25f import rank_floors
from recall_notes import save_note, select_notes

ORIGINS = {"http://127.0.0.1:8000", "http://localhost:8000"}
TOKEN = secrets.token_urlsafe(32)
ACTIVE_QUERY = Lock()
RECALL_CONNECTIONS = {}
MAX_SNAPSHOT_BYTES = 36 * 1024 * 1024
ARCHIVE_NAME = "tavern-active-chat"
FLOORS_PER_SECTION = 24
PREVIEW_INTERVAL = 8
RESULT_CACHE_TTL = 600
RESULT_CACHE_MAX = 64
RESULT_CACHE = OrderedDict()
INTENT_RECENT_WINDOW = 15
RECALL_ANSWER_CHARS = 240
RECALL_MAX_CITATIONS = 5
RECALL_INSTRUCTIONS = (
    '你负责找出酒馆本轮用得上的历史背景。玩家下达行动或续写指令时，回溯相关的既有剧情。'
    '玩家直接询问历史时，回答所问的历史事实。'
    '用 PageIndex 的目录和读页工具查当前聊天。小纪要和候选楼层用于定位，回读原文取证，按需要跨区段扩查。'
    '同等相关时从新到旧，有明确时间要求时按题意查找。原楼层号等于 PageIndex 页码减 1。'
    f'返回一个 JSON 对象。answer 是面向本轮的历史结论，最多 {RECALL_ANSWER_CHARS} 字。'
    f'evidence 最多 {RECALL_MAX_CITATIONS} 条，填写支持结论的原楼层号和逐字短引文（建议 8–32 字）。'
    '格式为 {"evidence":[{"floor":0,"quote":"已读原文短句"}],"answer":"本轮需要的历史背景"}。'
)


class RecallError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def read_model_json(result, name, matches_schema, *, accept_complete_on_limit=False):
    choice = result['choices'][0]
    reason = choice.get('finish_reason')
    decoder = json.JSONDecoder()
    content = choice['message'].get('content')
    if reason in ('length', 'max_tokens'):
        if accept_complete_on_limit and isinstance(content, str):
            text = re.sub(r'^```(?:json)?\s*', '', content.strip(), count=1, flags=re.I)
            try:
                candidate, _ = decoder.raw_decode(text)
            except json.JSONDecodeError:
                pass
            else:
                if isinstance(candidate, dict) and matches_schema(candidate):
                    return candidate
        raise RecallError('output_limit', f'{name}达到模型输出上限，结果被截断。')
    if reason in ('content_filter', 'refusal'):
        raise RecallError('filtered', f'{name}被模型过滤或拒绝。')
    if reason in ('insufficient_system_resource', 'aborted', 'model_context_window_exceeded'):
        raise RecallError('interrupted', f'{name}在模型端中断。')
    if not isinstance(content, str) or not content.strip():
        raise RecallError('empty_answer', f'{name}没有返回可解析的正文。')

    start = 0
    parsed = None
    while (opening := content.find('{', start)) != -1:
        try:
            candidate, start = decoder.raw_decode(content, opening)
        except json.JSONDecodeError:
            start = opening + 1
            continue
        if isinstance(candidate, dict) and matches_schema(candidate):
            parsed = candidate
    if parsed is None:
        raise RecallError('invalid_answer', f'{name}返回的正文格式不符。')
    return parsed


def chat_session(data):
    scope = data.get("chat_scope")
    if not isinstance(scope, str):
        scope = ""
    return "ses_" + hmac.digest(TOKEN.encode(), scope[:1024].encode(), "sha256").hex()[:32]


def recall_cache_key(data, tavern_root):
    scope = data.get('chat_scope')
    revision = data.get('archive_revision')
    if (not isinstance(scope, str) or not scope or not isinstance(revision, str)
            or not re.fullmatch(r'[0-9a-f]{64}', revision)):
        return None
    profiles = load_profiles(tavern_root)
    active_id = profiles['active_id']
    config = profiles['profiles'].get(active_id)
    if not config:
        files = Path(tavern_root) / 'data' / 'default-user'
        config = {}
        for name in ('settings.json', 'secrets.json'):
            try:
                stat = (files / name).stat()
                config[name] = (stat.st_mtime_ns, stat.st_size)
            except FileNotFoundError:
                config[name] = None
    parts = [scope, revision, data.get('question'), data.get('recent'), data.get('bm25f') is True,
             data.get('records'), active_id, config]
    return sha256(json.dumps(parts, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()).digest()


def recall_with_cache(data, tavern_root, port, *, run_id):
    # /recall is already serialized with model setting changes.
    key = recall_cache_key(data, tavern_root)
    if key is not None and data.get('retry') is not True:
        previous = RESULT_CACHE.pop(key, None)
        if previous and monotonic() - previous[0] < RESULT_CACHE_TTL:
            RESULT_CACHE[key] = previous
            return {**previous[1], 'result_cache_hit': True, 'first_read_floors': [], 'pages_read': 0, 'notes_used': 0,
                    'calls': 0, 'tools': [],
                    'usage': {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}}
    notes = [] if data.get('retry') is True else select_notes(data, tavern_root)
    result = answer_archive(data, port, notes, run_id=run_id)
    save_note(data, tavern_root, result['answer'], result['floors'])
    if key is not None and result['floors'] and result['answer']:
        RESULT_CACHE[key] = (monotonic(), result)
        RESULT_CACHE.move_to_end(key)
        if len(RESULT_CACHE) > RESULT_CACHE_MAX:
            RESULT_CACHE.popitem(last=False)
    return {**result, 'result_cache_hit': False}


def speaker_label(record):
    role = '玩家' if record['is_user'] else '角色'
    speaker = record['speaker']
    return f'{role} · {speaker}' if speaker else role


def section_preview(records):
    samples = []
    for offset in range(0, len(records), PREVIEW_INTERVAL):
        record = next((row for row in records[offset:offset + PREVIEW_INTERVAL] if row['text']), None)
        if record:
            excerpt = ' '.join(record['text'].split())[:72]
            samples.append(f"{record['floor']}楼 {speaker_label(record)}：{excerpt}")
    return '\n'.join(samples)


def make_document(storage, records):
    lines = []
    ranges = {}
    pages = [{
        'page_index': record['floor'] + 1,
        'markdown': f"原聊天楼层 {record['floor']}\n{speaker_label(record)}：\n{record['text']}",
    } for record in records]
    offsets = range(0, len(records), FLOORS_PER_SECTION)
    for start in reversed(offsets):
        end = min(start + FLOORS_PER_SECTION, len(records))
        lines.append(f"# 第 {start}–{end - 1} 楼｜第 {start + 1}–{end} 页")
        ranges[len(lines)] = (start + 1, end, section_preview(records[start:end]))
    root = Path(storage)
    markdown = root / "outline.md"
    markdown.write_text("\n".join(lines), encoding="utf-8")
    outline = asyncio.run(md_to_tree(markdown))["structure"]
    for node in outline:
        start, end, summary = ranges[node.pop("line_num")]
        node.update(start_index=start, end_index=end, summary=summary)
    doc_id = ARCHIVE_NAME
    description = "楼层按聊天顺序编号，PageIndex 页码等于楼层号加 1。目录内容是各区段的对话摘录。"
    # This is an ephemeral local index. Keep the model-facing metadata stable
    # across searches when the same chat snapshot is used.
    metadata = {"id": doc_id, "name": ARCHIVE_NAME, "description": description, "status": "completed", "createdAt": "", "pageNum": len(pages), "folderId": None, "metadata": None, "mode": "markdown"}
    store = DocStore(str(root / "index"))
    with store.lock():
        store.save_document(doc_id, metadata, outline, pages)
    return doc_id, len(ranges)


def query_anchors(records, question):
    runs = re.findall(r'[\u3400-\u9fff]+|[^\W_\u3400-\u9fff]+', question.lower())
    terms = set()
    for word in runs:
        if '\u3400' <= word[0] <= '\u9fff':
            for size in range(2, min(5, len(word)) + 1):
                terms.update(word[i:i + size] for i in range(len(word) - size + 1))
        elif len(word) >= 2:
            terms.add(word)
    if not terms:
        return {}
    pattern = re.compile('|'.join(map(re.escape, sorted(terms, key=lambda item: (-len(item), item)))), re.I)
    hits = {}
    frequency = Counter()
    for row in records:
        matches = {}
        for match in pattern.finditer(row['text']):
            matches.setdefault(match[0].lower(), match.start())
        if matches:
            hits[row['floor']] = matches
            frequency.update(matches.keys())
    weight = {term: len(term) ** 1.5 * log((len(records) + 1) / (count + 0.5)) for term, count in frequency.items()}
    ranked = {}
    for floor, matches in hits.items():
        strongest = sorted(matches, key=weight.__getitem__, reverse=True)[:3]
        ranked[floor] = (sum(weight[term] for term in strongest), matches[strongest[0]])
    return dict(sorted(ranked.items(), key=lambda item: (-item[1][0], -item[0])))


def excerpt_around(text, position, limit):
    if len(text) <= limit:
        return text
    start = min(max(0, position - limit // 3), len(text) - limit)
    return text[start:start + limit]


def read_transcript(messages):
    calls = {}
    pages = {}
    first_read = []
    failed = set()
    for message in messages:
        for call in message.get('tool_calls') or []:
            calls[call.get('id')] = call.get('function', {}).get('name')
        if message.get('role') != 'tool' or calls.get(message.get('tool_call_id')) != 'get_page_content':
            continue
        content = message.get('content')
        if isinstance(content, list):
            content = '\n'.join(
                item['text'] for item in content if isinstance(item, dict) and isinstance(item.get('text'), str)
            )
        try:
            result = json.loads(content)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(result, dict):
            continue
        if isinstance(result.get('errorCode'), str):
            failed.add(result['errorCode'])
        batch = {}
        for item in result.get('content') or []:
            if isinstance(item, dict) and type(item.get('page')) is int and isinstance(item.get('text'), str):
                batch[item['page'] - 1] = item['text']
        if batch and not first_read:
            first_read = list(batch)
        pages.update(batch)
    return list(calls.values()), pages, first_read, failed


def verified_floors(evidence, pages):
    floors = []
    for item in evidence:
        if not isinstance(item, dict):
            continue
        floor, quote = item.get('floor'), item.get('quote')
        if type(floor) is not int or floor not in pages or not isinstance(quote, str):
            continue
        literal = ''.join(quote.strip().strip('“”"「」').split())
        _, _, source = pages[floor].partition('：\n')
        if len(literal) >= 4 and literal in ''.join(source.split()) and floor not in floors:
            floors.append(floor)
            if len(floors) == RECALL_MAX_CITATIONS:
                break
    return floors


def compact_recall_answer(text):
    answer = text.strip()
    if len(answer) <= RECALL_ANSWER_CHARS:
        return answer
    prefix = answer[:RECALL_ANSWER_CHARS - 1]
    end = max(prefix.rfind(mark) + 1 for mark in '。！？.!?\n')
    if end >= RECALL_ANSWER_CHARS // 2:
        prefix = prefix[:end]
    return prefix.rstrip() + '…'


def answer_archive(data, port, notes=(), *, run_id):
    question, records = data.get("question"), data.get("records")
    if not isinstance(question, str) or not question.strip() or len(question) > 600:
        raise RecallError('invalid_question', '检索问题须包含 1–600 个字符。')
    if not isinstance(records, list) or not 1 <= len(records) <= 6000:
        raise RecallError('archive_size', '聊天档案须包含 1–6000 楼。')
    for number, record in enumerate(records):
        if (not isinstance(record, dict) or type(record.get('floor')) is not int or record['floor'] != number
                or type(record.get('is_user')) is not bool
                or not isinstance(record.get('speaker'), str) or not isinstance(record.get('text'), str)):
            raise RecallError('archive_format', '聊天快照格式不符，请刷新酒馆再试。')

    recent = data.get('recent')
    context = '\n'.join(line[:140] for line in recent[-4:] if isinstance(line, str)) if isinstance(recent, list) else ''
    bm25f_enabled = data.get('bm25f') is True
    lexical_hints = rank_floors(records, question, limit=12) if bm25f_enabled else []
    anchors = query_anchors(records, question)
    candidates = lexical_hints or list(anchors)[:12]
    hints = []
    for floor in candidates:
        position = anchors.get(floor, (0, 0))[1]
        snippet = ' '.join(excerpt_around(records[floor]['text'], position, 80).split())
        hints.append(f'楼 {floor}（页 {floor + 1}）：{snippet}')

    parts = []
    if notes:
        lines = []
        for answer, floors in notes:
            references = '、'.join(f'{floor} 楼（页 {floor + 1}）' for floor in floors)
            lines.append(f'{references}：{answer}')
        parts.append('已有小纪要（定位线索）：\n' + '\n'.join(lines))
    if hints:
        label = 'BM25F 排序后的候选' if lexical_hints else '字面匹配候选'
        parts.append(f'{label}（定位线索）：\n' + '\n'.join(hints))
    if context:
        parts.append('近期对话（指代上下文）：\n' + context)
    parts.append('玩家本轮输入：' + question)
    prompt = '\n\n'.join(parts)

    with TemporaryDirectory(prefix='tavern-pageindex-') as directory:
        doc_id, sections = make_document(directory, records)
        client = PageIndexLocalClient(
            storage_path=str(Path(directory) / 'index'), chat_model='openai/gpt-4o-mini',
            chat_backend={'api_base': f'http://127.0.0.1:{port}/v1', 'api_key': TOKEN},
        )
        result = client.chat(prompt, doc_id=doc_id, protocol='chat_completions', extra_headers={
            'x-floor-recall-session': chat_session(data),
            'x-floor-recall-run': run_id,
        })
        usage = result.get('usage') or {}
        messages = result.get('messages') or []
        tools, pages, first_read, failed = read_transcript(messages)
        try:
            if not pages and failed:
                raise RecallError('page_read_failed', 'PageIndex 的读页工具未能读取请求的楼层。')
            parsed = read_model_json(result, 'PageIndex 回答', lambda item: (
                isinstance(item.get('answer'), str) and isinstance(item.get('evidence'), list)
            ), accept_complete_on_limit=True)
        except RecallError as error:
            error.usage = usage
            raise
        floors = verified_floors(parsed['evidence'], pages)
        answer = compact_recall_answer(parsed['answer'])
        return {
            'first_read_floors': first_read, 'answer': answer if answer and floors else '没有找到可核对的楼层证据。',
            'floors': floors if answer else [], 'scenes': sections,
            'calls': len(usage.get('request_usage_entries') or []) or sum(item.get('role') == 'assistant' for item in messages),
            'tools': tools, 'engine': 'PageIndex v0.7.4', 'pages_read': len(pages),
            'bm25f_enabled': bm25f_enabled, 'bm25f_floors': lexical_hints, 'notes_used': len(notes), 'usage': usage,
        }



def query_intent(data, tavern_root):
    question = data.get('question')
    recent = data.get('recent', [])
    if (not isinstance(question, str) or not 1 <= len(question) <= 600
            or not isinstance(recent, list) or len(recent) > INTENT_RECENT_WINDOW):
        raise ValueError('Invalid automatic recall intent')
    lines = '\n'.join(line[:170] for line in recent if isinstance(line, str))
    prompt = (
        '判断本轮是否需要近期对话之外的剧情背景，用 recall 表示是否需要查旧楼。'
        '用 requires_context 表示是否需要近期对话才能确定对象或指代。'
        '返回 JSON 对象 {"recall":true,"requires_context":false}。'
        f'\n最近对话：\n{lines}\n玩家本轮输入：{question}'
    )
    result = send_model_request(tavern_root, {'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0}, 256,
                                session_id=chat_session(data), stage='intent')
    plan = read_model_json(result, '意图判读', lambda item: (
        type(item.get('recall')) is bool and type(item.get('requires_context', False)) is bool
    ))
    return {'query': question if plan['recall'] else '', 'requires_context': plan.get('requires_context', False),
            'usage': result.get('usage') or {}}



def client_disconnected(connection):
    # The bridge serves plain loopback HTTP. A readable socket with no bytes
    # left has received EOF from the browser. Peek keeps request data intact.
    try:
        ready, _, _ = select([connection], [], [], 0)
        return bool(ready) and not connection.recv(1, MSG_PEEK)
    except (OSError, ValueError):
        return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def json_reply(self, status, payload):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if self.headers.get("Origin") in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        if self.headers.get("Origin") not in ORIGINS or self.path not in ('/recall', '/intent', '/model'):
            self.send_error(403)
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.json_reply(200, {'engine': 'PageIndex v0.7.4', 'ready': True})
        else:
            self.send_error(404)

    def do_POST(self):
        route = self.path
        if route == '/v1/chat/completions':
            if self.headers.get('Authorization') != 'Bearer ' + TOKEN:
                self.send_error(403)
                return
        elif route in ('/recall', '/intent', '/model'):
            if self.headers.get('Origin') not in ORIGINS:
                self.send_error(403)
                return
        else:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_SNAPSHOT_BYTES:
                self.json_reply(413, {'error': '档案快照超过当前原型的请求上限。'})
                return
            data = json.loads(self.rfile.read(length))
            if route == '/v1/chat/completions':
                self.relay(data)
            elif route == '/model' and data.get('action') == 'read':
                self.json_reply(200, public_profiles(load_profiles(self.server.tavern_root)))
            elif ACTIVE_QUERY.acquire(blocking=False):
                try:
                    if route == '/model':
                        result = self.configure_model(data)
                    elif route == '/intent':
                        result = query_intent(data, self.server.tavern_root)
                    else:
                        result = self.run_recall(data)
                        if client_disconnected(self.connection):
                            return
                    self.json_reply(200, result)
                finally:
                    ACTIVE_QUERY.release()
            else:
                self.json_reply(409, {'error': 'PageIndex 正在处理另一条检索。'})
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return
        except Exception as e:
            if route == '/recall' and client_disconnected(self.connection):
                return
            self.report_error(route, e)

    def report_error(self, route, error):
        status = 502
        code = type(error).__name__
        if isinstance(error, RecallError):
            code, message = error.code, str(error)
        elif isinstance(error, ModelRequestError):
            code, message = f'model_http_{error.status_code}', str(error)
            if route == '/v1/chat/completions':
                print(route, code, file=sys.stderr, flush=True)
                self.json_reply(error.status_code, {'error': {'message': message, 'type': 'upstream_error', 'code': code}})
                return
        elif isinstance(error, PageIndexAPIError) and error.status_code is not None:
            code = f'model_http_{error.status_code}'
            message = f'PageIndex 调用模型时收到 HTTP {error.status_code}。'
        elif isinstance(error, PageIndexAPIError) and 'within max_turns' in str(error):
            code, message = 'tool_turn_limit', 'PageIndex 达到 SDK 的工具轮数上限，尚未形成可核对的回答。'
        elif route == '/model' and isinstance(error, (ValueError, ConnectionError)):
            status = 400 if isinstance(error, ValueError) else 502
            message = str(error)
        else:
            message = f'PageIndex 处理失败（{code}）。'
        print(route, code, file=sys.stderr, flush=True)
        payload = {'error': message, 'code': code}
        if getattr(error, 'usage', None):
            payload['usage'] = error.usage
        self.json_reply(status, payload)

    def configure_model(self, data):
        root = self.server.tavern_root
        action = data.get('action')
        state = load_profiles(root)
        if action in ('save', 'activate', 'delete', 'set_key', 'clear_key'):
            return update_profiles(root, state, action, data)
        profile_id = data.get('id', '')
        if not isinstance(profile_id, str) or (profile_id and profile_id not in state['profiles']):
            raise ValueError('API 方案不存在，请重新打开面板。')
        previous = state['profiles'].get(profile_id, {})
        config = normalize_config(root, data, previous, require_model=action != 'models')
        if action == 'models':
            return {'models': list_models(root, config)}
        if data.get('action') == 'test':
            request = {'messages': [{'role': 'user', 'content': 'Reply only with OK.'}], 'temperature': 0}
            result = send_model_request(root, request, 128, config)
            if not result['choices'][0]['message'].get('content'):
                raise ConnectionError('模型连通，但未返回文本。请检查推理与输出长度设置。')
            return {'connected': True, 'model': result.get('model') or config.get('model')}
        raise ValueError('未知的模型配置操作。')

    def run_recall(self, data):
        run_id = secrets.token_urlsafe(18)
        RECALL_CONNECTIONS[run_id] = self.connection
        try:
            return recall_with_cache(data, self.server.tavern_root, self.server.server_port, run_id=run_id)
        finally:
            RECALL_CONNECTIONS.pop(run_id, None)

    def relay(self, request):
        connection = RECALL_CONNECTIONS.get(self.headers.get('x-floor-recall-run'))
        if connection is None or client_disconnected(connection):
            raise ModelRequestError('楼层回溯已取消。', 499)
        # Keep the SDK tools and document targeting. Its PDF discovery and
        # tool-error reporting instructions do not belong in AIRP recall.
        messages = [{'role': 'system', 'content': RECALL_INSTRUCTIONS}]
        messages.extend(message for message in request['messages'] if message.get('role') not in ('system', 'developer'))
        result = send_model_request(self.server.tavern_root, {**request, 'messages': messages}, 768,
                                    session_id=self.headers.get('x-floor-recall-session'), stage='recall')
        if client_disconnected(connection):
            raise ModelRequestError('楼层回溯已取消。', 499)
        result['model'] = request.get('model', 'gpt-4o-mini')
        self.json_reply(200, result)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tavern-root', required=True, type=Path)
    parser.add_argument('--port', type=int, default=17655)
    options = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', options.port), Handler)
    server.tavern_root = options.tavern_root
    server.serve_forever()
