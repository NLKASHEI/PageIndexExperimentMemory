const MAX_FLOOR_CHARS = 2400;
const UPDATE_BLOCK = /<UpdateVariable(?:\s[^>]*)?>[\s\S]*?<\/UpdateVariable\s*>/gi;
const STATUS_PLACEHOLDER = /<StatusPlaceHolder(?:Impl)?\s*\/?>/gi;

export function storyText(value) {
    return String(value ?? '').replace(UPDATE_BLOCK, '').replace(STATUS_PLACEHOLDER, '').trimEnd();
}

function isVariableUpdate(message) {
    const text = String(message.mes ?? '');
    return !message.is_user && /<UpdateVariable(?:\s[^>]*)?>/i.test(text) && !storyText(text).trim();
}

export function storyFloors(chat) {
    return chat.flatMap((message, floor) => isVariableUpdate(message) ? [] : [{message, floor}]);
}

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
    return storyFloors(chat).map(({message, floor}) => {
        const raw = storyText(message.mes);
        return {floor, is_user: message.is_user === true,
            speaker: plainMessage(message.name).replace(/\n/g, ' ').slice(0, 80), raw,
            text: plainMessage(sampleText(raw, MAX_FLOOR_CHARS))};
    });
}

export function chatKey(ctx) {
    return JSON.stringify([ctx.groupId ?? null, ctx.groupId ? null : ctx.characterId, ctx.chatId]);
}
