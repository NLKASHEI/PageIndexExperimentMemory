const MAX_FLOOR_CHARS = 2400;

export function plainMessage(text) {
    return String(text ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/?[a-z][\w:-]*(?:\s[^<>]*)?\s*\/?>/gi, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/[^\S\r\n]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim();
}

export function sampleText(text, limit) {
    if (text.length <= limit) return text;
    const span = Math.floor((limit - 6) / 3);
    const middle = Math.floor((text.length - span) / 2);
    return [text.slice(0, span), text.slice(middle, middle + span), text.slice(-span)].join('\n…\n');
}

export function archiveFloors(chat) {
    return chat.map((message, floor) => ({
        floor,
        is_user: message.is_user === true,
        speaker: plainMessage(message.name).replace(/\n/g, ' ').slice(0, 80),
        raw: String(message.mes ?? ''),
        text: plainMessage(sampleText(String(message.mes ?? ''), MAX_FLOOR_CHARS)),
    }));
}

export function chatKey(ctx) {
    return JSON.stringify([ctx.groupId ?? null, ctx.groupId ? null : ctx.characterId, ctx.chatId]);
}
