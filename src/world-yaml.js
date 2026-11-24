// 世界书 YAML 导入/导出结构转换（仅保留原生往返所需的轻量转换逻辑）
import { clone, makeEntry } from './core.js';

const NATIVE_POSITIONS = [
    'before_character_definition',
    'after_character_definition',
    'before_author_note',
    'after_author_note',
    'at_depth',
    'before_example_messages',
    'after_example_messages',
    'outlet',
];

const YAML_POSITIONS = [
    'Before Character Definition',
    'After Character Definition',
    'Before Author Note',
    'After Author Note',
    null,
    'Before Example Messages',
    'After Example Messages',
];

export function yamlEntry(e) {
    return {
        trigger: {
            Title: e.comment || '未命名条目',
            type: e.constant ? 'Constant' : 'Normal',
            Comma_separated_list: (e.key || []).join(','),
            position:
                e.position === 4
                    ? 'At Depth as ' + ['System', 'User', 'Assistant'][e.role || 0]
                    : YAML_POSITIONS[e.position] || 'Before Character Definition',
            depth: e.depth ?? 0,
            order: e.order ?? 100,
        },
        content: e.content || '',
        enabled: !e.disable,
        probability: e.probability ?? 100,
        extensions: { pwwNative: clone(e) },
    };
}

export function fromYamlEntry(v) {
    if (v.extensions?.pwwNative) return clone(v.extensions.pwwNative);
    const e = { ...makeEntry('worldbook') };
    for (const k of Object.keys(e)) if (k in v) e[k] = clone(v[k]);
    if (v.trigger && typeof v.trigger === 'object') {
        const t = v.trigger;
        e.comment = t.Title || '导入条目';
        e.constant = t.type === 'Constant';
        e.key = String(t.Comma_separated_list || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        e.content = String(v.content || '');
        if (!e.content.trim()) throw Error('YAML条目正文不能为空：' + e.comment);
        if (!e.constant && !e.key.length) throw Error('Normal类型YAML条目必须有关键词：' + e.comment);
        e.disable = v.enabled === false;
        e.probability = v.probability ?? 100;
        e.depth = t.depth ?? 0;
        e.order = t.order ?? 100;
        if (/^At Depth as /.test(t.position || '')) {
            e.position = 4;
            e.role = ['System', 'User', 'Assistant'].indexOf(t.position.replace('At Depth as ', ''));
        } else {
            e.position = YAML_POSITIONS.indexOf(t.position);
            if (e.position < 0) e.position = 0;
        }
        return e;
    }
    e.comment = v.name || v.comment || v.title || '导入条目';
    e.disable = v.enabled === false || v.disable === true;
    e.key = v.strategy?.keys || v.key || v.keywords || [];
    e.keysecondary = v.strategy?.keys_secondary?.keys || v.keysecondary || [];
    const logic = v.strategy?.keys_secondary?.logic ?? v.selectiveLogic ?? 0;
    e.selectiveLogic =
        typeof logic === 'string' ? ['and_any', 'not_all', 'not_any', 'and_all'].indexOf(logic) : logic;
    e.constant = v.strategy?.type === 'constant' || v.trigger === 'Constant' || v.constant === true;
    e.vectorized = v.strategy?.type === 'vectorized' || v.vectorized === true;
    if (v.position && typeof v.position === 'object') {
        e.position = NATIVE_POSITIONS.indexOf(v.position.type);
        if (e.position < 0) e.position = 0;
        e.depth = v.position.depth ?? 4;
        e.order = v.position.order ?? 100;
        e.role = ['system', 'user', 'assistant'].indexOf(v.position.role || 'system');
    }
    if (v.recursion) {
        e.excludeRecursion = !!v.recursion.prevent_incoming;
        e.preventRecursion = !!v.recursion.prevent_outgoing;
        e.delayUntilRecursion = v.recursion.delay_until || false;
    }
    if (v.effect) for (const k of ['sticky', 'cooldown', 'delay']) e[k] = v.effect[k] || 0;
    return e;
}
