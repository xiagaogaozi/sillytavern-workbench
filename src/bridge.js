// 私有消息通道；不对外暴露任意宿主执行能力。
const TOKEN = location.hash.slice(1),
    ORIGIN = location.origin;
let serial = 0;
const pending = new Map(),
    listeners = new Map();
window.addEventListener('message', (event) => {
    if (
        event.source !== parent ||
        event.origin !== ORIGIN ||
        event.data?.token !== TOKEN ||
        event.data?.pww !== true
    )
        return;
    const m = event.data;
    if (m.event) {
        for (const fn of listeners.get(m.event) || []) fn(m.value);
        return;
    }
    const job = pending.get(m.id);
    if (!job) return;
    pending.delete(m.id);
    m.error ? job.reject(Error(m.error)) : job.resolve(m.value);
});
export function rpc(method, args = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        parent.postMessage({ pww: true, token: TOKEN, id, method, args }, ORIGIN);
    });
}
export function onHost(event, fn) {
    const list = listeners.get(event) || [];
    list.push(fn);
    listeners.set(event, list);
    return () =>
        listeners.set(
            event,
            list.filter((x) => x !== fn),
        );
}
