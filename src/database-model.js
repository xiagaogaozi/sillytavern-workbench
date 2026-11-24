import * as prompt from './prompt-model.js';
export {PROMPT_KINDS,isPromptKind,groupLabel} from './prompt-model.js';
// Native database documents stay native; id-less prompt segment identities live only in drafts.
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const id = () => crypto.randomUUID();
export const DATABASE_KINDS = { plot: '剧情推进', tableTemplate: '表格模板', contentReplace: '正文替换', ...prompt.PROMPT_KINDS };
export const isDatabaseKind = kind => Object.hasOwn(DATABASE_KINDS, kind);
export function empty(kind) {
    if(prompt.isPromptKind(kind)) return prompt.empty(kind);
    if (kind === 'plot')
        return { name: '新剧情预设', plotTasks: [], finalSystemDirective: '' };
    if (kind === 'contentReplace')
        return { name: '新正文替换预设', promptGroup: [] };
    return { mate: { type: 'chatSheets', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: {} } };
}
export function make(kind) {
    if(prompt.isPromptKind(kind)) return prompt.make(kind);
    if (kind === 'plot')
        return { id: id(), name: '新任务', enabled: true, promptGroup: [{ role: 'USER', content: '', deletable: true }], extractTags: '', extractInjectTags: '', finalDirectiveTemplate: '', minLength: 0, maxRetries: 3, mergeStrategy: 'append', stage: 1, order: 0, description: '', triggerWhen: '', agentControl: { enabled: false, selectable: true, defaultSelected: false, allowSequential: true, allowParallel: true, dependsOnTaskIds: [], blocksTaskIds: [] } };
    if (kind === 'contentReplace')
        return { role: 'USER', content: '', deletable: true };
    return { uid: id(), name: '新表', content: [['row_id', '名称']], sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '' }, updateConfig: { uiSentinel: 0, contextDepth: 8, updateFrequency: 1, batchSize: 1, skipFloors: 0 }, exportConfig: { enabled: true, splitByRow: false, entryName: '', entryType: 'constant', keywords: '', preventRecursion: true, injectionTemplate: '', extraIndexEnabled: false, extraIndexEntryName: '', extraIndexColumns: [], extraIndexColumnModes: {}, extraIndexInjectionTemplate: '', entryPlacement: { position: 'before', depth: 0, order: 100 }, extraIndexPlacement: { position: 'before', depth: 0, order: 100 }, fixedEntryPlacement: { position: 'before', depth: 0, order: 100 }, fixedIndexPlacement: { position: 'before', depth: 0, order: 100 } }, orderNo: 0 };
}
function prompts(value) {
    if (!Array.isArray(value))
        throw Error('promptGroup 必须是提示词段数组');
    const slots = new Set();
    for (const p of value) {
        if (!p || typeof p.content !== 'string' || !['SYSTEM', 'USER', 'ASSISTANT'].includes(String(p.role).toUpperCase()))
            throw Error('提示词段需要有效角色与文字正文');
        const slot = p.mainSlot || (p.isMain ? 'A' : p.isMain2 ? 'B' : '');
        if (slot && slots.has(slot))
            throw Error('主提示词槽位重复：' + slot);
        if (slot)
            slots.add(slot);
    }
}
export function assertNative(kind, raw) {
    if(prompt.isPromptKind(kind)) return prompt.assertBundle(kind, raw);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw Error('文档必须为 JSON 对象');
    if (kind === 'plot') {
        if (!Array.isArray(raw.plotTasks))
            throw Error('剧情预设缺少 plotTasks 数组');
        const ids = new Set();
        for (const t of raw.plotTasks) {
            if (!t.id || ids.has(t.id))
                throw Error('剧情任务 ID 缺失或重复');
            ids.add(t.id);
            if (typeof t.name !== 'string')
                throw Error('任务名称必须为文字');
            if (typeof t.enabled !== 'boolean')
                throw Error('任务开关必须为布尔值');
            prompts(t.promptGroup);
        }
    }
    else if (kind === 'contentReplace')
        prompts(raw.promptGroup);
    else {
        if (!raw.mate || typeof raw.mate !== 'object')
            throw Error('表格模板缺少 mate 元信息');
        for (const [key, s] of Object.entries(raw).filter(([key]) => key.startsWith('sheet_'))) {
            if (!s || typeof s.name !== 'string' || !s.sourceData || !Array.isArray(s.content) || !Array.isArray(s.content[0]))
                throw Error('表格结构不完整：' + key);
            if (s.content.some(row => !Array.isArray(row) || row.length !== s.content[0].length))
                throw Error(s.name + '：行宽与列数不一致');
        }
    }
    return raw;
}
export function ensureIds(d) {
    if(prompt.isPromptKind(d?.kind)) return prompt.ensureIds(d); if (d.kind === 'contentReplace') {
    d.unitIds ||= [];
    while (d.unitIds.length < d.raw.promptGroup.length)
        d.unitIds.push(id());
    d.unitIds.length = d.raw.promptGroup.length;
} }
export function units(d) {
    if(prompt.isPromptKind(d?.kind)) return prompt.units(d);
    if (!d)
        return [];
    ensureIds(d);
    const pairs = d.kind === 'plot' ? d.raw.plotTasks.map(t => [t.id, t]) : d.kind === 'contentReplace' ? d.raw.promptGroup.map((p, i) => [d.unitIds[i], p]) : Object.entries(d.raw).filter(([key]) => key.startsWith('sheet_')).sort((a, b) => (a[1].orderNo || 0) - (b[1].orderNo || 0));
    return pairs.map(([key, raw], index) => ({ id: String(key), kind: d.kind, raw, name: d.kind === 'contentReplace' ? `${index + 1} · ${raw.mainSlot || (raw.isMain ? 'A' : raw.isMain2 ? 'B' : raw.role)}` : raw.name, role: raw.role || '', content: d.kind === 'contentReplace' ? raw.content : JSON.stringify(d.kind === 'plot' ? raw.promptGroup : { headers: raw.content[0], rules: raw.sourceData, seeds: raw.seedRows || raw.content.slice(1) }, null, 2), enabled: d.kind === 'plot' ? raw.enabled !== false : d.kind === 'tableTemplate' ? raw.exportConfig?.enabled !== false : true, toggleable: d.kind !== 'contentReplace', nativeProtected: d.kind === 'contentReplace' && (raw.deletable === false || !!raw.mainSlot || raw.isMain || raw.isMain2), marker: false }));
}
export function toggle(d, key, value) {
    if(prompt.isPromptKind(d?.kind)) return prompt.toggle(d,key,value); const e = units(d).find(e => e.id === key); if (!e?.toggleable)
    throw Error('此对象没有原生条目开关'); if (d.kind === 'plot')
    e.raw.enabled = value;
else {
    e.raw.exportConfig ||= {};
    e.raw.exportConfig.enabled = value;
} }
export function insert(d, raw, before) {
    if(prompt.isPromptKind(d?.kind)) return prompt.insert(d,raw,before);
    const item = copy(raw || make(d.kind));
    let key = id();
    const list = units(d), at = list.findIndex(e => e.id === before), index = at < 0 ? list.length : at;
    if (d.kind === 'plot') {
        item.id = key;
        d.raw.plotTasks.splice(index, 0, item);
    }
    else if (d.kind === 'contentReplace') {
        if (item.mainSlot || item.isMain || item.isMain2)
            throw Error('不能复制原生主槽位，请编辑其正文');
        d.raw.promptGroup.splice(index, 0, item);
        d.unitIds.splice(index, 0, key);
    }
    else {
        key = 'sheet_' + key.replaceAll('-', '');
        item.uid = key;
        d.raw[key] = item;
        order(d, [...list.slice(0, index).map(e => e.id), key, ...list.slice(index).map(e => e.id)]);
    }
    return key;
}
export function remove(d, ids) {
    if(prompt.isPromptKind(d?.kind)) return prompt.remove(d,ids); const set = new Set(ids), list = units(d); if (list.some(e => set.has(e.id) && e.nativeProtected))
    throw Error('原生主槽位不能删除'); if (d.kind === 'plot')
    d.raw.plotTasks = d.raw.plotTasks.filter(t => !set.has(t.id));
else if (d.kind === 'contentReplace') {
    d.raw.promptGroup = list.filter(e => !set.has(e.id)).map(e => e.raw);
    d.unitIds = list.filter(e => !set.has(e.id)).map(e => e.id);
}
else
    for (const key of set)
        delete d.raw[key]; }
