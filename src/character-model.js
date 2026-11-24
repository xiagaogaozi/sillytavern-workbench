// 角色卡（TavernCard V2 / V1 兼容）纯数据模型：字段条目化、备选开场白增删排、排序与安全补丁构造。
const cloneObj = (v) => {
    if (v === undefined || v === null || typeof v !== 'object') return v;
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(v);
        } catch {}
    }
    return JSON.parse(JSON.stringify(v));
};

const makeUid = () =>
    globalThis.crypto?.randomUUID?.() ||
    'ch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

export const CHARACTER_FIXED_FIELDS = [
    { id: 'description', label: '角色描述', group: '核心设定', v1: 'description', v2: 'description' },
    { id: 'first_mes', label: '主开场白', group: '开场白', v1: 'first_mes', v2: 'first_mes' },
    { id: 'personality', label: '性格摘要', group: '核心设定', v1: 'personality', v2: 'personality' },
    { id: 'scenario', label: '场景设定', group: '核心设定', v1: 'scenario', v2: 'scenario' },
    { id: 'mes_example', label: '对话示例', group: '核心设定', v1: 'mes_example', v2: 'mes_example' },
    { id: 'creator_notes', label: '创作者注释', group: '扩展提示', v1: 'creatorcomment', v2: 'creator_notes' },
    { id: 'system_prompt', label: '系统提示词', group: '扩展提示', v1: null, v2: 'system_prompt' },
    { id: 'post_history_instructions', label: '历史后指令', group: '扩展提示', v1: null, v2: 'post_history_instructions' },
    { id: 'depth_prompt', label: '角色深度提示词', group: '扩展提示', v1: null, v2: null, isDepth: true },
];

export const FIXED_FIELD_IDS = new Set(CHARACTER_FIXED_FIELDS.map((f) => f.id));

export function isCharacterKind(kind) {
    return kind === 'character';
}

export function ensureCharacterShape(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('角色卡数据必须是 JSON 对象');
    raw.data ||= {};
    if (typeof raw.name !== 'string' && typeof raw.data.name === 'string') raw.name = raw.data.name;
    if (typeof raw.data.name !== 'string') raw.data.name = String(raw.name || '未命名角色');
    if (typeof raw.name !== 'string' || !raw.name) raw.name = raw.data.name;
    raw.data.extensions ||= {};
    if (!Array.isArray(raw.data.alternate_greetings)) raw.data.alternate_greetings = [];
    if (!Array.isArray(raw.data.tags)) raw.data.tags = Array.isArray(raw.tags) ? [...raw.tags] : [];
    return raw;
}

export function assertCharacter(raw) {
    ensureCharacterShape(raw);
    if (!String(raw.name || raw.data?.name || '').trim()) throw Error('角色卡名称不能为空');
    return raw;
}

export function emptyCharacter(name = '新角色卡') {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creatorcomment: '',
        tags: [],
        talkativeness: '0.5',
        fav: false,
        data: {
            name,
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: [],
            creator: '',
            character_version: '',
            extensions: {
                world: '',
                talkativeness: '0.5',
                fav: false,
                depth_prompt: { prompt: '', depth: 4, role: 'system' },
            },
        },
    };
}

export function ensureAltIds(d) {
    ensureCharacterShape(d.raw);
    const len = d.raw.data.alternate_greetings.length;
    if (!Array.isArray(d.unitIds)) d.unitIds = [];
    while (d.unitIds.length < len) d.unitIds.push('alt:' + makeUid());
    if (d.unitIds.length > len) d.unitIds.length = len;
    return d.unitIds;
}

export function readFieldContent(raw, fieldDef) {
    ensureCharacterShape(raw);
    if (fieldDef.isDepth) return String(raw.data?.extensions?.depth_prompt?.prompt ?? '');
    const v2Val = fieldDef.v2 ? raw.data?.[fieldDef.v2] : undefined;
    const v1Val = fieldDef.v1 ? raw[fieldDef.v1] : undefined;
    return String(v2Val ?? v1Val ?? '');
}

