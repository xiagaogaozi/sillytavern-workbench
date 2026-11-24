// 单文件原型检查：纯数据路径，不读取用户数据、不请求模型、不写酒馆。
import assert from 'node:assert/strict';
import * as c from '../src/core.js';
import * as p from '../src/world-yaml.js';
const raw = {
    temperature: 0.7,
    prompts: [
        { identifier: 'a', name: '港口', role: 'system', content: '船只先登记。', custom: { keep: 1 } },
    ],
    prompt_order: [
        { character_id: 100001, order: [{ identifier: 'a', enabled: true, unknown: 7 }] },
        { character_id: 123, order: [{ identifier: 'a', enabled: false }] },
    ],
    extensions: {
        vendor: { keep: true },
        SPreset: {
            MacroNest: true,
            ToolBindings: { a: { enabled: false, code: 'return {};', valid: false, uuid: 'old', extra: 3 } },
            MessageInjections: { a: { enabled: true, reasoning: '说明', toolCalls: [], toolResults: [] } },
        },
    },
};
const d = c.createDraft('preset', raw, 'sample', true),
    t = c.createDraft('preset', raw, 'target', true);
const original = c.clone(raw);
let copied;
c.commit(t, 'copy', () => {
    copied = c.transfer(d, t, ['a'])[0].newId;
});
assert.notEqual(copied, 'a');
assert.equal(c.entries(t).length, 2);
assert.deepEqual(d.raw, original);
assert.equal(c.specialConfig(t.raw).ToolBindings[copied].extra, 3);
assert.equal(c.specialConfig(t.raw).MacroNest, true);
assert.notEqual(c.specialConfig(t.raw).ToolBindings[copied].uuid, 'old');
assert.equal(c.specialConfig(t.raw).MessageInjections[copied].reasoning, '说明');
c.undo(t);
assert.deepEqual(t.raw, original);
c.undo(t, 1);
assert.equal(c.entries(t).length, 2);
const ops = c.validateOperations(
    d,
    [{ type: 'update', id: 'a', fields: { content: '船只上午登记。' } }],
    ['a'],
);
c.commit(d, 'ai', () => c.applyOperations(d, ops));
assert.equal(d.raw.prompts[0].content, '船只上午登记。');
assert.deepEqual(d.raw.extensions, original.extensions);
assert.deepEqual(d.raw.prompt_order, original.prompt_order);
assert.throws(() =>
    c.validateOperations(
        d,
        [{ type: 'update', id: 'a', fields: { spreset_condition_script: 'bad' } }],
        ['a'],
    ),
);
assert.throws(() =>
    c.validateOperations(d, [{ type: 'update', id: 'a', fields: { content: { bad: true } } }], ['a']),
);
assert.throws(() => c.validateOperations(d, [{ type: 'delete', id: 'outside' }], ['a']));
const w = c.createDraft('worldbook', { entries: {} }, 'world');
const id = c.addEntry(w, {
    ...c.makeEntry('worldbook'),
    comment: '港口',
    content: '**港口** *规则*',
    position: 4,
    depth: 8,
    key: ['港口，船只', '船只'],
});
c.transformEntries(w, 'format');
assert.equal(c.findEntry(w, id).content, '港口  规则 ');
c.transformEntries(w, 'depth');
assert.equal(c.findEntry(w, id).raw.depth, 0);
assert.equal(c.entries(w).length, 1);
c.transformEntries(w, 'keywords');
assert.deepEqual(c.findEntry(w, id).raw.key, ['港口', '船只']);
c.writeFolderMeta(w.raw, {
    version: 1,
    folders: [{ id: 'group', name: '港区' }],
    entryFolderMap: { [id]: 'group' },
});
assert.equal(c.entries(w).length, 1);
assert.equal(c.entries(w)[0].group, 'group');
assert.equal(c.entries(w, true).length, 2);
assert.deepEqual(p.fromYamlEntry(p.yamlEntry(c.findEntry(w, id).raw)), c.findEntry(w, id).raw);
for (const [position, native, role] of [
    ['Before Author Note', 2, 0],
    ['Before Example Messages', 5, 0],
    ['At Depth as Assistant', 4, 2],
]) {
    const e = p.fromYamlEntry({
        trigger: {
            Title: '条目',
            type: 'Normal',
            Comma_separated_list: '港口,船只',
            position,
            depth: 3,
            order: 20,
        },
        content: '正文',
    });
    assert.equal(e.position, native);
    assert.equal(e.role, role);
}
assert.equal(
    c.batchPlan([
        { id: 'a', dependsOn: [] },
        { id: 'b', dependsOn: ['a'] },
    ]).length,
    2,
);
assert.throws(() =>
    c.batchPlan([
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
    ]),
);
globalThis.location = { origin: 'http://test.invalid', hash: '#check' };
globalThis.window = { addEventListener() {} };
const ai = await import('../src/ai.js');
assert.deepEqual(ai.parseAIJson('```json\n{"operations":[]}\n```'), { operations: [] });
const context = ai.editingContext(d, { selected: ['a'] });
assert.equal(context.allowedIds[0], 'a');
assert(!('custom' in context.selection[0].fields));
assert(!context.references.extra);
assert.equal(context.selection[0].content, '船只上午登记。');
const messages = ai.messagesFor({}, 'preset', {
    ...context,
    task: '修改正文',
    output_schema: ai.PROPOSAL_CONTRACT,
});
assert.equal(messages[0].role, 'system');
assert.equal(messages.at(-1).role, 'user');
assert(messages.every((m) => !m.content.includes('return {};')));

