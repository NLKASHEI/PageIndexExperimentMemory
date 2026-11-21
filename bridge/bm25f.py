"""Field-weighted lexical ranking for candidate pages in the local PageIndex bridge."""

from collections import Counter
from math import log
import re
import unicodedata


WORD_PART = re.compile(r"[\u3400-\u9fff]+|[a-z0-9]+")
FIELD_WEIGHTS = (1.5, 1.0)


def tokenize(text):
    normalized = unicodedata.normalize("NFKC", text).lower()
    terms = Counter()
    for part in WORD_PART.findall(normalized):
        if "\u3400" <= part[0] <= "\u9fff":
            terms.update(part[index:index + 2] for index in range(len(part) - 1))
        else:
            terms[part] += 1
    return terms


def rank_floors(records, question, limit=5):
    """Rank floors using the speaker and message text fields."""
    query_terms = sorted(tokenize(question))
    if not records or not query_terms:
        return []
    rows = [(record["floor"], (tokenize(record["speaker"]), tokenize(record["text"]))) for record in records]
    averages = [max(1.0, sum(fields[index].total() for _, fields in rows) / len(rows)) for index in range(len(FIELD_WEIGHTS))]
    frequency = Counter()
    for _, fields in rows:
        frequency.update(set().union(*fields))
    inverse_frequency = {
        term: log(1 + (len(rows) - frequency[term] + 0.5) / (frequency[term] + 0.5))
        for term in query_terms if frequency[term]
    }
    ranked = []
    for floor, fields in rows:
        field_weights = [weight / (0.4 + 0.6 * field.total() / average) for weight, field, average in zip(FIELD_WEIGHTS, fields, averages, strict=True)]
        score = 0.0
        for term, idf in inverse_frequency.items():
            strength = sum(weight * field[term] for weight, field in zip(field_weights, fields, strict=True))
            if strength:
                score += idf * 2.2 * strength / (1.2 + strength)
        if score:
            ranked.append((-score, floor))
    return [floor for _, floor in sorted(ranked)[:limit]]
