import { Popup, POPUP_RESULT, POPUP_TYPE } from '/scripts/popup.js';

const CHANNELS = {
    compatible: {label: 'OpenAI 兼容', url: ''},
    deepseek: {label: 'DeepSeek', url: 'https://api.deepseek.com', model: 'deepseek-flash'},
    commandcode: {label: 'Command Code', url: 'https://api.commandcode.ai/provider/v1'},
    opencode_go: {label: 'OpenCode Go', url: 'https://opencode.ai/inference/go/openai/v1'},
};
const COPY = POPUP_RESULT.CUSTOM1;
const REMOVE = POPUP_RESULT.CUSTOM2;

function sameOrigin(first, second) {
    try {
        return new URL(first).origin === new URL(second).origin;
    } catch {
        return false;
    }
}

function dialogContent(title, markup) {
    const content = document.createElement('section');
    content.className = 'floor-recall-dialog';
    const heading = document.createElement('h3');
    heading.textContent = title;
    content.append(heading);
    content.insertAdjacentHTML('beforeend', markup);
    return content;
}

const keyInput = '<input class="text_pole" data-api-key type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">';

export function installModelPanel(panel, post) {
    const drawer = panel.querySelector('[data-model-panel]');
    const selector = drawer.querySelector('select');
    const add = drawer.querySelector('[data-model-new]');
    const edit = drawer.querySelector('[data-model-edit]');
    const manageKey = drawer.querySelector('[data-model-key]');
    const testTavern = drawer.querySelector('[data-model-test]');
    const reload = drawer.querySelector('[data-model-reload]');
    const panelStatus = drawer.querySelector('[data-model-status]');
    const profileInfo = drawer.querySelector('[data-profile-info]');
    let state;
    let busy = false;

    function activeProfile() {
        return state?.profiles.find(profile => profile.id === state.active_id);
    }

    function refresh() {
        const profile = activeProfile();
        selector.disabled = add.disabled = !state || busy;
        edit.disabled = manageKey.disabled = testTavern.disabled = reload.disabled = busy;
        edit.hidden = manageKey.hidden = !profile;
        manageKey.textContent = profile?.has_key ? '管理密钥' : '设置密钥';
        testTavern.hidden = !state || Boolean(profile);
        profileInfo.hidden = !profile;
        if (profile) {
            profileInfo.textContent = `${profile.model} · ${profile.has_key ? '密钥已保存' : '未设置密钥'}`;
        }
    }

    function showState(next) {
        state = next;
        selector.replaceChildren(new Option('沿用酒馆连接', ''), ...next.profiles.map(profile => new Option(profile.name, profile.id)));
        selector.value = next.active_id;
        reload.hidden = true;
    }

    async function send(request, progress, status = panelStatus, content) {
        if (busy) return null;
        busy = true;
        refresh();
        if (content) content.inert = true;
        status.textContent = progress;
        try {
            const result = await post('model', request, AbortSignal.timeout(40000));
            if (Array.isArray(result.profiles)) showState(result);
            status.textContent = '';
            return result;
        } catch (error) {
            status.textContent = error.message;
            if (request.action === 'read') reload.hidden = false;
            return null;
        } finally {
            if (content) content.inert = false;
            busy = false;
            refresh();
        }
    }

    async function editProfile(profile) {
        const content = dialogContent(profile ? '编辑检索方案' : '新建检索方案', `
            <div class="floor-recall-dialog-grid">
                <label>方案名称 <input class="text_pole" name="apiName" maxlength="60" required></label>
                <label>渠道 <select class="text_pole" name="apiProvider"></select></label>
            </div>
            <label>API 地址 <input class="text_pole" name="apiUrl" type="url" placeholder="https://example.com/v1" required></label>
            <p data-saved-key hidden></p>
            <label data-draft-key>API Key <small>可选</small>${keyInput}</label>
            <label>模型 ID <input class="text_pole" name="apiModel" required></label>
            <div class="floor-recall-dialog-row">
                <select class="text_pole" data-model-options aria-label="从模型列表选择" disabled></select>
                <button class="menu_button" type="button" data-model-list>获取模型列表</button>
            </div>
            <label data-thinking hidden>DeepSeek 思考模式
                <select class="text_pole" name="apiThinking">
                    <option value="default">沿用接口 / JSON 设置</option>
                    <option value="disabled">关闭</option>
                    <option value="enabled">开启</option>
                </select>
            </label>
            <details>
                <summary>附加 JSON 参数</summary>
                <textarea class="text_pole" name="apiExtra" rows="4" aria-label="附加 JSON 参数" spellcheck="false"></textarea>
            </details>
            <button class="menu_button" type="button" data-test-editor>测试连接</button>
            <p data-dialog-status role="status"></p>
        `);
        const name = content.querySelector('[name=apiName]');
        const provider = content.querySelector('[name=apiProvider]');
        const url = content.querySelector('[name=apiUrl]');
        const key = content.querySelector('[data-api-key]');
        const model = content.querySelector('[name=apiModel]');
        const models = content.querySelector('[data-model-options]');
        const thinking = content.querySelector('[name=apiThinking]');
        const extra = content.querySelector('[name=apiExtra]');
        const savedKey = content.querySelector('[data-saved-key]');
        const status = content.querySelector('[data-dialog-status]');
        let keyAddress = '';

        function setModels(ids = []) {
            models.replaceChildren(new Option('从模型列表选择', ''), ...ids.map(id => new Option(id, id)));
            models.disabled = !ids.length;
            syncSelection();
        }
        function syncSelection() {
            models.value = model.value.trim();
            if (models.selectedIndex === -1) models.value = '';
        }
        function refreshFields() {
            const sameAddress = profile && sameOrigin(profile.url, url.value.trim());
            key.closest('label').hidden = Boolean(sameAddress);
            key.disabled = !url.validity.valid;
            savedKey.hidden = !profile;
            if (profile) {
                savedKey.textContent = sameAddress
                    ? (profile.has_key ? '密钥已保存。' : '未设置密钥。')
                    : '接口来源已更改，请填写新地址的密钥。';
            }
            thinking.closest('label').hidden = provider.value !== 'deepseek';
            setModels();
        }
        function request(action) {
            if (!url.reportValidity() || (action !== 'models' && !model.reportValidity())) return null;
            const body = {
                action, id: profile?.id ?? '', mode: 'custom', provider: provider.value, name: name.value.trim(),
                url: url.value.trim(), key: key.closest('label').hidden ? '' : key.value.trim(), model: model.value.trim(),
                thinking: thinking.value,
            };
            if (action === 'models') return body;
            try {
                body.extra = JSON.parse(extra.value.trim() || '{}');
                if (!body.extra || typeof body.extra !== 'object' || Array.isArray(body.extra)) {
                    throw new Error('附加参数必须是 JSON 对象。');
                }
                return body;
            } catch (error) {
                status.textContent = error instanceof SyntaxError ? '附加参数的 JSON 格式有误。' : error.message;
                extra.closest('details').open = true;
                extra.focus();
                return null;
            }
        }

        provider.replaceChildren(...Object.entries(CHANNELS).map(([id, channel]) => new Option(channel.label, id)));
        name.value = profile?.name ?? '';
        provider.value = profile?.provider ?? 'compatible';
        url.value = profile?.url ?? '';
        model.value = profile?.model ?? '';
        thinking.value = profile?.thinking ?? 'default';
        extra.value = JSON.stringify(profile?.extra ?? {}, null, 2);
        provider.addEventListener('change', () => {
            const channel = CHANNELS[provider.value];
            url.value = channel.url;
            model.value = channel.model ?? '';
            thinking.value = 'default';
            key.value = '';
            refreshFields();
        });
        url.addEventListener('input', () => {
            if (key.value && !sameOrigin(keyAddress, url.value.trim())) {
                key.value = '';
                status.textContent = 'API 地址已变更，请填入该地址的密钥。';
            }
            refreshFields();
        });
        key.addEventListener('input', () => {
            keyAddress = url.value.trim();
            setModels();
        });
        model.addEventListener('input', syncSelection);
        models.addEventListener('change', () => {
            if (models.value) model.value = models.value;
        });
        content.querySelector('[data-model-list]').addEventListener('click', async () => {
            const body = request('models');
            if (!body) return;
            const result = await send(body, '正在获取模型列表…', status, content);
            if (!result) return;
            setModels(result.models);
            status.textContent = result.models.length ? `已获取 ${result.models.length} 个模型。` : '接口没有返回模型，请填写模型 ID。';
        });
        content.querySelector('[data-test-editor]').addEventListener('click', async () => {
            const body = request('test');
            if (body && await send(body, '正在测试连接…', status, content)) status.textContent = '连接正常。';
        });
        refreshFields();

        await new Popup(content, POPUP_TYPE.CONFIRM, '', {
            okButton: profile ? '保存方案' : '保存并启用',
            cancelButton: '取消',
            wide: true,
            leftAlign: true,
            allowVerticalScrolling: true,
            customButtons: profile ? [
                {text: '另存为…', result: COPY},
                {text: '删除方案', result: REMOVE},
            ] : [],
            onClosing: async ({result}) => {
                if (busy) return false;
                if (result === REMOVE) {
                    const confirmed = await Popup.show.confirm('删除检索方案？', '这套方案及其密钥将被删除。检索会切回酒馆连接。');
                    return confirmed === POPUP_RESULT.AFFIRMATIVE &&
                        Boolean(await send({action: 'delete', id: profile.id}, '正在删除方案…', status, content));
                }
                if (![POPUP_RESULT.AFFIRMATIVE, COPY].includes(result)) return true;
                const body = request('save');
                if (!body) return false;
                if (result === COPY) {
                    const copyName = await Popup.show.input('另存为新方案', '新方案名称', '');
                    if (!copyName?.trim()) return false;
                    Object.assign(body, {id: '', copy_from: profile.id, name: copyName.trim()});
                } else if (!name.reportValidity()) {
                    return false;
                }
                return Boolean(await send(body, '正在保存方案…', status, content));
            },
            onClose: () => { key.value = ''; },
        }).show();
    }

    async function editKey(profile) {
        const content = dialogContent('管理密钥', `
            <p data-key-info></p>
            <label>新 API Key${keyInput}</label>
            <button class="menu_button" type="button" data-key-clear>清除密钥</button>
            <p data-dialog-status role="status"></p>
        `);
        const key = content.querySelector('[data-api-key]');
        const status = content.querySelector('[data-dialog-status]');
        const clear = content.querySelector('[data-key-clear]');
        content.querySelector('[data-key-info]').textContent = `${profile.name} · ${new URL(profile.url).host} · ${profile.has_key ? '已有密钥' : '未设置密钥'}`;
        clear.hidden = !profile.has_key;
        const binding = {id: profile.id, expected_url: profile.url};
        const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
            okButton: '保存密钥',
            cancelButton: '取消',
            leftAlign: true,
            onClosing: async ({result}) => {
                if (busy) return false;
                if (result !== POPUP_RESULT.AFFIRMATIVE) return true;
                const value = key.value.trim();
                if (!value) {
                    status.textContent = '请输入 API Key。';
                    key.focus();
                    return false;
                }
                if (!await send({action: 'set_key', ...binding, key: value}, '正在保存密钥…', status, content)) return false;
                panelStatus.textContent = '密钥已保存。';
                return true;
            },
            onClose: () => { key.value = ''; },
        });
        clear.addEventListener('click', async () => {
            const confirmed = await Popup.show.confirm('清除密钥？', '确认后立即从当前方案移除密钥。');
            if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
            if (await send({action: 'clear_key', ...binding}, '正在清除密钥…', status, content)) {
                panelStatus.textContent = '密钥已清除。';
                await popup.completeCancelled();
            }
        });
        await popup.show();
    }

    function read() {
        void send({action: 'read'}, '正在读取方案…');
    }

    drawer.addEventListener('toggle', () => {
        if (drawer.open && !state) read();
    });
    reload.addEventListener('click', read);
    selector.addEventListener('change', async () => {
        const selected = selector.value;
        await send({action: 'activate', id: selected}, '正在切换方案…');
        selector.value = state.active_id;
    });
    add.addEventListener('click', () => void editProfile());
    edit.addEventListener('click', () => void editProfile(activeProfile()));
    manageKey.addEventListener('click', () => void editKey(activeProfile()));
    testTavern.addEventListener('click', async () => {
        if (await send({action: 'test', mode: 'tavern'}, '正在测试连接…')) panelStatus.textContent = '连接正常。';
    });
    refresh();
}
