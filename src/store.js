// 浏览器独立工作数据：分片存储元信息与单文档草稿，启动仅读取当前激活标签页。
let opening;
export function database() {
    return (opening ||= new Promise((resolve, reject) => {
        const request = indexedDB.open('preset-worldbook-workbench-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }));
}
export async function storePut(id, value) {
    const db = await database();
    return new Promise((resolve, reject) => {
        const t = db.transaction('records', 'readwrite');
        t.objectStore('records').put({ id, value, updatedAt: Date.now() });
        t.oncomplete = () => resolve(value);
        t.onerror = () => reject(t.error);
    });
}
export async function storePutMany(entries) {
    if (!entries.length) return;
    const db = await database();
    return new Promise((resolve, reject) => {
        const t = db.transaction('records', 'readwrite');
        const store = t.objectStore('records');
        const now = Date.now();
        for (const [id, value] of entries) store.put({ id, value, updatedAt: now });
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
    });
}
export async function storeGet(id) {
    const db = await database();
    return new Promise((resolve, reject) => {
        const r = db.transaction('records').objectStore('records').get(id);
        r.onsuccess = () => resolve(r.result?.value);
        r.onerror = () => reject(r.error);
    });
}
export async function storeList(prefix = '') {
    const db = await database();
    return new Promise((resolve, reject) => {
        const r = db.transaction('records').objectStore('records').getAll();
        r.onsuccess = () => resolve(r.result.filter((x) => x.id.startsWith(prefix)));
        r.onerror = () => reject(r.error);
    });
}
export async function storeDelete(id) {
    const db = await database();
    return new Promise((resolve, reject) => {
        const t = db.transaction('records', 'readwrite');
        t.objectStore('records').delete(id);
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
    });
}
export function dehydrateDraft(d) {
    if (!d) return null;
    // 持久化草稿时不写入整条撤销栈，仅保留当前态与原件快照，体积缩小 10~30 倍
    const { history, cursor, ...rest } = d;
    return rest;
}
export function hydrateDraft(d) {
    if (!d) return null;
    if (!Array.isArray(d.history) || !d.history.length) {
        d.history = [
            {
                raw: d.raw,
                label: '恢复草稿',
                unitIds: d.unitIds,
                rev: typeof d._rev === 'number' ? d._rev : 0,
            },
        ];
        d.cursor = 0;
    }
    return d;
}