export function writeFieldContent(raw, fieldDef, text) {
    ensureCharacterShape(raw);
    const val = String(text ?? '');
    if (fieldDef.isDepth) {
        raw.data.extensions ||= {};
        raw.data.extensions.depth_prompt = {
            depth: 4,
            role: 'system',
            ...(raw.data.extensions.depth_prompt || {}),
            prompt: val,
        };
        return;
    }
    if (fieldDef.v2) raw.data[fieldDef.v2] = val;
    if (fieldDef.v1) raw[fieldDef.v1] = val;
}

export function characterUnits(d) {
    if (!d?.raw) return [];
    ensureCharacterShape(d.raw);
    const altIds = ensureAltIds(d);
    const result = [];

    const pushFixed = (def) => {
        const content = readFieldContent(d.raw, def);
        result.push({
            id: def.id,
            name: def.label,
            content,
            enabled: true,
            toggleable: false,
            marker: false,
            nativeProtected: true,
            group: def.group,
            groupLabel: def.group,
            role: def.id === 'first_mes' ? 'assistant' : 'system',
            fieldDef: def,
            raw: { field: def.id, content },
        });
    };

    // 按阅读与编辑顺排列：角色描述 → 主开场白 → 全部备选开场白 → 其余设定与提示词
    pushFixed(CHARACTER_FIXED_FIELDS[0]); // description
    pushFixed(CHARACTER_FIXED_FIELDS[1]); // first_mes

    const alts = d.raw.data.alternate_greetings || [];
    alts.forEach((text, i) => {
        const id = altIds[i];
        result.push({
            id,
            name: `备选开场白 #${i + 1}`,
            content: String(text ?? ''),
            enabled: true,
            toggleable: false,
            marker: false,
            nativeProtected: false,
            isAltGreeting: true,
            altIndex: i,
            group: '开场白',
            groupLabel: '备选开场白',
            role: 'assistant',
            raw: { field: 'alternate_greetings', index: i, content: String(text ?? '') },
        });
    });

    for (let i = 2; i < CHARACTER_FIXED_FIELDS.length; i++) {
        pushFixed(CHARACTER_FIXED_FIELDS[i]);
    }
    return result;
}

export function updateCharacterUnit(d, unitId, content) {
    ensureCharacterShape(d.raw);
    const fixed = CHARACTER_FIXED_FIELDS.find((f) => f.id === unitId);
    if (fixed) {
        writeFieldContent(d.raw, fixed, content);
        return;
    }
    const altIds = ensureAltIds(d);
    const idx = altIds.indexOf(String(unitId));
    if (idx < 0) throw Error('找不到对应的角色卡字段或备选开场白：' + unitId);
    d.raw.data.alternate_greetings[idx] = String(content ?? '');
}

export function insertAltGreeting(d, text = '', beforeId = null) {
    ensureCharacterShape(d.raw);
    const altIds = ensureAltIds(d);
    const content = typeof text === 'string' ? text : String(text?.content ?? '');
    const id = 'alt:' + makeUid();
    const at = beforeId ? altIds.indexOf(String(beforeId)) : -1;
    if (at >= 0) {
        d.raw.data.alternate_greetings.splice(at, 0, content);
        altIds.splice(at, 0, id);
    } else {
        d.raw.data.alternate_greetings.push(content);
        altIds.push(id);
    }
    return id;
}

export function removeAltGreetings(d, ids) {
    ensureCharacterShape(d.raw);
    const chosen = new Set(ids.map(String));
    for (const id of chosen) {
        if (FIXED_FIELD_IDS.has(id)) throw Error('固定角色卡字段不可删除，只能清空正文或删除备选开场白');
    }
    const altIds = ensureAltIds(d);
    const nextTexts = [];
    const nextIds = [];
    for (let i = 0; i < altIds.length; i++) {
        if (!chosen.has(altIds[i])) {
            nextTexts.push(d.raw.data.alternate_greetings[i]);
            nextIds.push(altIds[i]);
        }
    }
    d.raw.data.alternate_greetings = nextTexts;
    d.unitIds = nextIds;
}

