export const info = {
    id: 'floor-recall',
    name: 'Floor Recall Bridge Gateway',
    description: 'Connect the single-user SillyTavern UI to its local PageIndex service.',
};

const BRIDGE = 'http://127.0.0.1:17655';

async function proxy(req, res, route) {
    if (req.user?.profile?.handle !== 'default-user') {
        return res.status(403).json({error: '楼层回溯网关仅支持 default-user。'});
    }
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once('close', close);
    try {
        const options = {signal: controller.signal};
        if (req.method === 'POST') {
            options.method = 'POST';
            options.headers = {'Content-Type': 'application/json', Origin: 'http://127.0.0.1:8000'};
            options.body = JSON.stringify(req.body);
        }
        const upstream = await fetch(`${BRIDGE}/${route}`, options);
        const reply = await upstream.text();
        if (!controller.signal.aborted) res.status(upstream.status).type('application/json').send(reply);
    } catch {
        if (!controller.signal.aborted) res.status(502).json({error: '无法连接酒馆服务器上的 PageIndex 桥接服务。'});
    } finally {
        res.removeListener('close', close);
    }
}

export async function init(router) {
    router.get('/health', (req, res) => proxy(req, res, 'health'));
    for (const route of ['recall', 'intent', 'model']) {
        router.post(`/${route}`, (req, res) => proxy(req, res, route));
    }
}
