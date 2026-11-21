const MAX_FLOOR_CHARS = 2400;
const ARCHIVE_TEXT_BUDGET = 7_000_000;

export function plainMessage(text) {
    return String(text ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/?[a-z][\w:-]*(?:\s[^<>]*)?\s*\/?>/gi, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/[^\S\r\n]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim();
}

function clipFloor(text, limit) {
    if (text.length <= limit) return text;
    const start = Math.floor((limit - 3) * 2 / 3);
    const end = limit - start - 3;
    return text.slice(0, start) + '\n…\n' + text.slice(-end);
}

export function archiveFloors(chat) {
    const limit = Math.min(MAX_FLOOR_CHARS, Math.floor(ARCHIVE_TEXT_BUDGET / Math.max(chat.length, 1)));
    return chat.map((message, floor) => ({
        floor,
        is_user: message.is_user === true,
        speaker: plainMessage(message.name).replace(/\n/g, ' ').slice(0, 80),
        text: clipFloor(plainMessage(message.mes), limit),
    }));
}