const { readFile } = await import('node:fs/promises');
const css = await readFile(new URL('../ui.css', import.meta.url), 'utf8'),
    docs = await readFile(new URL('../docs/UI_VARIABLES.md', import.meta.url), 'utf8');
const variables = [...new Set([...css.matchAll(/(--pww-[\w-]+)\s*:/g)].map((m) => m[1]))];
for (const name of variables) assert(docs.includes(name), 'Undocumented UI variable: ' + name);
assert(!/(--pww-[\w-]+)\s*:\s*var\(\1\)/.test(css), 'Self-referencing variable');

const systemDraft = c.createDraft('preset', {
    prompts: [
        {
            identifier: 'main',
            name: 'Main',
            content: '规则',
            role: 'system',
            system_prompt: true,
            marker: false,
        },
        {
            identifier: 'chatHistory',
            name: 'History',
            content: '',
            role: 'system',
            system_prompt: true,
            marker: true,
        },
    ],
    prompt_order: [
        {
            character_id: 100001,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'chatHistory', enabled: true },
            ],
        },
    ],
    extensions: {},
});
assert.throws(() => c.removeEntries(systemDraft, ['main']));
assert.throws(() => c.removeEntries(systemDraft, ['chatHistory']));
assert(c.canToggleEntry(c.findEntry(systemDraft, 'chatHistory')));
assert(!c.canToggleEntry({ id: 'unknown-marker', marker: true }));
const duplicate = c.transfer(systemDraft, systemDraft, ['main'])[0].newId;
assert.equal(c.findEntry(systemDraft, duplicate).raw.system_prompt, false);
assert.throws(() => c.transfer(systemDraft, systemDraft, ['chatHistory']));
const targetPreset = c.createDraft('preset', c.emptyDocument('preset'));
c.transfer(systemDraft, targetPreset, ['chatHistory']);
assert.equal(c.findEntry(targetPreset, 'chatHistory').marker, true);
const beforeZero = c.validateOperations(
    w,
    [{ type: 'add', beforeId: 0, fields: { comment: '前置', content: '内容' } }],
    [id],
);
assert.equal(beforeZero[0].beforeId, '0');
console.log(
    'PASS: full-object roundtrip, copy/remap, undo/redo, AI scope/type guards, folder metadata, YAML positions, optimizer semantics, dependency batches, generation/audit and least-context templates.',
);