export function order(d, ids) {
    if(prompt.isPromptKind(d?.kind)) return prompt.order(d,ids); const all = units(d); if (new Set(ids).size !== ids.length)
    throw Error('排序包含重复标识'); const arranged = [...ids.map(key => all.find(e => e.id === key)).filter(Boolean), ...all.filter(e => !ids.includes(e.id))]; if (d.kind === 'plot')
    d.raw.plotTasks = arranged.map(e => e.raw);
else if (d.kind === 'contentReplace') {
    d.raw.promptGroup = arranged.map(e => e.raw);
    d.unitIds = arranged.map(e => e.id);
}
else
    arranged.forEach((e, i) => e.raw.orderNo = i); }
export function copyUnits(from, to, ids, before) {
    if(prompt.isPromptKind(from.kind)) return prompt.copyUnits(from,to,ids,before);
    if (from.kind !== to.kind)
        throw Error('数据库文档只能在相同类型间复制');
    const selected = units(from).filter(e => ids.includes(e.id)).map(e => ({ ...e, raw: copy(e.raw) })), mappings = [];
    for (const e of selected) {
        if (e.nativeProtected)
            throw Error('不能复制主槽位');
        const raw = e.raw;
        if (to.kind === 'tableTemplate') {
            const names = new Set(units(to).map(e => e.name));
            let name = raw.name, n = 1;
            while (names.has(name))
                name = raw.name + ' · 副本' + (n++ > 1 ? ' ' + (n - 1) : '');
            raw.name = name;
        }
        mappings.push({ oldId: e.id, newId: insert(to, raw, before) });
    }
    if (to.kind === 'plot') {
        const map = new Map(mappings.map(m => [m.oldId, m.newId]));
        for (const m of mappings) {
            const task = units(to).find(e => e.id === m.newId).raw;
            for (const field of ['dependsOnTaskIds', 'blocksTaskIds'])
                if (Array.isArray(task.agentControl?.[field]))
                    task.agentControl[field] = task.agentControl[field].map(key => map.get(key) || key);
        }
    }
    return mappings;
}
export function audit(d) {
    const problems = [];
    if (d.kind === 'plot') {
        const ids = new Set(d.raw.plotTasks.map(t => t.id));
        for (const task of d.raw.plotTasks)
            for (const key of ['dependsOnTaskIds', 'blocksTaskIds'])
                for (const ref of task.agentControl?.[key] || [])
                    if (!ids.has(ref))
                        problems.push(`${task.name}：${key} 引用了缺失任务 ${ref}`);
    }
    if (d.kind === 'tableTemplate') {
        const seen = new Set();
        for (const e of units(d)) {
            if (seen.has(e.name))
                problems.push('表名重复：' + e.name);
            seen.add(e.name);
        }
    }
    return problems;
}
export const AI_FIELDS = { plot: new Set(['name', 'enabled', 'promptGroup', 'extractTags', 'extractInjectTags', 'finalDirectiveTemplate', 'stage', 'order', 'description', 'triggerWhen', 'agentControl']), tableTemplate: new Set(['name', 'content', 'seedRows', 'sourceData', 'updateConfig', 'exportConfig', 'orderNo']), contentReplace: new Set(['role', 'content']) };
for(const kind of Object.keys(prompt.PROMPT_KINDS)) AI_FIELDS[kind]=prompt.AI_FIELDS;
const forbidden = /^(?:__proto__|constructor|prototype|apiKey|api_key|authorization|password|accessToken|secret|apiPreset|code|script)$/i;
export function assertSafePatch(value) { if (!value || typeof value !== 'object')
    return; for (const [k, v] of Object.entries(value)) {
    if (forbidden.test(k))
        throw Error('不允许编辑敏感或执行字段：' + k);
    assertSafePatch(v);
} }
export function mergeFields(base, patch) { assertSafePatch(patch); for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key]))
        mergeFields(base[key], value);
    else
        base[key] = copy(value);
} return base; }
export function validate(d, ops, allowed) {
    if(prompt.isPromptKind(d?.kind)) return prompt.validate(d,ops,allowed);
    if (!Array.isArray(ops))
        throw Error('缺少 operations 数组');
    const scope = new Set(allowed), all = units(d);
    const result = ops.map(op => {
        if (!['update', 'add', 'delete', 'reorder'].includes(op?.type))
            throw Error('不支持的操作');
        const out = copy(op), e = all.find(e => e.id === String(op.id));
        if (['update', 'delete'].includes(op.type) && (!e || !scope.has(e.id) || (op.type === 'delete' && e.nativeProtected)))
            throw Error('操作超出可修改范围或触及主槽位');
        if (['update', 'add'].includes(op.type)) {
            if (!op.fields || typeof op.fields !== 'object' || Array.isArray(op.fields))
                throw Error('fields 必须是对象');
            assertSafePatch(op.fields);
            for (const k of Object.keys(op.fields))
                if (!AI_FIELDS[d.kind].has(k))
                    throw Error('AI 不允许修改字段：' + k);
        }
        if (op.type === 'add' && op.beforeId && !all.some(e => e.id === op.beforeId))
            throw Error('插入落点不存在');
        if (op.type === 'reorder' && (!Array.isArray(op.ids) || new Set(op.ids).size !== op.ids.length || op.ids.some(key => !scope.has(key))))
            throw Error('重排超出选择范围');
        return out;
    });
    const temp = { ...d, raw: copy(d.raw), unitIds: copy(d.unitIds) };
    apply(temp, result);
    assertNative(d.kind, temp.raw);
    return result;
}
export function apply(d, ops) {
    if(prompt.isPromptKind(d?.kind)) return prompt.apply(d,ops); for (const op of ops) {
    if (op.type === 'update') {
        const e = units(d).find(e => e.id === op.id);
        if (!e)
            throw Error('条目已改变，请重新生成');
        if (d.kind === 'plot' && op.fields.promptGroup) protectSlots(e.raw.promptGroup, op.fields.promptGroup);
            mergeFields(e.raw, op.fields);
    }
    else if (op.type === 'add')
        insert(d, { ...make(d.kind), ...copy(op.fields) }, op.beforeId);
    else if (op.type === 'delete')
        remove(d, [op.id]);
    else if (op.type === 'reorder') {
        const queue = [...op.ids], set = new Set(queue);
        order(d, units(d).map(e => set.has(e.id) ? queue.shift() : e.id));
    }
} }

export function protectSlots(before, after) {
    for (let i=0;i<(before||[]).length;i++) {
        const p=before[i], slot=p.mainSlot||(p.isMain?'A':p.isMain2?'B':'');
        if (!slot && p.deletable !== false) continue;
        const q=slot ? after?.find(x=>(x.mainSlot||(x.isMain?'A':x.isMain2?'B':''))===slot) : after?.[i];
        if (!q || ['mainSlot','isMain','isMain2','deletable'].some(key=>p[key]!==q[key])) throw Error('原生保留消息段的槽位和删除约束不能改变');
    }
}

// Compatibility with native defaults/export files serialized once or twice as JSON strings.
export function decodeTemplateDocument(value) {
    let result = value;
    for (let i=0; i<3 && typeof result === 'string'; i++) result = JSON.parse(result);
    return assertNative('tableTemplate', result);
}
