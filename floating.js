const STORAGE_KEY = 'floor-recall-position';
const MARGIN = 8;

function savedPosition() {
    try {
        const position = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) return position;
    } catch {}
    return undefined;
}

export function installFloatingPanel(panel) {
    const handle = panel.querySelector('[data-float-handle]');
    const viewport = window.visualViewport;
    let position = savedPosition();
    let drag;
    let ignoreClick = false;

    function place(next) {
        const x = viewport?.offsetLeft ?? 0;
        const y = viewport?.offsetTop ?? 0;
        const width = viewport?.width ?? window.innerWidth;
        const height = viewport?.height ?? window.innerHeight;
        panel.style.setProperty('--floor-recall-viewport-height', `${height}px`);
        panel.style.setProperty('--floor-recall-viewport-width', `${width}px`);
        if (!next) return;
        const rect = panel.getBoundingClientRect();
        panel.style.left = `${Math.max(x + MARGIN, Math.min(next.x, x + width - rect.width - MARGIN))}px`;
        panel.style.top = `${Math.max(y + MARGIN, Math.min(next.y, y + height - rect.height - MARGIN))}px`;
        panel.dataset.positioned = '';
    }

    handle.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        ignoreClick = false;
        const {left, top} = panel.getBoundingClientRect();
        drag = {id: event.pointerId, x: event.clientX, y: event.clientY, left, top};
    });
    window.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!ignoreClick && Math.hypot(dx, dy) < 6) return;
        if (!ignoreClick) handle.setPointerCapture(event.pointerId);
        ignoreClick = true;
        place({x: drag.left + dx, y: drag.top + dy});
    });
    function endDrag(event) {
        if (drag?.id !== event.pointerId) return;
        drag = undefined;
        if (!ignoreClick) {
            if (event.type === 'pointerup' && event.pointerType === 'touch') {
                panel.open = !panel.open;
                ignoreClick = true;
            }
            return;
        }
        const {left, top} = panel.getBoundingClientRect();
        position = {x: left, y: top};
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(position)); } catch {}
    }
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(event, endDrag);
    handle.addEventListener('click', event => {
        if (ignoreClick && event.detail > 0) event.preventDefault();
        ignoreClick = false;
    });
    const refresh = () => place(position);
    panel.addEventListener('toggle', refresh);
    window.addEventListener('resize', refresh);
    viewport?.addEventListener('resize', refresh);
    viewport?.addEventListener('scroll', refresh);
    new ResizeObserver(refresh).observe(panel);
    refresh();
}