export function reorderAltGreetings(d, ids) {
    ensureCharacterShape(d.raw);
    const altIds = ensureAltIds(d);
    const pairMap = new Map(altIds.map((id, i) => [id, d.raw.data.alternate_greetings[i]]));
    const orderedIds = [];
    for (const id of ids.map(String)) {
        if (pairMap.has(id) && !orderedIds.includes(id)) orderedIds.push(id);
    }
    for (const id of altIds) {
        if (!orderedIds.includes(id)) orderedIds.push(id);
    }
    d.unitIds = orderedIds;
    d.raw.data.alternate_greetings = orderedIds.map((id) => pairMap.get(id));
}

export function copyCharacterUnits(source, target, ids, beforeId = null) {
    if (target.kind !== 'character') throw Error('只能复制到角色卡的备选开场白中');
    const selected = characterUnits(source).filter((e) => ids.includes(e.id));
    const mappings = [];
    for (const item of selected) {
        const newId = insertAltGreeting(target, item.content, beforeId);
        mappings.push({ oldId: item.id, newId });
    }
    return mappings;
}

export function replaceCharacterText(d, options = {}) {
    const search = options.extended
        ? String(options.search || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        : String(options.search || '');
    if (!search) throw Error('查找内容不能为空');
    const pattern = options.regex ? search : search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(pattern, 'g' + (options.caseSensitive ? '' : 'i'));
    const replacement = options.extended
        ? String(options.replace || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        : String(options.replace || '');

    const units = characterUnits(d);
    const scopeSet = options.ids?.length ? new Set(options.ids.map(String)) : null;
    for (const u of units) {
        if (scopeSet && !scopeSet.has(u.id)) continue;
        const next = String(u.content || '').replace(regex, replacement);
        if (next !== u.content) updateCharacterUnit(d, u.id, next);
    }
}

export function parseDateScore(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value) return 0;
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
    // 兼容酒馆 create_date 格式如 "2024-5-1 @12h 30m 15s 000ms"
    const s = String(value).trim();
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s*@(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s)?/);
    if (m) {
        return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    }
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function sortCharacters(items, mode = 'name', dir = 'asc') {
    const mult = dir === 'desc' ? -1 : 1;
    return [...(items || [])].sort((a, b) => {
        if (mode === 'date_added') {
            const ta = parseDateScore(a.date_added || a.create_date);
            const tb = parseDateScore(b.date_added || b.create_date);
            if (ta !== tb) return (ta - tb) * mult;
        } else if (mode === 'date_last_chat') {
            const ta = parseDateScore(a.date_last_chat);
            const tb = parseDateScore(b.date_last_chat);
            if (ta !== tb) return (ta - tb) * mult;
        }
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN', { numeric: true }) * mult;
    });
}

export function buildCharacterMergePatch(raw) {
    ensureCharacterShape(raw);
    const clean = cloneObj(raw);
    delete clean.json_data;
    delete clean.avatar;
    delete clean.chat;
    delete clean.date_added;
    delete clean.date_last_chat;
    delete clean.chat_size;
    // 同步核心 V1/V2 镜像字段，避免酒馆界面出现 V1/V2 不一致
    clean.name = String(clean.data.name || clean.name || '');
    clean.description = String(clean.data.description ?? clean.description ?? '');
    clean.personality = String(clean.data.personality ?? clean.personality ?? '');
    clean.scenario = String(clean.data.scenario ?? clean.scenario ?? '');
    clean.first_mes = String(clean.data.first_mes ?? clean.first_mes ?? '');
    clean.mes_example = String(clean.data.mes_example ?? clean.mes_example ?? '');
    clean.creatorcomment = String(clean.data.creator_notes ?? clean.creatorcomment ?? '');
    if (Array.isArray(clean.data.tags)) clean.tags = [...clean.data.tags];
    if (clean.data.extensions?.fav !== undefined) clean.fav = Boolean(clean.data.extensions.fav);
    if (clean.data.extensions?.talkativeness !== undefined)
        clean.talkativeness = String(clean.data.extensions.talkativeness);
    return clean;
}
