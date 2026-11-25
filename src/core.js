import * as database from './database-model.js';
import * as characters from './character-model.js';
// 完整 JSON 文档、草稿历史、SPreset 绑定、世界书元数据与纯数据操作。
export const clone = (value) => {
    if (value === undefined || value === null || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {}
    }
    return JSON.parse(JSON.stringify(value));
};
export const uuid = () =>
    globalThis.crypto?.randomUUID?.() ||
    'pww-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
export const META = '__WI_META_FOLDERS__';
export function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
        return (
            '{' +
            Object.keys(value)
                .sort()
                .filter((k) => value[k] !== undefined)
                .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
                .join(',') +
            '}'
        );
    return JSON.stringify(value);
}
export function equal(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        return Number.isNaN(a) && Number.isNaN(b);
    }
    const isArrA = Array.isArray(a);
    if (isArrA !== Array.isArray(b)) return false;
    if (isArrA) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            const va = a[i] === undefined ? null : a[i];
            const vb = b[i] === undefined ? null : b[i];
            if (!equal(va, vb)) return false;
        }
        return true;
    }
    const keysA = Object.keys(a);
    let countA = 0;
    for (let i = 0; i < keysA.length; i++) {
        const k = keysA[i];
        if (a[k] === undefined) continue;
        countA++;
        if (b[k] === undefined || !equal(a[k], b[k])) return false;
    }
    const keysB = Object.keys(b);
    let countB = 0;
    for (let i = 0; i < keysB.length; i++) {
        if (b[keysB[i]] !== undefined) countB++;
    }
    return countA === countB;
}
export function fingerprint(value) {
    const s = canonical(value);
    let a = 2166136261,
        b = 5381;
    for (let i = 0; i < s.length; i++) {
        a = Math.imul(a ^ s.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ s.charCodeAt(i);
    }
    return s.length + '-' + (a >>> 0).toString(16) + '-' + (b >>> 0).toString(16);
}
export function assertDocument(kind, raw) {
    if (database.isDatabaseKind(kind)) return database.assertNative(kind, raw);
    if (characters.isCharacterKind(kind)) return characters.assertCharacter(raw);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('文件必须是 JSON 对象');
    if (kind === 'preset') {
        if (!Array.isArray(raw.prompts) || !Array.isArray(raw.prompt_order))
            throw Error('预设必须包含 prompts 和 prompt_order；仅含扩展配置的文件不是完整预设');
        const ids = raw.prompts.map((e) => e.identifier);
        if (ids.some((x) => typeof x !== 'string' || !x) || new Set(ids).size !== ids.length)
            throw Error('预设条目标识缺失或重复');
    } else if (!raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries))
        throw Error('世界书必须包含 entries 对象');
    return raw;
}
export function emptyDocument(kind) {
    if (database.isDatabaseKind(kind)) return database.empty(kind);
    if (characters.isCharacterKind(kind)) return characters.emptyCharacter();
    return kind === 'preset'
        ? { prompts: [], prompt_order: [{ character_id: 100001, order: [] }], extensions: {} }
        : { entries: {} };
}
export function createDraft(kind, raw, name = '未命名', persisted = false, options = {}) {
    assertDocument(kind, raw);
    const fromLive = Boolean(options?.fromLive);
    const initialRaw = options?.takeOwnership ? raw : clone(raw);
    const unitIds =
        kind === 'contentReplace'
            ? initialRaw.promptGroup.map(() => uuid())
            : database.isPromptKind(kind)
              ? Object.fromEntries(Object.entries(initialRaw.groups).map(([key, value]) => [key, value.map(() => uuid())]))
              : characters.isCharacterKind(kind)
                ? (initialRaw.data?.alternate_greetings || []).map(() => 'alt:' + uuid())
                : undefined;
    return {
        unitIds,
        id: uuid(),
        kind,
        name,
        sourceName: persisted ? name : null,
        fromLive,
        raw: initialRaw,
        base: persisted || fromLive ? initialRaw : null,
        history: [{ raw: initialRaw, label: '载入', unitIds: unitIds ? clone(unitIds) : undefined, rev: 0 }],
        cursor: 0,
        _rev: 0,
        _savedRev: persisted || fromLive ? 0 : -1,
        selected: [],
        readonly: [],
        excluded: [],
        orderCharacter: 100001,
        pair: null,
    };
}
export function isLiveUnsaved(d) {
    return Boolean(d && d.fromLive && !d.sourceName && !dirty(d));
}
export function dirty(d) {
    if (!d) return false;
    if (!d.base) return true;
    if (d.raw === d.base) return false;
    if (typeof d._rev === 'number' && typeof d._savedRev === 'number') {
        if (d._rev === d._savedRev) return false;
        return true;
    }
    return !equal(d.raw, d.base);
}
let mutatingDepth = 0;
const entriesCache = new WeakMap();
export function invalidateEntriesCache(d) {
    if (d?.raw && typeof d.raw === 'object') entriesCache.delete(d.raw);
}
export function commit(d, label, fn) {
    const shared = (d.base && d.raw === d.base) || d.history?.[d.cursor]?.raw === d.raw;
    const before = shared ? d.raw : clone(d.raw);
    const beforeIds = d.unitIds ? clone(d.unitIds) : undefined;
    if (shared) d.raw = clone(d.raw);
    invalidateEntriesCache(d);
    mutatingDepth++;
    try {
        fn(d.raw);
        assertDocument(d.kind, d.raw);
    } catch (error) {
        d.raw = before;
        d.unitIds = beforeIds;
        invalidateEntriesCache(d);
        throw error;
    } finally {
        mutatingDepth--;
    }
    invalidateEntriesCache(d);
    if (equal(before, d.raw)) {
        d.raw = before;
        d.unitIds = beforeIds;
        return false;
    }
    const nextRev = (typeof d._rev === 'number' ? d._rev : 0) + 1;
    d._rev = nextRev;
    d.history = (d.history || []).slice(0, (d.cursor ?? 0) + 1);
    d.history.push({ raw: d.raw, label, unitIds: d.unitIds ? clone(d.unitIds) : undefined, rev: nextRev });
    if (d.history.length > 25) d.history.shift();
    d.cursor = d.history.length - 1;
    return true;
}
// 针对大世界书与大角色卡单条目编辑的结构共享快速提交：仅克隆被改动字段，其余庞大字段（如 character_book）零拷贝共享
export function commitEntry(d, entryId, label, mutator) {
    if (d?.kind === 'character') {
        const prevItem = findEntry(d, entryId);
        if (!prevItem) throw Error('条目已不存在');
        const beforeRaw = d.raw;
        const beforeIds = d.unitIds ? [...d.unitIds] : undefined;
        const nextData = { ...(d.raw.data || {}) };
        if (prevItem.isAltGreeting && Array.isArray(nextData.alternate_greetings)) {
            nextData.alternate_greetings = [...nextData.alternate_greetings];
        }
        if (entryId === 'depth_prompt' && nextData.extensions) {
            nextData.extensions = {
                ...nextData.extensions,
                depth_prompt: { ...(nextData.extensions.depth_prompt || {}) },
            };
        }
        const nextRaw = { ...d.raw, data: nextData };
        d.raw = nextRaw;
        invalidateEntriesCache(d);
        mutatingDepth++;
        try {
            mutator(prevItem);
            assertDocument(d.kind, d.raw);
        } catch (error) {
            d.raw = beforeRaw;
            d.unitIds = beforeIds;
            invalidateEntriesCache(d);
            throw error;
        } finally {
            mutatingDepth--;
        }
        invalidateEntriesCache(d);
        const afterItem = findEntry(d, entryId);
        if (afterItem && prevItem.content === afterItem.content && equal(beforeRaw, d.raw)) {
            d.raw = beforeRaw;
            d.unitIds = beforeIds;
            return false;
        }
        const nextRev = (typeof d._rev === 'number' ? d._rev : 0) + 1;
        d._rev = nextRev;
        d.history = (d.history || []).slice(0, (d.cursor ?? 0) + 1);
        d.history.push({ raw: d.raw, label, unitIds: d.unitIds ? [...d.unitIds] : undefined, rev: nextRev });
        if (d.history.length > 25) d.history.shift();
        d.cursor = d.history.length - 1;
        return true;
    }
    if (d?.kind !== 'worldbook') {
        return commit(d, label, () => {
            const item = findEntry(d, entryId);
            if (!item) throw Error('条目已不存在');
            mutator(item);
        });
    }
    const prevItem = findEntry(d, entryId);
    if (!prevItem) throw Error('条目已不存在');
    const key = prevItem.key;
    const origEntry = d.raw.entries[key];
    const clonedEntry = clone(origEntry);
    const beforeRaw = d.raw;
    const nextEntries = { ...d.raw.entries, [key]: clonedEntry };
    const nextRaw = { ...d.raw, entries: nextEntries };
    d.raw = nextRaw;
    invalidateEntriesCache(d);
    mutatingDepth++;
    try {
        const nextItem = { ...prevItem, raw: clonedEntry };
        mutator(nextItem);
        assertDocument(d.kind, d.raw);
    } catch (error) {
        d.raw = beforeRaw;
        invalidateEntriesCache(d);
        throw error;
    } finally {
        mutatingDepth--;
    }
    invalidateEntriesCache(d);
    if (equal(origEntry, clonedEntry)) {
        d.raw = beforeRaw;
        return false;
    }
    const nextRev = (typeof d._rev === 'number' ? d._rev : 0) + 1;
    d._rev = nextRev;
    d.history = (d.history || []).slice(0, (d.cursor ?? 0) + 1);
    d.history.push({ raw: d.raw, label, unitIds: undefined, rev: nextRev });
    if (d.history.length > 25) d.history.shift();
    d.cursor = d.history.length - 1;
    return true;
}
export function undo(d, step = -1) {
    if (!Array.isArray(d.history) || !d.history.length) return false;
    const i = d.cursor + step;
    if (i < 0 || i >= d.history.length) return false;
    d.cursor = i;
    d.raw = d.history[i].raw;
    d.unitIds = d.history[i].unitIds ? clone(d.history[i].unitIds) : undefined;
    d._rev = typeof d.history[i].rev === 'number' ? d.history[i].rev : (d._rev || 0) + 1;
    if (d.base && (d.raw === d.base || equal(d.raw, d.base))) d._savedRev = d._rev;
    invalidateEntriesCache(d);
    return true;
}
export function markSaved(d, name, raw) {
    const saved = clone(raw);
    d.name = name;
    d.sourceName = name;
    d.fromLive = false;
    d.raw = saved;
    d.base = saved;
    d._rev = (typeof d._rev === 'number' ? d._rev : 0) + 1;
    d._savedRev = d._rev;
    if (Array.isArray(d.history) && d.history[d.cursor]) {
        d.history[d.cursor].raw = saved;
        d.history[d.cursor].rev = d._rev;
    }
    invalidateEntriesCache(d);
}
export function orderNode(raw, character = 100001, create = false) {
    let node =
        raw.prompt_order?.find((e) => String(e.character_id) === String(character)) ||
        raw.prompt_order?.find((e) => String(e.character_id) === '100001') ||
        raw.prompt_order?.[0];
    if (!node && create) {
        raw.prompt_order ||= [];
        node = { character_id: character, order: [] };
        raw.prompt_order.push(node);
    }
    return node;
}
export function specialConfig(raw) {
    if (raw.extensions?.SPreset) return clone(raw.extensions.SPreset);
    const e = raw.prompts?.find((e) => e.identifier === 'SPresetSettings');
    if (e) {
        try {
            return JSON.parse(e.content || '{}');
        } catch {}
    }
    return {};
}
export function writeSpecialConfig(raw, config) {
    raw.extensions ||= {};
    raw.extensions.SPreset = clone(config);
    let p = raw.prompts.find((e) => e.identifier === 'SPresetSettings');
    if (!p) {
        p = {
            identifier: 'SPresetSettings',
            name: 'SPreset配置',
            content: '',
            role: 'system',
            enabled: false,
            system_prompt: false,
        };
        raw.prompts.push(p);
    }
    p.content = JSON.stringify(config);
    p.enabled = false;
    for (const group of raw.prompt_order || []) {
        const item = group.order?.find((e) => e.identifier === p.identifier);
        if (item) item.enabled = false;
    }
    entriesCache.delete(raw);
}
export function folderMeta(raw) {
    const entry = Object.values(raw.entries || {}).find((e) =>
        String(e.comment || e.name || '').startsWith(META),
    );
    try {
        const v = JSON.parse(entry?.content || '{}');
        return { version: 1, folders: [], entryFolderMap: {}, ...v };
    } catch {
        return { version: 1, folders: [], entryFolderMap: {} };
    }
}
export function writeFolderMeta(raw, meta) {
    let entry = Object.values(raw.entries).find((e) => String(e.comment || e.name || '').startsWith(META));
    if (!entry) {
        const uid = nextUid(raw);
        entry = {
            uid,
            comment: META,
            key: [],
            keysecondary: [],
            content: '',
            disable: true,
            constant: false,
            selective: true,
            order: 0,
            position: 0,
        };
        raw.entries[uid] = entry;
    }
    entry.comment = META;
    entry.content = JSON.stringify(meta);
    entry.disable = true;
    entry.constant = false;
    entry.key = [];
    entriesCache.delete(raw);
}
function computeEntriesBundle(d) {
    if (database.isDatabaseKind(d?.kind)) {
        const list = database.units(d);
        return { all: list, filtered: list, byId: new Map(list.map((e) => [e.id, e])) };
    }
    if (characters.isCharacterKind(d?.kind)) {
        const list = characters.characterUnits(d);
        return { all: list, filtered: list, byId: new Map(list.map((e) => [e.id, e])) };
    }
    if (!d || !d.raw) return { all: [], filtered: [], byId: new Map() };
    if (d.kind === 'preset') {
        const node = orderNode(d.raw, d.orderCharacter),
            order = node?.order || [],
            used = new Set();
        const allMap = new Map(d.raw.prompts.map((e) => [e.identifier, e]));
        const all = [];
        for (const o of order) {
            const p = allMap.get(o.identifier);
            if (p && !used.has(p.identifier)) {
                used.add(p.identifier);
                all.push(toView(d, p, o.enabled));
            }
        }
        for (const p of d.raw.prompts)
            if (!used.has(p.identifier)) all.push(toView(d, p, p.enabled ?? false));
        const filtered = all.filter((e) => e.id !== 'SPresetSettings');
        return { all, filtered, byId: new Map(all.map((e) => [e.id, e])) };
    }
    const meta = folderMeta(d.raw);
    const all = Object.entries(d.raw.entries || {})
        .map(([key, e]) => ({
            id: String(e.uid ?? key),
            key,
            name: String(e.comment || e.name || '未命名条目'),
            content: String(e.content || ''),
            enabled: !e.disable,
            role: ['system', 'user', 'assistant'][e.role ?? 0] || 'system',
            raw: e,
            group: meta.entryFolderMap[String(e.uid ?? key)] || '',
            marker: false,
            strategy: e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'selective',
        }))
        .sort(
            (a, b) => (a.raw.displayIndex ?? a.raw.order ?? 100) - (b.raw.displayIndex ?? b.raw.order ?? 100),
        );
    const filtered = all.filter((e) => !e.name.startsWith(META));
    return { all, filtered, byId: new Map(all.map((e) => [e.id, e])) };
}
function getEntriesBundle(d) {
    if (!d || !d.raw || typeof d.raw !== 'object') return { all: [], filtered: [], byId: new Map() };
    if (mutatingDepth > 0) return computeEntriesBundle(d);
    const sig = `${d.kind}|${d.orderCharacter ?? ''}|${d._rev ?? ''}`;
    const cached = entriesCache.get(d.raw);
    if (cached && cached.sig === sig && cached.unitIds === d.unitIds) return cached.bundle;
    const bundle = computeEntriesBundle(d);
    entriesCache.set(d.raw, { sig, unitIds: d.unitIds, bundle });
    return bundle;
}
export function entries(d, includeMeta = false) {
    const bundle = getEntriesBundle(d);
    return includeMeta ? bundle.all : bundle.filtered;
}
function toView(d, e, enabled) {
    return {
        id: e.identifier,
        name: String(e.name || e.identifier),
        content: String(e.content || ''),
        enabled: Boolean(enabled),
        role: e.role || 'system',
        marker: Boolean(e.marker),
        raw: e,
        group: d.raw.extensions?.presetWorldbookWorkbench?.groups?.[e.identifier] || '',
    };
}
export const findEntry = (d, id) => getEntriesBundle(d).byId.get(String(id));
export function nextUid(raw) {
    const ids = new Set(Object.entries(raw.entries || {}).map(([key, e]) => Number(e.uid ?? key)));
    let id = 0;
    while (ids.has(id)) id++;
    return id;
}
export function makeEntry(kind) {
    if (database.isDatabaseKind(kind)) return database.make(kind);
    if (characters.isCharacterKind(kind)) return { content: '' };
    return kind === 'preset'
        ? {
              identifier: uuid(),
              name: '新提示词',
              role: 'system',
              content: '',
              system_prompt: false,
              marker: false,
              injection_position: 0,
              injection_depth: 4,
              injection_order: 100,
              forbid_overrides: false,
              injection_trigger: [],
          }
        : {
              uid: 0,
              key: [],
              keysecondary: [],
              comment: '新条目',
              content: '',
              constant: false,
              vectorized: false,
              selective: true,
              selectiveLogic: 0,
              addMemo: true,
              order: 100,
              position: 0,
              disable: false,
              excludeRecursion: false,
              preventRecursion: false,
              delayUntilRecursion: false,
              probability: 100,
              useProbability: true,
              depth: 4,
              group: '',
              groupOverride: false,
              groupWeight: 100,
              scanDepth: null,
              caseSensitive: null,
              matchWholeWords: null,
              useGroupScoring: null,
              automationId: '',
              role: 0,
              sticky: 0,
              cooldown: 0,
              delay: 0,
              matchPersonaDescription: false,
              matchCharacterDescription: false,
              matchCharacterPersonality: false,
              matchCharacterDepthPrompt: false,
              matchScenario: false,
              matchCreatorNotes: false,
              ignoreBudget: false,
              triggers: [],
          };
}
const TOGGLEABLE_MARKERS = new Set([
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'worldInfoBefore',
    'worldInfoAfter',
    'main',
    'chatHistory',
    'dialogueExamples',
]);
export function canEditEntry(e) {
    return (
        !!e &&
        (!e.marker ||
            [
                'charDescription',
                'charPersonality',
                'scenario',
                'personaDescription',
                'worldInfoBefore',
                'worldInfoAfter',
            ].includes(e.id))
    );
}
export function canToggleEntry(e) {
    if (e?.toggleable !== undefined) return e.toggleable;
    return !!e && e.id !== 'SPresetSettings' && (!e.marker || TOGGLEABLE_MARKERS.has(e.id));
}
export function setEnabled(d, id, enabled) {
    if (database.isDatabaseKind(d.kind)) {
        const res = database.toggle(d, id, enabled);
        invalidateEntriesCache(d);
        return res;
    }
    const e = findEntry(d, id);
    if (!e || e.id === 'SPresetSettings') return;
    if (!canToggleEntry(e)) throw Error('此系统占位项按酒馆规则不可切换');
    if (d.kind === 'worldbook') e.raw.disable = !enabled;
    else {
        e.raw.enabled = enabled;
        const node = orderNode(d.raw, d.orderCharacter, true);
        let order = node.order.find((x) => x.identifier === id);
        if (!order) {
            order = { identifier: id };
            node.order.push(order);
        }
        order.enabled = enabled;
    }
    invalidateEntriesCache(d);
}
export function addEntry(d, raw, beforeId = null, enabled = true) {
    if (database.isDatabaseKind(d.kind)) {
        const res = database.insert(d, raw, beforeId);
        invalidateEntriesCache(d);
        return res;
    }
    if (characters.isCharacterKind(d.kind)) {
        const res = characters.insertAltGreeting(d, raw, beforeId);
        invalidateEntriesCache(d);
        return res;
    }
    const item = clone(raw || makeEntry(d.kind));
    let id;
    if (d.kind === 'preset') {
        id = item.identifier && !findEntry(d, item.identifier) ? item.identifier : uuid();
        if (item.marker && item.identifier && id !== item.identifier)
            throw Error('目标已有同一系统占位项，不能创建重复占位符');
        if (item.system_prompt === true && !item.marker && item.identifier !== id) item.system_prompt = false;
        item.identifier = id;
        d.raw.prompts.push(item);
        const node = orderNode(d.raw, d.orderCharacter, true);
        node.order ||= [];
        const at = node.order.findIndex((x) => x.identifier === beforeId);
        node.order.splice(at < 0 ? node.order.length : at, 0, { identifier: id, enabled });
        item.enabled = enabled;
    } else {
        id = String(nextUid(d.raw));
        item.uid = Number(id);
        d.raw.entries[id] = item;
        invalidateEntriesCache(d);
        const order = entries(d)
            .map((e) => e.id)
            .filter((x) => x !== id);
        const at = order.indexOf(beforeId);
        order.splice(at < 0 ? order.length : at, 0, id);
        reorder(d, order);
    }
    invalidateEntriesCache(d);
    return id;
}
export function removeEntries(d, ids) {
    if (database.isDatabaseKind(d.kind)) {
        const res = database.remove(d, ids);
        invalidateEntriesCache(d);
        return res;
    }
    if (characters.isCharacterKind(d.kind)) {
        characters.removeAltGreetings(d, ids);
        invalidateEntriesCache(d);
        return;
    }
    const selected = new Set(ids.map(String));
    if (d.kind === 'preset') {
        const protectedItems = entries(d, true).filter(
            (e) =>
                selected.has(e.id) &&
                (e.marker || e.raw.system_prompt === true || e.id === 'SPresetSettings'),
        );
        if (protectedItems.length) throw Error('内置系统或占位条目不能删除，请按原生规则禁用或重排');
        d.raw.prompts = d.raw.prompts.filter((e) => !selected.has(e.identifier));
        for (const n of d.raw.prompt_order)
            n.order = (n.order || []).filter((e) => !selected.has(e.identifier));
        const cfg = specialConfig(d.raw);
        let changed = false;
        for (const id of selected)
            for (const key of ['ToolBindings', 'MessageInjections'])
                if (cfg[key]?.[id]) {
                    delete cfg[key][id];
                    changed = true;
                }
        if (changed) writeSpecialConfig(d.raw, cfg);
    } else {
        for (const [key, e] of Object.entries(d.raw.entries))
            if (selected.has(String(e.uid ?? key)) && !String(e.comment || '').startsWith(META))
                delete d.raw.entries[key];
        const meta = folderMeta(d.raw);
        for (const id of selected) delete meta.entryFolderMap[id];
        if (meta.folders.length) writeFolderMeta(d.raw, meta);
    }
    invalidateEntriesCache(d);
}
export function reorder(d, ids) {
    if (database.isDatabaseKind(d.kind)) {
        const res = database.order(d, ids);
        invalidateEntriesCache(d);
        return res;
    }
    if (characters.isCharacterKind(d.kind)) {
        characters.reorderAltGreetings(d, ids);
        invalidateEntriesCache(d);
        return;
    }
    const list = entries(d, true),
        unique = [...new Set(ids.map(String))];
    for (const e of list) if (!unique.includes(e.id)) unique.push(e.id);
    if (d.kind === 'preset') {
        const node = orderNode(d.raw, d.orderCharacter, true);
        const state = new Map(list.map((e) => [e.id, e.enabled]));
        node.order = unique
            .filter((id) => state.has(id))
            .map((identifier) => ({
                ...(node.order || []).find((x) => x.identifier === identifier),
                identifier,
                enabled: state.get(identifier),
            }));
    } else
        unique.forEach((id, i) => {
            const e = findEntry(d, id);
            if (e) e.raw.displayIndex = i;
        });
    invalidateEntriesCache(d);
}
export function moveEntries(d, ids, beforeId) {
    if(database.isPromptKind(d.kind) && beforeId){const all=entries(d),target=all.find(e=>e.id===beforeId);if(target&&all.some(e=>ids.includes(e.id)&&e.group!==target.group))throw Error('只能在同一原生提示词分组内排序');}
    const chosen = new Set(ids.map(String));
    if (chosen.has(beforeId)) return;
    const list = entries(d).map((e) => e.id),
        moving = list.filter((id) => chosen.has(id)),
        rest = list.filter((id) => !chosen.has(id));
    const at = rest.indexOf(beforeId);
    rest.splice(at < 0 ? rest.length : at, 0, ...moving);
    reorder(d, rest);
}
export function transfer(source, target, ids, beforeId = null) {
    if (database.isDatabaseKind(source.kind) || database.isDatabaseKind(target.kind)) {
        const res = database.copyUnits(source, target, ids, beforeId);
        invalidateEntriesCache(target);
        return res;
    }
    if (characters.isCharacterKind(source.kind) || characters.isCharacterKind(target.kind)) {
        const res = characters.copyCharacterUnits(source, target, ids, beforeId);
        invalidateEntriesCache(target);
        return res;
    }
    const selected = entries(source).filter((e) => ids.includes(e.id));
    const mappings = [];
    for (const e of selected) {
        if (source.kind === 'preset' && e.marker && target.kind !== 'preset')
            throw Error('动态系统占位内容不能直接转换为世界书，请选择普通条目');
        if (source.kind === 'preset' && e.marker && target.kind === 'preset' && findEntry(target, e.id))
            throw Error('目标已有同一系统占位项，不能复制重复占位符');
        let raw = clone(e.raw);
        if (source.kind !== target.kind) {
            raw = makeEntry(target.kind);
            if (target.kind === 'preset') {
                raw.name = e.name;
                raw.content = e.content;
                raw.role = e.role;
            } else {
                raw.comment = e.name;
                raw.content = e.content;
                raw.constant = true;
                raw.disable = !e.enabled;
            }
        }
        const newId = addEntry(target, raw, beforeId, e.enabled);
        mappings.push({ oldId: e.id, newId });
        if (source.kind === 'preset' && target.kind === 'preset') {
            const from = specialConfig(source.raw),
                to = specialConfig(target.raw);
            let changed = false;
            for (const key of ['ToolBindings', 'MessageInjections'])
                if (from[key]?.[e.id]) {
                    to[key] ||= {};
                    to[key][newId] = clone(from[key][e.id]);
                    if (key === 'ToolBindings') to[key][newId].uuid = uuid();
                    changed = true;
                }
            if (changed) writeSpecialConfig(target.raw, to);
        }
        if (source.kind === 'worldbook' && target.kind === 'worldbook' && e.group) {
            const a = folderMeta(source.raw),
                b = folderMeta(target.raw),
                folder = a.folders.find((f) => f.id === e.group);
            if (folder) {
                let dest = b.folders.find((f) => f.name === folder.name);
                if (!dest) {
                    dest = { id: uuid(), name: folder.name };
                    b.folders.push(dest);
                }
                b.entryFolderMap[newId] = dest.id;
                writeFolderMeta(target.raw, b);
            }
        }
    }
    return mappings;
}
const pairCache = new WeakMap();
export function pairEntries(left, right) {
    if (!left || !right) return [];
    const lKey = `${left._rev ?? ''}|${left.orderCharacter ?? ''}|${left.sourceName ?? ''}`;
    const rKey = `${right._rev ?? ''}|${right.orderCharacter ?? ''}|${right.sourceName ?? ''}`;
    let rightMap = pairCache.get(left);
    if (!rightMap) {
        rightMap = new WeakMap();
        pairCache.set(left, rightMap);
    }
    const cached = rightMap.get(right);
    if (cached && cached.lKey === lKey && cached.rKey === rKey && cached.lRaw === left.raw && cached.rRaw === right.raw) {
        return cached.pairs;
    }
    const a = entries(left),
        b = entries(right),
        unused = new Set(b.map((e) => e.id)),
        stableIdentity = left.kind === 'preset' || (left.sourceName && left.sourceName === right.sourceName),
        aIdSet = new Set(a.map((e) => e.id)),
        reserved = new Set(stableIdentity ? b.filter((e) => aIdSet.has(e.id)).map((e) => e.id) : []);
    const bById = new Map(b.map((e) => [e.id, e]));
    const bByContent = new Map();
    const bByName = new Map();
    for (const e of b) {
        if (e.content && !reserved.has(e.id)) {
            let list = bByContent.get(e.content);
            if (!list) { list = []; bByContent.set(e.content, list); }
            list.push(e);
        }
        if (!reserved.has(e.id)) {
            let list = bByName.get(e.name);
            if (!list) { list = []; bByName.set(e.name, list); }
            list.push(e);
        }
    }
    const aNameCount = new Map();
    for (const l of a) aNameCount.set(l.name, (aNameCount.get(l.name) || 0) + 1);
    const pairs = a.map((l) => {
        let r;
        if (stableIdentity) {
            const hit = bById.get(l.id);
            if (hit && unused.has(hit.id)) r = hit;
        }
        if (!r && l.content) {
            const cands = (bByContent.get(l.content) || []).filter(
                (e) => unused.has(e.id) && (!l.group || e.group === l.group),
            );
            if (cands.length === 1) r = cands[0];
        }
        if (!r && aNameCount.get(l.name) === 1) {
            const cands = (bByName.get(l.name) || []).filter((e) => unused.has(e.id));
            if (cands.length === 1) r = cands[0];
        }
        if (r) unused.delete(r.id);
        return {
            left: l,
            right: r || null,
            status: !r
                ? 'removed'
                : l.content !== r.content
                  ? 'content'
                  : equal(comparable(l), comparable(r))
                    ? 'same'
                    : 'settings',
        };
    });
    for (const r of b) if (unused.has(r.id)) pairs.push({ left: null, right: r, status: 'added' });
    rightMap.set(right, { lKey, rKey, lRaw: left.raw, rRaw: right.raw, pairs });
    return pairs;
}
export function pairIndex(left, right) {
    const pairs = pairEntries(left, right);
    const leftMap = new Map(),
        rightMap = new Map();
    for (const p of pairs) {
        if (p.left) leftMap.set(p.left.id, p);
        if (p.right) rightMap.set(p.right.id, p);
    }
    return { pairs, leftMap, rightMap };
}
export function comparable(e) {
    const v = clone(e.raw);
    for (const k of ['uid', 'identifier', 'displayIndex']) delete v[k];
    return { ...v, enabled: e.enabled };
}
export function overwriteEntry(source, target, sourceId, targetId, mode = 'content') {
    const a = findEntry(source, sourceId),
        b = findEntry(target, targetId);
    if (!a || !b) throw Error('条目不存在');
    if (b.marker) throw Error('内置占位条目的内容不可覆盖');
    if (mode === 'content') b.raw.content = a.content;
    else if (mode === 'keywords') {
        for (const k of ['key', 'keysecondary', 'selective', 'selectiveLogic'])
            if (k in a.raw) b.raw[k] = clone(a.raw[k]);
    } else {
        const ownId = target.kind === 'preset' ? 'identifier' : 'uid';
        for (const [k, v] of Object.entries(a.raw))
            if (
                ![ownId, 'uid', 'identifier', 'displayIndex'].includes(k) &&
                (mode === 'all' || k !== 'content')
            )
                b.raw[k] = clone(v);
        setEnabled(target, targetId, a.enabled);
        if (source.kind === 'preset' && target.kind === 'preset') {
            const from = specialConfig(source.raw),
                to = specialConfig(target.raw);
            for (const key of ['ToolBindings', 'MessageInjections'])
                if (from[key]?.[sourceId]) {
                    to[key] ||= {};
                    to[key][targetId] = clone(from[key][sourceId]);
                }
            if (Object.keys(to).length) writeSpecialConfig(target.raw, to);
        }
    }
    invalidateEntriesCache(target);
}
export const PRESET_AI_FIELDS = new Set([
    'name',
    'content',
    'role',
    'enabled',
    'injection_position',
    'injection_depth',
    'injection_order',
    'injection_trigger',
    'forbid_overrides',
]);
export const WORLD_AI_FIELDS = new Set([
    'comment',
    'content',
    'key',
    'keysecondary',
    'constant',
    'vectorized',
    'selective',
    'selectiveLogic',
    'order',
    'position',
    'disable',
    'excludeRecursion',
    'preventRecursion',
    'delayUntilRecursion',
    'probability',
    'useProbability',
    'depth',
    'group',
    'groupOverride',
    'groupWeight',
    'scanDepth',
    'caseSensitive',
    'matchWholeWords',
    'useGroupScoring',
    'automationId',
    'role',
    'sticky',
    'cooldown',
    'delay',
    'matchPersonaDescription',
    'matchCharacterDescription',
    'matchCharacterPersonality',
    'matchCharacterDepthPrompt',
    'matchScenario',
    'matchCreatorNotes',
    'ignoreBudget',
    'triggers',
]);
export function validateOperations(d, operations, allowedIds = entries(d).map((e) => e.id)) {
    if (database.isDatabaseKind(d.kind)) return database.validate(d, operations, allowedIds);
    if (!Array.isArray(operations)) throw Error('AI 响应缺少 operations 数组');
    const scope = new Set(allowedIds.map(String)),
        fields = d.kind === 'preset' ? PRESET_AI_FIELDS : WORLD_AI_FIELDS;
    return operations.map((op, i) => {
        if (!op || !['update', 'add', 'delete', 'reorder'].includes(op.type))
            throw Error('第' + (i + 1) + '项操作类型无效');
        const out = clone(op);
        out.id = String(op.id ?? '');
        if (op.type === 'add' && op.beforeId !== undefined && op.beforeId !== null) {
            out.beforeId = String(op.beforeId);
            if (!findEntry(d, out.beforeId)) throw Error('新增条目的插入目标不存在：' + out.beforeId);
        }
        if (['update', 'delete'].includes(op.type)) {
            const e = findEntry(d, out.id);
            if (
                !scope.has(out.id) ||
                !e ||
                e.marker ||
                (op.type === 'delete' && e.raw.system_prompt === true) ||
                e.name.startsWith(META) ||
                e.id === 'SPresetSettings'
            )
                throw Error('AI 操作超出可修改范围：' + out.id);
        }
        if (['update', 'add'].includes(op.type)) {
            const patch = op.fields;
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('fields 必须是对象');
            for (const key of Object.keys(patch)) {
                if (!fields.has(key)) throw Error('AI 不允许修改字段：' + key);
                const value = patch[key],
                    template = makeEntry(d.kind);
                if (key === 'enabled' && typeof value !== 'boolean') throw Error('enabled 必须为布尔值');
                if (
                    key in template &&
                    template[key] !== null &&
                    !(
                        key === 'delayUntilRecursion' &&
                        (typeof value === 'number' || typeof value === 'boolean')
                    ) &&
                    typeof value !== typeof template[key]
                )
                    throw Error('字段类型不正确：' + key);
                if (Array.isArray(template[key]) && !Array.isArray(value))
                    throw Error('字段必须是数组：' + key);
                if (d.kind === 'preset' && key === 'role' && !['system', 'user', 'assistant'].includes(value))
                    throw Error('不支持的消息角色');
            }
        }
        if (op.type === 'reorder') {
            if (!Array.isArray(op.ids) || op.ids.some((id) => !scope.has(String(id))))
                throw Error('重排超出选定条目范围');
            out.ids = op.ids.map(String);
        }
        return out;
    });
}
export function applyOperations(d, operations) {
    if (database.isDatabaseKind(d.kind)) {
        const res = database.apply(d, operations);
        invalidateEntriesCache(d);
        return res;
    }
    for (const op of operations) {
        if (op.type === 'update') {
            const e = findEntry(d, op.id);
            if (!e) throw Error('条目已改变，请重新生成提案');
            const patch = clone(op.fields);
            if ('enabled' in patch && d.kind === 'preset') {
                setEnabled(d, e.id, Boolean(patch.enabled));
                delete patch.enabled;
            }
            Object.assign(e.raw, patch);
            invalidateEntriesCache(d);
        }
        if (op.type === 'delete') removeEntries(d, [op.id]);
        if (op.type === 'add')
            addEntry(
                d,
                { ...makeEntry(d.kind), ...clone(op.fields) },
                op.beforeId || null,
                op.fields?.enabled ?? true,
            );
        if (op.type === 'reorder') {
            const current = entries(d).map((e) => e.id),
                scope = new Set(op.ids),
                sorted = [...op.ids];
            reorder(
                d,
                current.map((id) => (scope.has(id) ? sorted.shift() : id)),
            );
        }
    }
    invalidateEntriesCache(d);
}
export function operationPreview(d, op) {
    const temp = { ...d, raw: clone(d.raw), unitIds: clone(d.unitIds) };
    applyOperations(temp, [op]);
    return {
        before: op.id ? findEntry(d, op.id) : null,
        after: op.id ? findEntry(temp, op.id) : entries(temp).at(-1),
        raw: temp.raw,
    };
}
export function batchPlan(tasks, budget = 6000) {
    const remaining = tasks.map((t) => ({
            ...t,
            id: String(t.id),
            dependsOn: (t.dependsOn || []).map(String),
        })),
        done = new Set(),
        batches = [];
    while (remaining.length) {
        let tokens = 0;
        const batch = [];
        for (const task of remaining)
            if (task.dependsOn.every((id) => done.has(id) || !tasks.some((t) => String(t.id) === id))) {
                const cost = Math.max(
                    128,
                    Number(task.outputTokens) ||
                        { simple: 512, normal: 1024, complex: 2048 }[task.complexity] ||
                        1024,
                );
                if (tokens + cost <= budget || !batch.length) {
                    batch.push(task);
                    tokens += cost;
                }
            }
        if (!batch.length) throw Error('任务存在循环依赖，先调整依赖关系');
        batches.push(batch);
        for (const t of batch) {
            done.add(t.id);
            remaining.splice(
                remaining.findIndex((x) => x.id === t.id),
                1,
            );
        }
    }
    return batches;
}
export function auditWorld(raw) {
    const findings = [],
        list = Object.values(raw.entries || {}).filter((e) => !String(e.comment || '').startsWith(META));
    const uids = new Set();
    for (const e of list) {
        const label = e.comment || String(e.uid);
        if (uids.has(e.uid)) findings.push({ severity: 'error', text: label + '：UID 重复' });
        uids.add(e.uid);
        if (!String(e.content || '').trim())
            findings.push({ severity: 'warning', text: label + '：正文为空' });
        if (!e.constant && !(e.key || []).length && !e.vectorized)
            findings.push({ severity: 'warning', text: label + '：没有触发关键词' });
        if (Number(e.probability) < 0 || Number(e.probability) > 100)
            findings.push({ severity: 'error', text: label + '：概率不在0–100' });
    }
    const tags = [];
    for (const e of [...list]
        .filter((e) => !e.disable)
        .sort((a, b) => (a.position || 0) - (b.position || 0) || (a.order || 100) - (b.order || 100))) {
        for (const line of String(e.content || '').split('\n')) {
            const m = line.trim().match(/^<(\/?)([\w:-]+)(?:\s[^<>]*?)?>$/);
            if (!m) continue;
            if (!m[1]) tags.push({ tag: m[2], entry: e.comment });
            else if (tags.at(-1)?.tag === m[2]) tags.pop();
            else
                findings.push({
                    severity: 'error',
                    text: (e.comment || e.uid) + '：XML 闭合标签不匹配 ' + m[2],
                });
        }
    }
    for (const t of tags) findings.push({ severity: 'error', text: t.entry + '：XML 未闭合 ' + t.tag });
    return findings;
}
export function transformEntries(d, mode, options = {}) {
    if (characters.isCharacterKind(d.kind)) {
        if (mode === 'replace') {
            characters.replaceCharacterText(d, options);
            invalidateEntriesCache(d);
            return;
        }
        throw Error('角色卡仅支持全局查找替换');
    }
    const ids = options.ids?.length ? options.ids : entries(d).map((e) => e.id);
    const list = entries(d).filter((e) => ids.includes(e.id));
    if (mode === 'reorder') {
        list.forEach(
            (e, i) =>
                (e.raw[d.kind === 'worldbook' ? 'order' : 'injection_order'] =
                    Number(options.start ?? 100) + i * Number(options.step ?? 10)),
        );
        invalidateEntriesCache(d);
        return;
    }
    if (mode === 'depth') {
        let order = 0;
        for (const e of list)
            if (d.kind === 'worldbook' && e.raw.position === 4 && e.raw.depth >= 1 && e.raw.depth <= 10) {
                e.raw.depth = 0;
                e.raw.order = order++;
            }
        invalidateEntriesCache(d);
        return;
    }
    for (const e of list) {
        if (e.marker) continue;
        if (mode === 'format') e.raw.content = e.content.replace(/\*\*/g, '').replace(/\*/g, ' ');
        if (mode === 'keywords')
            for (const key of ['key'])
                if (Array.isArray(e.raw[key]))
                    e.raw[key] = [
                        ...new Set(
                            e.raw[key]
                                .flatMap((x) => String(x).split(/[,，]/))
                                .map((x) => x.trim())
                                .filter(Boolean),
                        ),
                    ];
        if (mode === 'cliche') {
            const words = String(options.words || '')
                .split(/[,，\n]/)
                .map((s) => s.trim())
                .filter(Boolean);
            for (const w of words) e.raw.content = String(e.raw.content).split(w).join('');
        }
        if (mode === 'replace') {
            const search = options.extended
                ? String(options.search).replace(/\\n/g, '\n').replace(/\\t/g, '\t')
                : String(options.search || '');
            if (!search) throw Error('查找内容不能为空');
            const pattern = options.regex ? search : search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(pattern, 'g' + (options.caseSensitive ? '' : 'i'));
            const replacement = options.extended
                ? String(options.replace || '')
                      .replace(/\\n/g, '\n')
                      .replace(/\\t/g, '\t')
                : String(options.replace || '');
            const fields = options.inName
                ? [d.kind === 'preset' ? 'name' : 'comment', 'content']
                : ['content'];
            if (options.inKeys && d.kind === 'worldbook') fields.push('key');
            if (options.inSecondary && d.kind === 'worldbook') fields.push('keysecondary');
            for (const k of fields)
                e.raw[k] = Array.isArray(e.raw[k])
                    ? e.raw[k].map((x) => String(x).replace(regex, replacement))
                    : String(e.raw[k] || '').replace(regex, replacement);
        }
    }
    invalidateEntriesCache(d);
}
export function makeToolCode(form) {
    const parameters = { type: 'object', properties: {}, required: [] };
    for (const p of form.parameters || []) {
        parameters.properties[p.name] = { type: p.type || 'string', description: p.description || '' };
        if (p.required) parameters.required.push(p.name);
    }
    return (
        'return { name: ' +
        JSON.stringify(form.name || 'tool') +
        ', displayName: ' +
        JSON.stringify(form.displayName || form.name || 'tool') +
        ', description: ' +
        JSON.stringify(form.description || '') +
        ', parameters: ' +
        JSON.stringify(parameters) +
        ', action: async (args) => {\n' +
        (form.action || 'return JSON.stringify(args);') +
        '\n}, formatMessage: (args) => {\n' +
        (form.formatMessage || 'return JSON.stringify(args);') +
        '\n}, stealth: ' +
        Boolean(form.stealth) +
        ' };'
    );
}
/** 规范化导入文件解析后的原始对象，兼容正文替换裸数组与表格模板套壳并校验文档结构。 */
export function normalizeImportedDocument(kind, parsed, fileName = '') {
    let raw = parsed;
    const baseName = String(fileName || '').replace(/\.(json|ya?ml)$/i, '');
    if (kind === 'contentReplace' && Array.isArray(raw)) {
        if (!raw.length) throw Error('文件为空');
        if (raw[0] && typeof raw[0] === 'object' && typeof raw[0].content === 'string' && !Array.isArray(raw[0].promptGroup)) {
            raw = { name: baseName || '导入正文替换预设', promptGroup: raw };
        } else {
            raw = raw[0];
        }
    } else if (Array.isArray(raw)) {
        if (!raw.length) throw Error('文件为空');
        raw = raw[0];
    }
    if (kind === 'tableTemplate') raw = database.decodeTemplateDocument(raw?.template ?? raw);
    assertDocument(kind, raw);
    const name = String(raw?.name || baseName || '导入文档').trim() || '导入文档';
    return { raw, name };
}
