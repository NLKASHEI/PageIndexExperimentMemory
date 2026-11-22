const WORDS = /[\u3400-\u9fff]+|[a-z0-9]+/g;

function tokens(text) {
    const terms = new Map();
    const add = term => terms.set(term, (terms.get(term) ?? 0) + 1);
    for (const part of text.normalize('NFKC').toLowerCase().match(WORDS) ?? []) {
        if (part[0] >= '\u3400' && part[0] <= '\u9fff') {
            for (let i = 1; i < part.length; i++) add(part.slice(i - 1, i + 1));
        } else {
            add(part);
        }
    }
    return terms;
}

export function lexicalFloors(records, question) {
    const query = [...tokens(question).keys()];
    if (!query.length) return [];
    const rows = records.map(record => [tokens(record.speaker), tokens(record.text)]);
    const widths = rows.map(fields => fields.map(field => [...field.values()].reduce((sum, count) => sum + count, 0)));
    const fieldWeights = [1.5, 1].map((weight, field) => ({
        weight, average: Math.max(1, widths.reduce((sum, row) => sum + row[field], 0) / rows.length),
    }));
    const rarity = query.map(term => {
        const frequency = rows.reduce((count, fields) => count + Number(fields.some(field => field.has(term))), 0);
        return Math.log1p((rows.length - frequency + 0.5) / (frequency + 0.5));
    });
    return rows.map((fields, floor) => {
        const score = query.reduce((sum, term, index) => {
            const strength = fields.reduce((count, field, i) => {
                const {weight, average} = fieldWeights[i];
                return count + weight * (field.get(term) ?? 0) / (0.4 + 0.6 * widths[floor][i] / average);
            }, 0);
            return sum + rarity[index] * (2.2 * strength) / (1.2 + strength);
        }, 0);
        return {floor: records[floor].floor, score};
    }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || b.floor - a.floor).slice(0, 12).map(row => row.floor);
}

export function queryAnchors(records, question) {
    const words = question.toLowerCase().match(/[\u3400-\u9fff]+|[\p{L}\p{N}]+/gu) ?? [];
    const terms = new Set();
    for (const word of words) {
        if (/^[\u3400-\u9fff]/.test(word)) {
            for (let size = 2; size <= Math.min(5, word.length); size++) {
                for (let start = 0; start <= word.length - size; start++) terms.add(word.slice(start, start + size));
            }
        } else if (word.length >= 2) {
            terms.add(word);
        }
    }
    if (!terms.size) return new Map();
    const pattern = new RegExp([...terms].sort((a,b) => b.length - a.length || a.localeCompare(b)).join('|'), 'giu');
    const counts = new Map();
    const hits = new Map();
    for (const record of records) {
        const found = new Map();
        for (const match of record.text.matchAll(pattern)) {
            const term = match[0].toLowerCase();
            if (!found.has(term)) {
                found.set(term, match.index);
                counts.set(term, (counts.get(term) ?? 0) + 1);
            }
        }
        if (found.size) hits.set(record.floor, found);
    }
    const weights = new Map([...counts].map(([term, count]) => [
        term, term.length ** 1.5 * Math.log((records.length + 1) / (count + 0.5)),
    ]));
    return new Map([...hits].map(([floor, matches]) => {
        const best = [...matches.keys()].sort((a,b) => weights.get(b) - weights.get(a)).slice(0, 3);
        return [floor, {at: matches.get(best[0]), score: best.reduce((sum, term) => sum + weights.get(term), 0)}];
    }).sort(([a, x], [b, y]) => y.score - x.score || b - a));
}
