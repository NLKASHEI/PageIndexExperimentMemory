"""Persist short, source-linked hints from successful recalls."""

from collections import Counter
from contextlib import closing
from hashlib import sha256
import json
from math import log
from pathlib import Path
import re
import sqlite3

from bm25f import tokenize


MAX_NOTES_PER_CHAT = 128
MAX_NOTES_TOTAL = 4096
MAX_PROMPT_NOTES = 3
REVISION = re.compile(r"[0-9a-f]{64}")


def note_scope(data):
    scope = data.get('chat_scope')
    return sha256(scope.encode()).hexdigest() if isinstance(scope, str) and scope else None


def notes_path(tavern_root):
    return Path(tavern_root) / 'data' / 'default-user' / 'floor-recall-memories.sqlite3'


def floor_revision(records, floor):
    if type(floor) is not int or not 0 <= floor < len(records):
        return None
    record = records[floor]
    if not isinstance(record, dict) or record.get('floor') != floor:
        return None
    revision = record.get('revision')
    return revision if isinstance(revision, str) and REVISION.fullmatch(revision) else None


def question_key(question):
    return ' '.join(question.split()).casefold()


def select_notes(data, tavern_root):
    scope = note_scope(data)
    question, records = data.get('question'), data.get('records')
    if not scope or not isinstance(question, str) or not isinstance(records, list):
        return []
    path = notes_path(tavern_root)
    try:
        if not path.is_file():
            return []
        with closing(sqlite3.connect(path, timeout=0.25)) as db:
            rows = db.execute(
                'SELECT question, answer, sources FROM notes WHERE scope = ? ORDER BY rowid DESC LIMIT ?',
                (scope, MAX_NOTES_PER_CHAT),
            ).fetchall()
    except (sqlite3.Error, OSError):
        return []

    valid = []
    frequency = Counter()
    terms = set(tokenize(question))
    current_key = question_key(question)
    for previous, answer, sources in rows:
        try:
            citations = json.loads(sources)
        except json.JSONDecodeError:
            continue
        if not all(floor_revision(records, floor) == revision for floor, revision in citations):
            continue
        overlap = terms.intersection(tokenize(f'{previous} {answer}'))
        frequency.update(overlap)
        valid.append((current_key == question_key(previous), overlap, answer, [floor for floor, _ in citations]))

    ranked = []
    for exact, overlap, answer, floors in valid:
        if exact or len(overlap) >= 2:
            score = sum(log(1 + len(valid) / frequency[term]) for term in sorted(overlap))
            ranked.append((exact, score, max(floors), answer, floors))
    ranked.sort(key=lambda row: row[:3], reverse=True)
    return [(answer, floors) for _, _, _, answer, floors in ranked[:MAX_PROMPT_NOTES]]


def save_note(data, tavern_root, answer, floors):
    scope = note_scope(data)
    if not scope or not answer or not floors:
        return
    records = data['records']
    sources = [(floor, floor_revision(records, floor)) for floor in floors]
    if any(revision is None for _, revision in sources):
        return
    question = data['question']
    key = sha256(question_key(question).encode()).hexdigest()
    try:
        with closing(sqlite3.connect(notes_path(tavern_root), timeout=0.25)) as db, db:
            db.execute('''
                CREATE TABLE IF NOT EXISTS notes (
                    scope TEXT NOT NULL,
                    query_key TEXT NOT NULL,
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    sources TEXT NOT NULL,
                    UNIQUE (scope, query_key)
                )
            ''')
            db.execute('INSERT OR REPLACE INTO notes VALUES (?, ?, ?, ?, ?)',
                       (scope, key, question, ' '.join(answer.split()), json.dumps(sources)))
            db.execute('''
                DELETE FROM notes WHERE scope = ? AND rowid IN (
                    SELECT rowid FROM notes WHERE scope = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?
                )
            ''', (scope, scope, MAX_NOTES_PER_CHAT))
            db.execute('''
                DELETE FROM notes WHERE rowid <= (
                    SELECT rowid FROM notes ORDER BY rowid DESC LIMIT 1 OFFSET ?
                )
            ''', (MAX_NOTES_TOTAL,))
    except (sqlite3.Error, OSError):
        # SQLite is an optional source of hints. The recall result is still usable.
        return
