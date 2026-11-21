"""Model routing and local settings for the floor recall bridge."""

import base64
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError
import urllib.parse
import urllib.request
from uuid import uuid4

from tavern_benchmark_model import TavernModel

if os.name == 'nt':
    import win32crypt
else:
    from cryptography.fernet import Fernet, InvalidToken

CONFIG_NAME = 'floor-recall-model.json'
RESERVED_FIELDS = {'model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'n'}
PROVIDERS = ('compatible', 'deepseek', 'commandcode', 'opencode_go')
OPENCODE_GO_BASE = '/inference/go'
OPENCODE_GO_LEGACY = '/zen/go/v1'


def opencode_go_path(url):
    address = urllib.parse.urlsplit(url)
    if (address.scheme, address.hostname, address.port) not in (('https', 'opencode.ai', None), ('https', 'opencode.ai', 443)):
        return ''
    for root in (OPENCODE_GO_BASE, OPENCODE_GO_LEGACY):
        if address.path == root or address.path.startswith(root + '/'):
            return root
    return ''


def provider_for(config):
    if config.get('provider') in PROVIDERS:
        return config['provider']
    url = config.get('url', '')
    host = urllib.parse.urlsplit(url).hostname
    if host == 'api.deepseek.com':
        return 'deepseek'
    if host == 'api.commandcode.ai':
        return 'commandcode'
    if opencode_go_path(url):
        return 'opencode_go'
    if config.get('thinking') in ('enabled', 'disabled') and 'deepseek' in config.get('model', '').lower():
        return 'deepseek'
    return 'compatible'


def config_path(root):
    return Path(root) / 'data' / 'default-user' / CONFIG_NAME


def load_profiles(root):
    try:
        state = json.loads(config_path(root).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {'active_id': '', 'profiles': {}}
    if 'profiles' in state:
        return state
    if not state.get('url') or not state.get('model'):
        return {'active_id': '', 'profiles': {}}
    profile = {**state, 'mode': 'custom', 'name': '原有 API 配置', 'thinking': 'default'}
    return {'active_id': 'legacy' if state.get('mode') == 'custom' else '', 'profiles': {'legacy': profile}}


def public_profiles(state):
    profiles = []
    for profile_id, config in state['profiles'].items():
        profile = {key: config[key] for key in ('name', 'url', 'model', 'extra')}
        provider = provider_for(config)
        thinking = config.get('thinking', 'default') if provider == 'deepseek' else 'default'
        profiles.append(dict(profile, id=profile_id, provider=provider, thinking=thinking, has_key=bool(config.get('protected_key'))))
    return {'active_id': state['active_id'], 'profiles': profiles}


def update_profiles(root, state, action, data):
    profiles = state['profiles']
    profile_id = data.get('id', '')
    if not isinstance(profile_id, str) or (profile_id and profile_id not in profiles):
        raise ValueError('API 方案不存在，请重新打开面板。')
    if action == 'save':
        copy_from = data.get('copy_from')
        if copy_from is not None and (profile_id or not isinstance(copy_from, str) or copy_from not in profiles):
            raise ValueError('要另存的 API 方案不存在，请重新打开面板。')
        previous = profiles.get(copy_from or profile_id, {})
        config = normalize_config(root, data, previous)
        name = data.get('name', '')
        if config['mode'] != 'custom' or not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
            raise ValueError('请输入 1–60 字的 API 方案名称。')
        name = name.strip()
        if name != profiles.get(profile_id, {}).get('name') and any(
            profile['name'].casefold() == name.casefold() for existing_id, profile in profiles.items() if existing_id != profile_id
        ):
            raise ValueError('已有同名 API 方案，请使用其他名称。')
        profile_id = profile_id or uuid4().hex
        profiles[profile_id] = dict(config, name=name)
        if data.get('activate') is False:
            profile_id = state['active_id']
    elif action == 'delete':
        if not profile_id:
            raise ValueError('请选择要删除的 API 方案。')
        del profiles[profile_id]
        profile_id = '' if profile_id == state['active_id'] else state['active_id']
    elif action in ('set_key', 'clear_key'):
        if not profile_id:
            raise ValueError('请选择要管理密钥的 API 方案。')
        profile = profiles[profile_id]
        expected_url = data.get('expected_url', profile['url'])
        if not isinstance(expected_url, str) or api_origin(expected_url) != api_origin(profile['url']):
            raise ValueError('方案地址已变化，请重新打开密钥管理。')
        key = data.get('key') if action == 'set_key' else ''
        if action == 'set_key' and (not isinstance(key, str) or not key.strip()):
            raise ValueError('请输入 API Key。')
        profile['protected_key'] = protect_key(root, key.strip()) if key else ''
        profile_id = state['active_id']
    state['active_id'] = profile_id
    save_config(root, state)
    return public_profiles(state)


def api_origin(url):
    address = urllib.parse.urlsplit(url)
    port = address.port
    if port is None:
        port = {'http': 80, 'https': 443}.get(address.scheme)
    return address.scheme, address.hostname, port


def portable_cipher(root, *, create=False):
    path = config_path(root).with_suffix('.key')
    if create and not path.exists():
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as file:
                file.write(Fernet.generate_key())
        except FileExistsError:
            pass
    return Fernet(path.read_bytes())


def protect_key(root, key):
    if os.name == 'nt':
        encrypted = win32crypt.CryptProtectData(key.encode('utf-8'), 'Floor Recall API Key', None, None, None, 0)
        return base64.b64encode(encrypted).decode('ascii')
    return 'fernet:' + portable_cipher(root, create=True).encrypt(key.encode('utf-8')).decode('ascii')


def normalize_config(root, data, previous, require_model=True):
    mode = data.get('mode')
    if mode not in ('tavern', 'custom'):
        raise ValueError('请选择有效的 API 来源。')
    url, model = data.get('url', '').strip(), data.get('model', '').strip()
    extra = data.get('extra', {})
    if not isinstance(extra, dict):
        raise ValueError('附加参数必须是 JSON 对象。')
    reserved = RESERVED_FIELDS.intersection(extra)
    if reserved:
        raise ValueError('由检索引擎管理的字段不能覆盖：' + '、'.join(sorted(reserved)))
    if mode == 'custom':
        address = urllib.parse.urlsplit(url)
        if address.scheme not in ('http', 'https') or not address.hostname or address.username or address.password or address.fragment:
            raise ValueError('请输入有效的 HTTP 或 HTTPS API 地址，密钥请填在单独的输入框。')
        if require_model and not model:
            raise ValueError('请输入模型 ID。')
    provider = data.get('provider')
    if provider is None:
        provider = provider_for({'url': url, 'model': model, 'thinking': data.get('thinking')})
    if provider not in PROVIDERS:
        raise ValueError('请选择有效的 API 渠道。')
    thinking = data.get('thinking', 'default') if provider == 'deepseek' else 'default'
    if thinking not in ('default', 'enabled', 'disabled'):
        raise ValueError('请选择有效的 DeepSeek 思考模式。')
    key = data.get('key', '').strip()
    if key:
        protected = protect_key(root, key)
    else:
        same_origin = api_origin(url) == api_origin(previous.get('url', ''))
        protected = previous.get('protected_key', '') if same_origin and data.get('forget_key') is not True else ''
    return {'mode': mode, 'provider': provider, 'url': url, 'model': model, 'extra': extra, 'thinking': thinking, 'protected_key': protected}


def save_config(root, config):
    path = config_path(root)
    with NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, prefix='.floor-recall-', delete=False) as file:
        temporary = Path(file.name)
    try:
        temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def api_endpoint(url, suffix):
    address = urllib.parse.urlsplit(url)
    if opencode_go_path(url) == OPENCODE_GO_BASE:
        path = OPENCODE_GO_BASE + ('/v1/models' if suffix == '/models' else '/openai/v1/chat/completions')
        return address._replace(path=path).geturl()
    path = address.path.rstrip('/')
    for endpoint in ('/chat/completions', '/models'):
        if path.endswith(endpoint):
            path = path[:-len(endpoint)]
            break
    return address._replace(path=path + suffix).geturl()


def custom_headers(root, config):
    headers = {'content-type': 'application/json'}
    protected = config.get('protected_key')
    if not protected:
        return headers
    if os.name == 'nt' and not protected.startswith('fernet:'):
        key = win32crypt.CryptUnprotectData(base64.b64decode(protected), None, None, None, 0)[1].decode('utf-8')
    elif os.name != 'nt' and protected.startswith('fernet:'):
        try:
            key = portable_cipher(root).decrypt(protected.removeprefix('fernet:').encode('ascii')).decode('utf-8')
        except (OSError, InvalidToken, ValueError):
            raise ValueError('无法读取本机保存的 API Key，请在密钥管理中重新保存。') from None
    else:
        raise ValueError('这是另一系统保存的 API Key，请在密钥管理中重新保存。')
    headers['authorization'] = 'Bearer ' + key
    return headers


def list_models(root, config):
    if config['mode'] != 'custom':
        raise ValueError('请选择独立 OpenAI 兼容 API。')
    request = urllib.request.Request(api_endpoint(config['url'], '/models'), headers=custom_headers(root, config))
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            payload = json.load(response)
    except HTTPError as error:
        raise ConnectionError(f'获取模型列表失败（HTTP {error.code}）。') from None
    models = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(models, list):
        raise ConnectionError('接口未返回 OpenAI 兼容的模型列表。')
    return sorted({item['id'] for item in models if isinstance(item, dict) and isinstance(item.get('id'), str) and item['id']})

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ModelRequestError(ConnectionError):
    def __init__(self, message, status_code=502):
        super().__init__(message)
        self.status_code = status_code


def send_model_request(tavern_root, options, max_tokens, config=None, session_id=None, stage=None):
    if config is None:
        state = load_profiles(tavern_root)
        config = state['profiles'].get(state['active_id'], {'mode': 'tavern'})
    model_input = {key: options[key] for key in ('messages', 'tools', 'tool_choice', 'temperature') if key in options}
    if config['mode'] == 'tavern':
        tavern_model = TavernModel(tavern_root, 8000)
        body = {**tavern_model.configuration, 'max_tokens': max_tokens, **model_input, 'stream': False}
        if 'deepseek' in body['model'].lower() and not body.get('custom_include_body'):
            body['custom_include_body'] = '{"thinking":{"type":"disabled"},"reasoning_effort":"none"}'
        url = tavern_model.base + '/api/backends/chat-completions/generate'
        headers = {'content-type': 'application/json', 'x-csrf-token': tavern_model.csrf}
        session = tavern_model.session
    else:
        body = {'max_tokens': max_tokens, **model_input, **config['extra'], 'model': config['model'], 'stream': False}
        thinking = config.get('thinking', 'default')
        if thinking != 'default':
            body['thinking'] = {'type': thinking}
            if thinking == 'disabled':
                body['reasoning_effort'] = 'none'
            elif body.get('reasoning_effort') == 'none':
                body.pop('reasoning_effort')
        url = api_endpoint(config['url'], '/chat/completions')
        if api_origin(url)[1] == 'api.deepseek.com':
            if stage == 'intent':
                body.setdefault('response_format', {'type': 'json_object'})
            thinking = body.get('thinking')
            thinking_type = thinking.get('type') if isinstance(thinking, dict) else None
            thinking_on = thinking_type == 'enabled' or (
                thinking_type != 'disabled' and body.get('reasoning_effort') != 'none'
            )
            if thinking_on and 'max_tokens' not in config['extra'] and stage in ('intent', 'recall'):
                body['max_tokens'] = 768 if stage == 'intent' else 2048
        headers = custom_headers(tavern_root, config)
        if opencode_go_path(config['url']):
            headers['User-Agent'] = 'FloorRecall/0.8'
            headers['x-opencode-session'] = session_id or 'ses_' + uuid4().hex
        session = urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8'), headers=headers)
    try:
        with session.open(request, timeout=35) as response:
            result = json.load(response)
    except HTTPError as error:
        raise ModelRequestError(f'模型接口返回 HTTP {error.code}。', error.code) from None
    except (TimeoutError, URLError) as error:
        if isinstance(getattr(error, 'reason', error), TimeoutError):
            raise ModelRequestError('等待模型接口响应超时。', 504) from None
        raise ModelRequestError('无法连接模型接口。') from None
    except json.JSONDecodeError:
        raise ModelRequestError('模型接口返回了无法读取的响应。') from None
    if not isinstance(result, dict) or not result.get('choices'):
        raise ModelRequestError('模型接口未返回 Chat Completions 结果。')
    return result
