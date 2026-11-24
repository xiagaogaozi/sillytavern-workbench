// 业务操作集中层：文档读写/另存、数据库直连应用与未启用功能开关、整理工具、查找替换与全本比对。
import {
    clone,
    commit,
    createDraft,
    dirty,
    emptyDocument,
    entries,
    findEntry,
    folderMeta,
    writeFolderMeta,
    markSaved,
    overwriteEntry,
    pairEntries,
    removeEntries,
    transfer,
    transformEntries,
    auditWorld,
    fingerprint,
    uuid,
} from './core.js';
import {
    DATABASE_KINDS,
    PROMPT_KINDS,
    isDatabaseKind,
    isPromptKind,
    audit as auditDb,
    decodeTemplateDocument,
    assertSafePatch,
} from './database-model.js';
import * as prompts from './prompt-model.js';
import { planDatabaseReplacement, applyDatabaseReplacement } from './database-replace.js';
import { $, $$, esc, field, modal, notify, download, pickFile, parseDocumentText, yamlString, values, run } from './ui.js';
import { renderInlineDiffHtml } from './diff-search.js';
import { rpc } from './bridge.js';
import { yamlEntry } from './world-yaml.js';

export const KIND_LABEL = {
    preset: '预设',
    worldbook: '世界书',
    character: '角色卡',
    ...DATABASE_KINDS,
};

async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    }
    return btoa(binary);
}

function downloadBase64(fileName, base64, mimeType = 'image/png') {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const FEATURE_LABELS = [
    ['autoUpdateEnabled', '表格自动更新 (填表)'],
    ['plotEnabled', '剧情推进总开关'],
    ['contentReplaceEnabled', '正文替换总开关'],
    ['vectorMemoryEnabled', '向量记忆与总结'],
    ['continuationPageEnabled', '智能续写功能页'],
    ['worldSimulationPageEnabled', '格林推演功能页'],
    ['externalImportPageEnabled', '外部导入功能页'],
    ['desktopPetEnabled', '数据库桌宠'],
    ['silentModeEnabled', '静默模式'],
];

export const dbCall = (method, args = {}) => rpc('database.call', { method, args });
export const charCall = (method, args = {}) => rpc('character.call', { method, args });

export function createActions(ctxApi) {
    async function openNewTabDialog(defaultKind = 'preset') {
        const lists = ctxApi.runtime().lists || { presets: [], worldbooks: [] };
        let caps = ctxApi.dbCaps();
        if (!caps) {
            try {
                caps = await dbCall('capabilities');
                ctxApi.setDbCaps(caps);
            } catch {}
        }
        const kindChoices = [
            ['preset', '预设'],
            ['worldbook', '世界书'],
            ['character', '角色卡'],
            {
                group: '数据库',
                items: [
                    ['plot', '剧情推进'],
                    ['tableTemplate', '表格模板'],
                    ['contentReplace', '正文替换'],
                    ...Object.entries(PROMPT_KINDS).map(([k, l]) => [k, l]),
                ],
            },
        ];

        const chosen = await modal(
            '打开或新建标签页',
            field('kind', '文档类型', defaultKind || 'preset', 'select', { choices: kindChoices }) +
                '<div data-open-dynamic><p class="muted">正在读取列表…</p></div>',
            {
                wide: false,
                hideCancel: true,
                submit: '打开',
                footer: '<button type="button" data-open-new>新建空白/默认</button>',
                onMount(dialog, close) {
                    const kindSel = $('[name="kind"]', dialog);
                    const box = $('[data-open-dynamic]', dialog);

                    const renderGroupedPicker = (groups, defaultVal) => {
                        const flat = groups.flatMap((g) => g.items);
                        if (!flat.length) {
                            box.innerHTML = '<p class="muted">该分类暂无已保存项目，可点击下方「新建空白/默认」。</p>';
                            return;
                        }
                        let selectedVal =
                            defaultVal && flat.some((x) => x.value === defaultVal) ? defaultVal : flat[0].value;
                        box.innerHTML =
                            '<div class="open-picker">' +
                            '<input type="search" data-open-filter placeholder="搜索名称…" style="width:100%">' +
                            `<input type="hidden" name="name" value="${esc(selectedVal)}">` +
                            '<div class="open-picker-list" data-picker-list></div>' +
                            '</div>';
                        const filter = $('[data-open-filter]', box);
                        const hidden = $('[name="name"]', box);
                        const listEl = $('[data-picker-list]', box);

                        const draw = () => {
                            const q = filter.value.trim().toLowerCase();
                            const html = groups
                                .map((g) => {
                                    const items = g.items.filter(
                                        (it) => !q || it.label.toLowerCase().includes(q) || (it.tag || '').toLowerCase().includes(q),
                                    );
                                    if (!items.length) return '';
                                    return (
                                        (g.title ? `<div class="picker-group-title"><span>${esc(g.title)}</span></div>` : '') +
                                        items
                                            .map(
                                                (it) =>
                                                    `<button type="button" class="picker-item ${it.value === selectedVal ? 'active' : ''}" data-pick-val="${esc(it.value)}" title="${esc(it.label)}">` +
                                                    (it.isLive ? '<span class="lamp-dot is-live" title="当前生效"></span>' : '') +
                                                    `<span class="picker-item-label">${esc(it.label)}</span>` +
                                                    (it.tag ? `<span class="badge">${esc(it.tag)}</span>` : '') +
                                                    '</button>',
                                            )
                                            .join('')
                                    );
                                })
                                .filter(Boolean)
                                .join('');
                            listEl.innerHTML = html || '<p class="muted" style="padding:10px;text-align:center">无匹配项</p>';
                            for (const btn of $$('[data-pick-val]', listEl)) {
                                btn.onclick = () => {
                                    selectedVal = btn.dataset.pickVal;
                                    hidden.value = selectedVal;
                                    for (const b of $$('[data-pick-val]', listEl))
                                        b.classList.toggle('active', b === btn);
                                };
                                btn.ondblclick = () => {
                                    selectedVal = btn.dataset.pickVal;
                                    hidden.value = selectedVal;
                                    close({ kind: kindSel.value, name: selectedVal });
                                };
                            }
                        };
                        filter.oninput = draw;
                        draw();
                    };

                    const loadKind = async () => {
                        const k = kindSel.value;
                        box.innerHTML = '<p class="muted">正在读取列表…</p>';
                        try {
                            if (k === 'preset') {
                                const names = lists.presets || [];
                                const cur = lists.currentPreset || '';
                                const items = names.map((n) => ({
                                    value: n,
                                    label: n,
                                    isLive: Boolean(cur && n === cur),
                                    tag: cur && n === cur ? '当前' : '',
                                }));
                                items.sort((a, b) => Number(b.isLive) - Number(a.isLive));
                                renderGroupedPicker([{ title: '酒馆预设', items }], cur || names[0] || '');
                            } else if (k === 'worldbook') {
                                const all = lists.worldbooks || [];
                                const globalSet = new Set((lists.global || []).filter((n) => all.includes(n)));
                                const localList = [];
                                const localSeen = new Set();
                                const addLocal = (name, tag) => {
                                    if (!name || !all.includes(name)) return;
                                    if (localSeen.has(name)) {
                                        const hit = localList.find((x) => x.value === name);
                                        if (hit && !hit.tag.includes(tag)) hit.tag += '/' + tag;
                                        return;
                                    }
                                    localSeen.add(name);
                                    localList.push({ value: name, label: name, isLive: true, tag });
                                };
                                addLocal(lists.mainWorld, '角色主书');
                                for (const a of lists.auxiliary || []) addLocal(a, '角色附加');
                                addLocal(lists.chatWorld, '当前聊天');

                                const globalItems = [...globalSet].map((n) => ({
                                    value: n,
                                    label: n,
                                    isLive: true,
                                    tag: '全局',
                                }));
                                const otherItems = all
                                    .filter((n) => !globalSet.has(n) && !localSeen.has(n))
                                    .map((n) => ({ value: n, label: n }));
                                const groups = [];
                                if (globalItems.length) groups.push({ title: '全局世界书', items: globalItems });
                                if (localList.length) groups.push({ title: '局部世界书（角色 / 聊天）', items: localList });
                                if (otherItems.length) groups.push({ title: '其他世界书', items: otherItems });
                                const firstDefault = globalItems[0]?.value || localList[0]?.value || otherItems[0]?.value || '';
                                renderGroupedPicker(groups, firstDefault);
                            } else if (k === 'character') {
                                const res = await charCall('list', { refresh: false });
                                ctxApi.setCharacterCatalog?.(res);
                                const items = (res?.items || []).map((c) => ({
                                    value: c.avatar,
                                    label: c.name,
                                    isLive: Boolean(c.isCurrent),
                                    tag: c.isCurrent ? '当前对话' : c.world ? '已绑世界书' : '',
                                }));
                                items.sort((a, b) => Number(b.isLive) - Number(a.isLive));
                                renderGroupedPicker([{ title: '酒馆角色卡', items }], res?.currentAvatar || items[0]?.value || '');
                            } else {
                                const res = await dbCall('list', { kind: k });
                                const items = (res?.items || []).map((i) => ({
                                    value: i.name,
                                    label: i.name,
                                    isLive: Boolean(i.isActive),
                                    tag: i.isActive ? '当前' : '',
                                }));
                                if (!res?.matchedActive) {
                                    items.unshift({
                                        value: '__LIVE__',
                                        label: '当前实际生效',
                                        isLive: true,
                                        tag: '未存库',
                                    });
                                }
                                const defaultVal = res?.matchedActive && res.activeName ? res.activeName : items[0]?.value || '';
                                renderGroupedPicker([{ title: KIND_LABEL[k], items }], defaultVal);
                            }
                        } catch (err) {
                            box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
                        }
                    };
                    kindSel.onchange = loadKind;
                    $('[data-open-new]', dialog).onclick = () => close({ action: 'new', kind: kindSel.value });
                    void loadKind();
                },
            },
        );
        if (!chosen) return;
        const kind = chosen.kind;
        if (chosen.action === 'new') return createNewDocumentTab(kind);
        if (chosen.name === '__LIVE__') return loadCurrentPromptTab(kind);
        if (!chosen.name) throw Error('请先选择一个文档，或点击「新建空白/默认」');
        return openExistingTab(kind, chosen.name);
    }

    async function openExistingTab(kind, name) {
        // 如果已打开同一文档，直接激活该标签页
        const existing = ctxApi.findTab(kind, name);
        if (existing) {
            await ctxApi.activateTab(existing.id);
            notify('已切换到已打开标签：「' + name + '」');
            return;
        }
        if (kind === 'preset' || kind === 'worldbook') {
            const raw = await rpc('documents.read', { kind, name });
            const d = createDraft(kind, raw, name, true, { takeOwnership: true });
            await ctxApi.addTab(d);
            notify('已打开「' + name + '」');
            return;
        }
        if (kind === 'character') {
            const res = await charCall('read', { avatar: name });
            const d = createDraft('character', res.raw, res.name, true, { takeOwnership: true });
            d.avatar = res.avatar;
            d.sourceName = res.avatar;
            d.charTags = res.tags || [];
            d.charAuxWorlds = res.auxiliary || [];
            d.avatarVersion = Date.now();
            await ctxApi.addTab(d);
            notify('已打开角色卡「' + res.name + '」');
            return;
        }
        const res = await dbCall('read', { kind, name });
        const d = createDraft(kind, res.raw, res.name, true, { takeOwnership: true });
        d.nativeRevision = res.revision;
        d.nativeScope = res.scope;
        await ctxApi.addTab(d);
        notify('已打开数据库文档「' + res.name + '」');
    }

    async function createNewDocumentTab(kind) {
        if (kind === 'preset') {
            const raw = await rpc('documents.currentPreset');
            const d = createDraft('preset', raw, '新预设草稿', false);
            await ctxApi.addTab(d);
            notify('已按当前酒馆设置创建预设草稿');
            return;
        }
        if (kind === 'worldbook') {
            const d = createDraft('worldbook', emptyDocument('worldbook'), '新世界书草稿', false);
            await ctxApi.addTab(d);
            return;
        }
        if (kind === 'character') {
            const d = createDraft('character', emptyDocument('character'), '新角色卡草稿', false);
            d.avatar = '';
            d.charTags = [];
            d.charAuxWorlds = [];
            await ctxApi.addTab(d);
            notify('已创建空白角色卡草稿');
            return;
        }
        const def = await dbCall('defaults', { kind });
        const d = createDraft(kind, def, '新建 · ' + KIND_LABEL[kind], false);
        await ctxApi.addTab(d);
        notify('已创建默认草稿：「' + KIND_LABEL[kind] + '」');
    }

    async function loadCurrentPromptTab(kind) {
        const res = await dbCall('current', { kind });
        const matched = res.matchedActive && res.activeName ? res.activeName : null;
        const label = matched || KIND_LABEL[kind];
        const d = createDraft(kind, res.raw, label, Boolean(matched), { fromLive: true });
        d.nativeScope = res.scope;
        await ctxApi.addTab(d, { liveKey: 'live:' + kind });
        notify('已读取：' + (matched || res.scopeLabel || KIND_LABEL[kind]));
    }

    async function parseImportedFile(kind, file) {
        const text = await file.text();
        let raw = await parseDocumentText(text);
        if (isPromptKind(kind)) raw = await dbCall('importPrompt', { kind, raw });
        if (Array.isArray(raw)) {
            if (!raw.length) throw Error('文件为空');
            raw = raw[0];
        }
        if (kind === 'tableTemplate') raw = decodeTemplateDocument(raw.template ?? raw);
        const name = raw.name || file.name.replace(/\.(json|ya?ml)$/i, '');
        return { raw, name };
    }

    async function uniqueImportName(kind, baseName) {
        const clean = String(baseName || '导入文档').trim() || '导入文档';
        const used = new Set((ctxApi.listTabNames ? ctxApi.listTabNames(kind) : []) || []);
        const lists = ctxApi.runtime().lists || {};
        if (kind === 'preset') {
            for (const n of lists.presets || []) used.add(n);
        } else if (kind === 'worldbook') {
            for (const n of lists.worldbooks || []) used.add(n);
        } else {
            try {
                const res = await dbCall('list', { kind });
                for (const i of res?.items || []) used.add(i.name);
            } catch {}
        }
        if (!used.has(clean)) return clean;
        let idx = 2;
        let candidate = `${clean} (导入)`;
        while (used.has(candidate)) {
            candidate = `${clean} (导入 ${idx++})`;
        }
        return candidate;
    }

    async function importCharacterFile(d = null, updateInPlace = false) {
        if (updateInPlace) {
            if (!d || d.kind !== 'character' || !d.avatar) throw Error('请先打开一张已保存的角色卡再更新');
            const ok = await modal(
                '更新角色卡 · ' + d.name,
                `<p>选择新版角色卡文件（PNG / JSON / YAML / CharX）覆盖当前角色卡 <strong>${esc(d.name)}</strong>。</p>` +
                    `<p class="muted">将先自动备份旧版，并原位保留原文件名、聊天记录、酒馆标签与附加世界书绑定。</p>`,
                { submit: '选择文件并更新' },
            );
            if (!ok) return;
        }
        const file = await pickFile('.png,.json,.yaml,.yml,.charx,.byaf');
        if (!file) return;
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!['png', 'json', 'yaml', 'yml', 'charx', 'byaf'].includes(ext)) {
            throw Error('不支持的角色卡格式：' + ext);
        }
        const dataBase64 = await fileToBase64(file);
        const res = await charCall('import', {
            fileName: file.name,
            fileType: ext,
            dataBase64,
            preservedName: updateInPlace ? d.avatar : '',
        });
        ctxApi.setCharacterCatalog?.(res.list);
        if (updateInPlace && d) {
            markSaved(d, res.name, res.raw);
            d.avatar = res.avatar;
            d.sourceName = res.avatar;
            d.charTags = res.tags || [];
            d.charAuxWorlds = res.auxiliary || [];
            d.avatarVersion = res.avatarVersion || Date.now();
            ctxApi.afterSave(d, { name: res.name, sourceName: res.avatar, asNew: false });
            notify('角色卡已更新：「' + res.name + '」（已保留原聊天与标签）');
            return;
        }
        const nextDraft = createDraft('character', res.raw, res.name, true, { takeOwnership: true });
        nextDraft.avatar = res.avatar;
        nextDraft.sourceName = res.avatar;
        nextDraft.charTags = res.tags || [];
        nextDraft.charAuxWorlds = res.auxiliary || [];
        nextDraft.avatarVersion = res.avatarVersion || Date.now();
        await ctxApi.addTab(nextDraft);
        notify('已导入角色卡：「' + res.name + '」');
    }

    async function importDocumentTab(kind) {
        if (kind === 'character') return importCharacterFile(null, false);
        const file = await pickFile(kind === 'worldbook' ? '.json,.yaml,.yml' : '.json');
        if (!file) return;
        const { raw, name } = await parseImportedFile(kind, file);
        const safeName = await uniqueImportName(kind, name);
        const d = createDraft(kind, raw, safeName, false, { takeOwnership: true });
        await ctxApi.addTab(d);
        notify('已导入到新标签（不覆盖原草稿与同名预设）：「' + safeName + '」');
    }

    async function importIntoDraft(d) {
        if (d?.kind === 'character') return importCharacterFile(null, false);
        return importDocumentTab(d?.kind || 'preset');
    }

    async function renameDocument(d, tab) {
        if (!d || !tab) throw Error('没有可重命名的文档');
        const oldDisplay = d.kind === 'character' ? d.name : d.sourceName || d.name;
        const v = await modal(
            '重命名 · ' + oldDisplay,
            field('name', '新名称', oldDisplay, 'text', { required: true }) +
                (d.sourceName
                    ? '<p class="muted">将先自动备份原件再执行重命名' +
                      (d.kind === 'character' ? '（同步迁移聊天目录、标签与附加世界书）。' : '。') +
                      '</p>'
                    : '<p class="muted">当前文档尚未入库，将直接修改草稿标签名称。</p>'),
            { submit: '确认重命名' },
        );
        if (!v) return;
        const newName = v.name.trim();
        if (!newName || newName === oldDisplay) return;

        if (!d.sourceName) {
            d.name = newName;
            if (d.kind === 'character') {
                d.raw.name = newName;
                d.raw.data.name = newName;
            }
            tab.name = newName;
            ctxApi.markMutated(d);
            notify('草稿已重命名为「' + newName + '」');
            return;
        }
        if (d.kind === 'character') {
            const res = await charCall('rename', { avatar: d.avatar || d.sourceName, newName });
            ctxApi.setCharacterCatalog?.(res.list);
            d.name = res.name;
            d.avatar = res.avatar;
            d.sourceName = res.avatar;
            d.raw.name = res.name;
            d.raw.data.name = res.name;
            if (d.base) {
                d.base.name = res.name;
                d.base.data.name = res.name;
            }
            d.avatarVersion = Date.now();
            tab.name = res.name;
            tab.sourceName = res.avatar;
            ctxApi.markMutated(d);
            notify('角色卡已重命名为「' + res.name + '」');
            return;
        }
        if (d.kind === 'preset') {
            const lists = await rpc('preset.rename', { oldName: d.sourceName, name: newName });
            ctxApi.runtime().lists = lists;
            d.name = newName;
            d.sourceName = newName;
            tab.name = newName;
            tab.sourceName = newName;
            ctxApi.markMutated(d);
            notify('预设已重命名为「' + newName + '」');
            return;
        }
        if (d.kind === 'worldbook') {
            const lists = await rpc('world.rename', { oldName: d.sourceName, name: newName });
            ctxApi.runtime().lists = lists;
            d.name = newName;
            d.sourceName = newName;
            tab.name = newName;
            tab.sourceName = newName;
            ctxApi.markMutated(d);
            notify('世界书已重命名为「' + newName + '」');
            return;
        }
        const res = await dbCall('rename', { kind: d.kind, oldName: d.sourceName, name: newName });
        d.name = newName;
        d.sourceName = newName;
        tab.name = newName;
        tab.sourceName = newName;
        if (res.needsReload) ctxApi.markNeedsReload();
        ctxApi.addReceipt(res, '重命名 · ' + oldDisplay + ' → ' + newName);
        ctxApi.afterSave(d, { name: newName, asNew: false });
        notify('数据库预设已重命名为「' + newName + '」');
    }

    async function deleteDocument(d, tab) {
        if (!d || !tab) return;
        if (!d.sourceName) {
            await ctxApi.closeTab(tab.id, true);
            notify('已从顶栏移除「' + tab.name + '」');
            return;
        }
        if (d.kind === 'character') {
            const v = await modal(
                '删除角色卡 · ' + d.name,
                `<p>确定永久删除角色卡 <strong>${esc(d.name)}</strong> 吗？删除前将自动备份原件。</p>` +
                    field('deleteChats', '同时删除该角色关联的全部聊天记录（谨慎勾选）', false, 'checkbox'),
                { submit: '确认删除' },
            );
            if (!v) return;
            const res = await charCall('delete', {
                avatars: [d.avatar || d.sourceName],
                deleteChats: Boolean(v.deleteChats),
            });
            ctxApi.setCharacterCatalog?.(res.list);
            await ctxApi.closeTab(tab.id, true);
            notify('已删除角色卡「' + d.name + '」（已自动备份）');
            return;
        }
        const ok = await modal(
            '删除文档 · ' + d.sourceName,
            `<p>确定永久删除 <strong>${esc(d.sourceName)}</strong> 吗？删除前将自动创建备份文件。</p>`,
            { submit: '确认删除' },
        );
        if (!ok) return;
        if (d.kind === 'preset') {
            ctxApi.runtime().lists = await rpc('preset.delete', { name: d.sourceName });
        } else if (d.kind === 'worldbook') {
            ctxApi.runtime().lists = await rpc('world.delete', { name: d.sourceName });
        } else {
            const res = await dbCall('delete', { kind: d.kind, name: d.sourceName });
            if (res.needsReload) ctxApi.markNeedsReload();
            ctxApi.addReceipt(res, '删除 · ' + d.sourceName);
        }
        await ctxApi.closeTab(tab.id, true);
        notify('已删除「' + d.sourceName + '」（已自动备份）');
    }

    async function saveDraft(d, asNew = false) {
        if (!d) throw Error('没有活动文档');
        if (d.kind === 'character') {
            const create = asNew || !d.avatar;
            if (create) {
                const v = await modal(
                    asNew ? '另存为新角色卡副本' : '保存为新角色卡',
                    field('name', '新角色卡名称', d.name + (asNew ? ' - 副本' : ''), 'text', { required: true }),
                    { submit: '保存' },
                );
                if (!v) return;
                const res = await charCall('saveAs', {
                    sourceAvatar: d.avatar || '',
                    name: v.name.trim(),
                    raw: clone(d.raw),
                });
                ctxApi.setCharacterCatalog?.(res.list);
                if (!asNew) {
                    markSaved(d, res.name, res.raw);
                    d.avatar = res.avatar;
                    d.sourceName = res.avatar;
                    d.charTags = res.tags || [];
                    d.charAuxWorlds = res.auxiliary || [];
                    d.avatarVersion = Date.now();
                    ctxApi.afterSave(d, { name: res.name, sourceName: res.avatar, asNew: false });
                } else {
                    const copyDraft = createDraft('character', res.raw, res.name, true, { takeOwnership: true });
                    copyDraft.avatar = res.avatar;
                    copyDraft.sourceName = res.avatar;
                    copyDraft.charTags = res.tags || [];
                    copyDraft.charAuxWorlds = res.auxiliary || [];
                    copyDraft.avatarVersion = Date.now();
                    await ctxApi.addTab(copyDraft);
                }
                notify((asNew ? '已另存角色卡副本：「' : '已保存新角色卡：「') + res.name + '」');
                return;
            }
            const res = await charCall('save', {
                avatar: d.avatar,
                raw: clone(d.raw),
                base: clone(d.base),
            });
            markSaved(d, res.name, res.raw);
            d.avatar = res.avatar;
            d.sourceName = res.avatar;
            d.charTags = res.tags || [];
            d.charAuxWorlds = res.auxiliary || [];
            const freshList = await charCall('list', { refresh: false });
            ctxApi.setCharacterCatalog?.(freshList);
            ctxApi.afterSave(d, { name: res.name, sourceName: res.avatar, asNew: false });
            notify('已保存角色卡：「' + res.name + '」');
            return;
        }
        let targetName = d.sourceName;
        const create = asNew || !d.sourceName;
        if (create) {
            const v = await modal(
                asNew ? '另存为新文档' : '首次保存文档',
                field('name', '新名称', d.name + (asNew ? ' - 副本' : ''), 'text', { required: true }),
                { submit: '保存' },
            );
            if (!v) return;
            targetName = v.name.trim();
        }
        if (!isDatabaseKind(d.kind)) {
            const res = await rpc('documents.save', {
                kind: d.kind,
                name: targetName,
                raw: clone(d.raw),
                base: create ? null : clone(d.base),
                create,
            });
            if (!asNew) markSaved(d, res.name, res.raw);
            ctxApi.afterSave(d, { name: res.name, asNew });
            notify((asNew ? '已另存副本：「' : '已保存：「') + res.name + '」');
            return;
        }
        const issues = auditDb(d);
        if (issues.length) throw Error(issues.join('；'));
        const res = await dbCall('save', {
            kind: d.kind,
            name: targetName,
            raw: clone(d.raw),
            create,
        });
        if (!asNew) {
            markSaved(d, res.name, res.raw);
            d.nativeRevision = res.revision;
            d.nativeScope = res.scope;
        }
        ctxApi.addReceipt(res, (asNew ? '另存为 · ' : '保存 · ') + res.name);
        if (res.needsReload) ctxApi.markNeedsReload();
        ctxApi.afterSave(d, { name: res.name, asNew });
        notify(
            (asNew ? '已另存副本：「' : '已保存到数据库预设库：「') +
                res.name +
                '」' +
                (res.needsReload ? '（顶部可一键刷新酒馆同步内存）' : ''),
        );
    }

    async function applyDatabaseDraft(d) {
        if (!d || !isDatabaseKind(d.kind)) return;
        if (!d.sourceName || dirty(d)) {
            const autoSave = await modal(
                '应用前需先保存',
                '<p>当前草稿有未保存修改，是否先保存到预设库再继续应用？</p>',
                { submit: '先保存并继续' },
            );
            if (!autoSave) return;
            await saveDraft(d, false);
        }
        const caps = ctxApi.dbCaps() || (await dbCall('capabilities'));
        const scopes = caps.scopes?.[d.kind] || ['global'];
        let chosenScope = scopes[0];
        if (scopes.length > 1) {
            const c = await modal(
                '选择应用范围',
                field('scope', '目标作用域', scopes[0], 'select', {
                    choices: scopes.map((s) => [
                        s,
                        {
                            chat: '当前聊天',
                            global: '全局数据库配置',
                            defaults: '世界书 Agent 全局默认',
                            worldbook: '当前绑定世界书',
                        }[s] || s,
                    ]),
                }),
                { submit: '预览差异' },
            );
            if (!c) return;
            chosenScope = c.scope;
        }
        const preview = await dbCall('previewApply', {
            kind: d.kind,
            name: d.sourceName,
            applyScope: chosenScope,
            target: chosenScope,
        });
        const canEnableToggle = ['promptContinuation', 'promptSimulation', 'contentReplace'].includes(d.kind);
        let diffSection = '';
        if (isPromptKind(d.kind) && preview.before && preview.after) {
            const changedGroups = Object.keys(preview.after.groups).filter(
                (k) => JSON.stringify(preview.before.groups[k]) !== JSON.stringify(preview.after.groups[k]),
            );
            diffSection = changedGroups.length
                ? changedGroups
                      .map((k) => {
                          const r = renderInlineDiffHtml(
                              JSON.stringify(preview.before.groups[k], null, 2),
                              JSON.stringify(preview.after.groups[k], null, 2),
                          );
                          return `<details open><summary>${esc(prompts.groupLabel(k))}（${r.changedCount} 处行变化）</summary><div class="pww-diff-box">${r.html}</div></details>`;
                      })
                      .join('')
                : '<p class="muted">内容与当前生效配置完全一致。</p>';
        }
        const confirmed = await modal(
            '确认应用 · ' + d.name,
            `<p>${esc(preview.warning || '')}</p>` +
                (preview.scopeLabel ? `<p><strong>目标：</strong>${esc(preview.scopeLabel)}</p>` : '') +
                diffSection +
                (canEnableToggle
                    ? field('enableFeature', '同时开启该数据库功能的总开关/功能页', false, 'checkbox')
                    : ''),
            { wide: true, submit: '备份并应用' },
        );
        if (!confirmed) return;
        const result = await dbCall('apply', {
            token: preview.token,
            confirmedDestructive: true,
            enableFeature: Boolean(confirmed.enableFeature),
        });
        d.appliedRevision = d.nativeRevision;
        ctxApi.addReceipt(result, '应用 · ' + d.name);
        if (result.needsReload) ctxApi.markNeedsReload();
        if (ctxApi.afterApply) await ctxApi.afterApply(d, result);
        else ctxApi.refreshView();
        notify('应用成功：「' + d.name + '」' + (result.needsReload ? '（点击顶部横幅一键刷新酒馆生效）' : ''));
    }

    async function openFeatureSwitchDialog() {
        const caps = await dbCall('capabilities');
        ctxApi.setDbCaps(caps);
        const f = caps.features || {};
        await modal(
            '数据库功能开关（含未启用模块）',
            '<p class="muted">即使某功能在数据库中处于关闭状态，你依然可以在工作台编辑并保存其预设/提示词；也可在此直接启停开关。</p>' +
                '<div class="feature-toggle-grid">' +
                FEATURE_LABELS.map(
                    ([k, label]) =>
                        `<div class="feature-row"><span>${esc(label)}</span><label class="mini-switch"><input type="checkbox" data-ft-key="${k}" ${f[k] ? 'checked' : ''}><span></span></label></div>`,
                ).join('') +
                '</div>',
            {
                submit: null,
                onMount(dialog) {
                    for (const inp of $$('[data-ft-key]', dialog)) {
                        inp.onchange = run(async () => {
                            const res = await dbCall('toggleFeature', {
                                key: inp.dataset.ftKey,
                                value: inp.checked,
                            });
                            if (res.needsReload) ctxApi.markNeedsReload();
                            const nextCaps = await dbCall('capabilities');
                            ctxApi.setDbCaps(nextCaps);
                            ctxApi.refreshView();
                            notify((inp.checked ? '已开启：' : '已关闭：') + inp.dataset.ftKey);
                        });
                    }
                },
            },
        );
    }

    async function openDbRunConfig(d) {
        const kind = d?.kind && isDatabaseKind(d.kind) && !isPromptKind(d.kind) ? d.kind : 'plot';
        const rec = await dbCall('readSettings', { kind });
        const v0 = rec.value || {};
        const apiChoices = [['', '跟随默认'], ...(rec.apiPresetNames || []).map((n) => [n, n])];
        let body = '';
        if (kind === 'plot') {
            body =
                field('enabled', '启用剧情推进', Boolean(v0.enabled), 'checkbox') +
                field('plotApiPreset', 'API 预设', v0.plotApiPreset || '', 'select', { choices: apiChoices }) +
                field('minLength', '最小长度', v0.minLength ?? 0, 'number') +
                field('contextTurnCount', '上下文轮数', v0.contextTurnCount ?? 6, 'number') +
                field('extractTags', '提取标签', v0.extractTags || '', 'text') +
                field('extractInjectTags', '注入标签', v0.extractInjectTags || '', 'text');
        } else if (kind === 'tableTemplate') {
            body =
                field('autoUpdateEnabled', '启用自动填表', Boolean(v0.autoUpdateEnabled), 'checkbox') +
                field('tableApiPreset', 'API 预设', v0.tableApiPreset || '', 'select', { choices: apiChoices }) +
                field('autoUpdateThreshold', '触发阈值', v0.autoUpdateThreshold ?? 3, 'number') +
                field('autoUpdateFrequency', '更新频率', v0.autoUpdateFrequency ?? 1, 'number') +
                field('updateBatchSize', '批处理大小', v0.updateBatchSize ?? 2, 'number') +
                field('tableFillMinResponseLength', '填表最小输出字符', v0.tableFillMinResponseLength ?? 0, 'number') +
                field('standardizedTableFillEnabled', '标准化填表', Boolean(v0.standardizedTableFillEnabled), 'checkbox') +
                field('strictJsonTableFillEnabled', '严格 JSON 填表', Boolean(v0.strictJsonTableFillEnabled), 'checkbox');
        } else {
            body =
                field('enabled', '启用正文替换', Boolean(v0.enabled), 'checkbox') +
                field('apiPreset', 'API 预设', v0.apiPreset || '', 'select', { choices: apiChoices }) +
                field('seamlessMode', '无感模式', Boolean(v0.seamlessMode), 'checkbox') +
                field('autoApply', '自动应用', Boolean(v0.autoApply), 'checkbox') +
                field('showDiff', '显示差异', Boolean(v0.showDiff), 'checkbox') +
                field('minLength', '最小长度', v0.minLength ?? 0, 'number') +
                field('maxOptimizations', '最大优化次数', v0.maxOptimizations ?? 1, 'number') +
                field('loopCount', '循环次数', v0.loopCount ?? 1, 'number') +
                field('retryCount', '重试次数', v0.retryCount ?? 2, 'number') +
                field('extractTags', '提取标签', v0.extractTags || '', 'text') +
                field('excludeTags', '排除标签', v0.excludeTags || '', 'text');
        }
        const res = await modal('数据库运行配置 · ' + KIND_LABEL[kind], body, { submit: '保存运行配置' });
        if (!res) return;
        const saved = await dbCall('saveSettings', { kind, value: res });
        ctxApi.addReceipt(saved, '运行配置 · ' + KIND_LABEL[kind]);
        if (saved.needsReload) ctxApi.markNeedsReload();
        notify('运行配置已保存');
    }

    async function globalFindReplace(d) {
        if (!d) throw Error('请先打开文档');
        if (isDatabaseKind(d.kind)) {
            const base = fingerprint(d.raw);
            await modal(
                '全局查找替换 · ' + d.name,
                field('scope', '范围', 'all', 'select', {
                    choices: [
                        ['all', '当前文档全部条目'],
                        ['selected', '仅已选条目'],
                    ],
                }) +
                    field('search', '查找', '', 'textarea', { rows: 3, required: true }) +
                    field('replace', '替换为', '', 'textarea', { rows: 3 }) +
                    '<div class="row">' +
                    field('regex', '正则', false, 'checkbox') +
                    field('caseSensitive', '区分大小写', false, 'checkbox') +
                    field('extended', '转义(\\n/\\t)', false, 'checkbox') +
                    '</div>' +
                    field('content', '替换正文与规则', true, 'checkbox') +
                    (['plot', 'tableTemplate'].includes(d.kind) ? field('inName', '同时替换名称', false, 'checkbox') : ''),
                {
                    wide: true,
                    submit: '预览并替换',
                    onSubmit: async (opts) => {
                        if (fingerprint(d.raw) !== base) throw Error('草稿已变化');
                        const plan = planDatabaseReplacement(d, opts);
                        if (!plan.changes.length) {
                            notify('没有匹配项');
                            return false;
                        }
                        const ok = await modal(
                            '确认替换（' + plan.matches + ' 处）',
                            plan.changes
                                .map((c, i) => {
                                    const diff = renderInlineDiffHtml(c.before, c.after);
                                    return `<details open><summary><input type="checkbox" name="r${i}" checked> ${esc(c.name)} · ${esc(c.label)}（${c.hits}处）</summary><div class="pww-diff-box">${diff.html}</div></details>`;
                                })
                                .join(''),
                            { wide: true, submit: '应用替换到草稿' },
                        );
                        if (!ok) return false;
                        const indices = plan.changes.map((_, i) => i).filter((i) => ok['r' + i]);
                        const count = applyDatabaseReplacement(d, plan, indices);
                        ctxApi.markMutated(d);
                        notify('已替换 ' + count + ' 个字段到草稿');
                        return true;
                    },
                },
            );
            return;
        }
        const v = await modal(
            '全局查找替换 · ' + d.name,
            field('search', '查找', '', 'textarea', { rows: 2, required: true }) +
                field('replace', '替换为', '', 'textarea', { rows: 2 }) +
                '<div class="check-grid">' +
                field('regex', '正则', false, 'checkbox') +
                field('caseSensitive', '区分大小写', false, 'checkbox') +
                field('extended', '转义(\\n/\\t)', false, 'checkbox') +
                (d.kind !== 'character' ? field('inName', '含名称', false, 'checkbox') : '') +
                (d.kind === 'worldbook' ? field('inKeys', '含关键词', false, 'checkbox') : '') +
                '</div>',
            { submit: '预览替换' },
        );
        if (!v) return;
        const temp = { ...d, raw: clone(d.raw) };
        const ids = d.selected.length ? d.selected : entries(d).map((e) => e.id);
        transformEntries(temp, 'replace', { ...v, ids });
        const diff = renderInlineDiffHtml(
            entries(d)
                .map((e) => `## ${e.name}\n${e.content}`)
                .join('\n\n'),
            entries(temp)
                .map((e) => `## ${e.name}\n${e.content}`)
                .join('\n\n'),
        );
        if (!diff.changedCount) {
            notify('没有需要替换的匹配内容');
            return;
        }
        const ok = await modal(
            '确认全局替换（' + diff.changedCount + ' 行变化）',
            `<div class="pww-diff-box">${diff.html}</div>`,
            { wide: true, submit: '应用到草稿' },
        );
        if (!ok) return;
        commit(d, '全局查找替换', () => {
            d.raw = clone(temp.raw);
        });
        ctxApi.markMutated(d);
        notify('已完成全局替换到草稿');
    }

    async function openToolsDialog(d) {
        if (!d) throw Error('先打开文档');
        if (isDatabaseKind(d.kind)) {
            if (isPromptKind(d.kind)) {
                const v = await modal(
                    '恢复内置默认提示词',
                    field('group', '恢复范围', '', 'select', {
                        choices: [['', '整套提示词'], ...Object.keys(d.raw.groups).map((k) => [k, prompts.groupLabel(k)])],
                    }),
                    { submit: '恢复到草稿' },
                );
                if (!v) return;
                const def = await dbCall('defaults', { kind: d.kind });
                commit(d, '恢复内置默认', () => {
                    if (v.group) d.raw.groups[v.group] = clone(def.groups[v.group]);
                    else d.raw.groups = clone(def.groups);
                    d.unitIds = {};
                    prompts.ensureIds(d);
                });
                ctxApi.markMutated(d);
                notify('已恢复默认到草稿');
                return;
            }
            return openDbRunConfig(d);
        }
        const modes = [
            ['format', '格式清理（去除 **，单 * 转空格）'],
            ['cliche', '清理常见 AI 八股词'],
            ...(d.kind === 'worldbook'
                ? [
                      ['keywords', '拆分修复中英文逗号关键词'],
                      ['depth', '深度合并（深度 1-10 归 0 重排）'],
                      ['reorder', '按当前顺序重排 order'],
                      ['audit', '世界书体检审计'],
                  ]
                : []),
        ];
        const chosen = await modal(
            '整理工具 · ' + d.name,
            field('mode', '工具操作', modes[0][0], 'select', { choices: modes }) +
                `<p class="muted">作用范围：${d.selected.length ? `已选 ${d.selected.length} 条` : '全部条目'}</p>`,
            { submit: '执行' },
        );
        if (!chosen) return;
        if (chosen.mode === 'audit') {
            const issues = auditWorld(d.raw);
            await modal(
                '世界书体检结果',
                issues.length
                    ? `<ul>${issues.map((x) => `<li>[${esc(x.severity || 'info')}] ${esc(x.text || x)}</li>`).join('')}</ul>`
                    : '<p>未发现明显结构问题。</p>',
                { submit: null },
            );
            return;
        }
        let extra = {};
        if (chosen.mode === 'cliche') {
            const cw = await modal(
                '输入要清理的词条',
                field('words', '词条列表（逗号或换行分隔）', '不禁, 微微一愣, 嘴角勾起一抹', 'textarea', { rows: 3 }),
                { submit: '预览清理' },
            );
            if (!cw) return;
            extra = cw;
        }
        const ids = d.selected.length ? d.selected : entries(d).map((e) => e.id);
        const temp = { ...d, raw: clone(d.raw) };
        transformEntries(temp, chosen.mode, { ...extra, ids });
        const diff = renderInlineDiffHtml(
            entries(d)
                .map((e) => `${e.name}\n${e.content}`)
                .join('\n\n'),
            entries(temp)
                .map((e) => `${e.name}\n${e.content}`)
                .join('\n\n'),
        );
        if (!diff.changedCount && JSON.stringify(d.raw) === JSON.stringify(temp.raw)) {
            notify('没有可整理的变化');
            return;
        }
        const ok = await modal('确认整理变化', `<div class="pww-diff-box">${diff.html}</div>`, {
            wide: true,
            submit: '应用到草稿',
        });
        if (!ok) return;
        commit(d, '整理 · ' + chosen.mode, () => {
            d.raw = clone(temp.raw);
        });
        ctxApi.markMutated(d);
        notify('整理已应用到草稿');
    }

    async function compareAllDialog(left, right) {
        if (!left || !right) throw Error('请先在对比模式选择两份文档');
        if (left.kind !== right.kind) throw Error('全本比对要求两侧文档类型相同');
        const pairs = pairEntries(left, right);
        const v = await modal(
            `全本比对 · ${left.name} → ${right.name}`,
            '<div class="row"><button type="button" data-sel-diff>仅勾选差异项</button></div>' +
                pairs
                    .map(
                        (p, i) =>
                            `<label class="compare-row"><span><input type="checkbox" name="p${i}" ${p.status !== 'same' ? 'checked' : ''}> ${esc((p.left?.name || '（无）') + ' → ' + (p.right?.name || '（无）'))}</span><span class="badge">${esc(p.status)}</span></label>`,
                    )
                    .join('') +
                field('mode', '批量迁移操作', 'content', 'select', {
                    choices: [
                        ['content', '覆盖右侧正文'],
                        ['keywords', '覆盖关键词'],
                        ['settings', '覆盖设置'],
                        ['all', '覆盖整条'],
                        ['add', '补入右侧缺失条目'],
                        ['remove', '删除右侧多余条目'],
                    ],
                }),
            {
                wide: true,
                submit: '应用到右侧草稿',
                onMount(m) {
                    $('[data-sel-diff]', m).onclick = () => {
                        for (const el of $$('[name^="p"]', m))
                            el.checked = pairs[Number(el.name.slice(1))].status !== 'same';
                    };
                },
            },
        );
        if (!v) return;
        commit(right, '全本比对批量迁移', () => {
            pairs.forEach((p, i) => {
                if (!v['p' + i]) return;
                if (v.mode === 'add' && p.left && !p.right) transfer(left, right, [p.left.id]);
                else if (v.mode === 'remove' && !p.left && p.right) removeEntries(right, [p.right.id]);
                else if (p.left && p.right && !['add', 'remove'].includes(v.mode))
                    overwriteEntry(left, right, p.left.id, p.right.id, v.mode);
            });
        });
        ctxApi.markMutated(right);
        notify('全本比对迁移已应用到右侧草稿');
    }

    async function exportDraft(d) {
        if (!d) throw Error('没有活动文档');
        if (d.kind === 'character') {
            if (!d.avatar) {
                download(d.name + '.json', d.raw);
                return;
            }
            const v = await modal(
                '导出角色卡 · ' + d.name,
                field('fmt', '导出格式', 'png', 'select', {
                    choices: [
                        ['png', 'PNG 角色卡（含头像图与完整 V2 数据，推荐）'],
                        ['json', 'JSON 文件（仅文本结构）'],
                    ],
                }) +
                    (dirty(d)
                        ? '<p class="muted">提示：当前草稿有未保存修改；导出 PNG 会读取已保存卡文件，建议先保存后再导出。</p>'
                        : ''),
                { submit: '导出' },
            );
            if (!v) return;
            if (v.fmt === 'json') {
                download(d.name + '.json', d.raw);
                return;
            }
            const res = await charCall('export', { avatar: d.avatar, format: 'png' });
            downloadBase64(res.fileName || d.name + '.png', res.dataBase64, 'image/png');
            notify('已导出 PNG 角色卡：' + (res.fileName || d.name + '.png'));
            return;
        }
        if (d.kind === 'worldbook') {
            const v = await modal(
                '导出世界书',
                field('fmt', '导出格式', 'json', 'select', {
                    choices: [
                        ['json', '完整原生 JSON（推荐）'],
                        ['yaml', 'YAML 兼容格式'],
                    ],
                }),
                { submit: '导出' },
            );
            if (!v) return;
            if (v.fmt === 'yaml') {
                const yml = await yamlString(entries(d).map((e) => yamlEntry(e.raw)));
                download(d.name + '.yaml', yml, 'text/yaml');
                return;
            }
        }
        download(d.name + '.json', d.raw);
    }

    async function editFoldersDialog(d) {
        if (!d || isDatabaseKind(d.kind)) return;
        const getF = () =>
            d.kind === 'worldbook'
                ? folderMeta(d.raw).folders
                : d.raw.extensions?.presetWorldbookWorkbench?.folders || [];
        const v = await modal(
            '新建分组',
            `<p class="muted">当前已有 ${getF().length} 个分组。</p>` +
                field('name', '新分组名称', '', 'text', { required: true }),
            { submit: '创建分组' },
        );
        if (!v) return;
        commit(d, '创建分组', () => {
            if (d.kind === 'worldbook') {
                const m = folderMeta(d.raw);
                m.folders.push({ id: uuid(), name: v.name.trim() });
                writeFolderMeta(d.raw, m);
            } else {
                d.raw.extensions ||= {};
                d.raw.extensions.presetWorldbookWorkbench ||= { folders: [], groups: {} };
                d.raw.extensions.presetWorldbookWorkbench.folders.push({ id: uuid(), name: v.name.trim() });
            }
        });
        ctxApi.markMutated(d);
        notify('已创建分组「' + v.name.trim() + '」');
    }

    async function openBindingsDialog(d) {
        if (!d || d.kind !== 'worldbook' || !d.sourceName) throw Error('请先保存世界书后再管理绑定');
        const l = ctxApi.runtime().lists || {};
        const name = d.sourceName;
        const v = await modal(
            '世界书绑定 · ' + name,
            `<p class="muted">当前角色：${esc(l.characterName || '未打开角色')}</p>` +
                field('global', '全局世界书', (l.global || []).includes(name), 'checkbox') +
                field('chat', '当前聊天世界书', l.chatWorld === name, 'checkbox') +
                field('primary', '当前角色主世界书', l.mainWorld === name, 'checkbox') +
                field('auxiliary', '当前角色附加世界书', (l.auxiliary || []).includes(name), 'checkbox'),
            { submit: '更新绑定' },
        );
        if (!v) return;
        let nextLists = l;
        for (const [target, cur, next] of [
            ['global', (l.global || []).includes(name), v.global],
            ['chat', l.chatWorld === name, v.chat],
            ['primary', l.mainWorld === name, v.primary],
            ['auxiliary', (l.auxiliary || []).includes(name), v.auxiliary],
        ]) {
            if (cur !== next) nextLists = await rpc('world.bind', { name, target, remove: !next });
        }
        ctxApi.runtime().lists = nextLists;
        notify('绑定已更新');
    }

    async function tokenStatsDialog(d) {
        if (!d) throw Error('没有活动文档');
        const list = entries(d);
        if (d.kind === 'character') {
            const permanentIds = new Set([
                'description',
                'personality',
                'scenario',
                'mes_example',
                'system_prompt',
                'post_history_instructions',
                'depth_prompt',
            ]);
            const permText = list
                .filter((e) => permanentIds.has(e.id))
                .map((e) => e.content)
                .join('\n');
            const firstText = list.find((e) => e.id === 'first_mes')?.content || '';
            const altList = list.filter((e) => e.isAltGreeting);
            const allText = list.map((e) => e.content).join('\n');
            const perItem = await Promise.all(
                list.map(async (e) => ({
                    name: e.name,
                    chars: e.content.length,
                    tokens: e.content ? Number(await rpc('tokens', { text: e.content })) : 0,
                })),
            );
            const [permTok, firstTok, allTok] = await Promise.all([
                rpc('tokens', { text: permText }),
                rpc('tokens', { text: firstText }),
                rpc('tokens', { text: allText }),
            ]);
            await modal(
                '角色卡 Token 与字符统计 · ' + d.name,
                `<div class="settings-card">
                    <div class="settings-row"><span><strong>永久提示词（每轮注入）</strong></span><span><strong>${Number(permTok).toLocaleString()}</strong> tokens（${permText.length.toLocaleString()} 字符）</span></div>
                    <div class="settings-row"><span><strong>主开场白</strong></span><span><strong>${Number(firstTok).toLocaleString()}</strong> tokens（${firstText.length.toLocaleString()} 字符）</span></div>
                    <div class="settings-row"><span><strong>整卡合计（含 ${altList.length} 条备选开场白）</strong></span><span><strong>${Number(allTok).toLocaleString()}</strong> tokens（${allText.length.toLocaleString()} 字符）</span></div>
                </div>
                <div class="settings-card">
                    <div class="settings-card-head"><strong>各字段明细</strong></div>
                    <div class="entry-list" style="max-height:260px;overflow:auto">
                        ${perItem
                            .map(
                                (it) =>
                                    `<div class="settings-row"><span>${esc(it.name)}</span><span class="muted">${it.tokens.toLocaleString()} tok · ${it.chars.toLocaleString()} 字</span></div>`,
                            )
                            .join('')}
                    </div>
                </div>`,
                { wide: true, submit: null },
            );
            return;
        }
        const enabledText = list
            .filter((e) => e.enabled)
            .map((e) => e.content)
            .join('\n');
        const allText = list.map((e) => e.content).join('\n');
        const [enTok, allTok] = await Promise.all([
            rpc('tokens', { text: enabledText }),
            rpc('tokens', { text: allText }),
        ]);
        await modal(
            'Token 与字符统计 · ' + d.name,
            `<div class="db-segment">
                <div>条目总数：<strong>${list.length}</strong>（已启用 ${list.filter((e) => e.enabled).length} 条）</div>
                <div>启用条目约：<strong>${Number(enTok).toLocaleString()}</strong> tokens（${enabledText.length.toLocaleString()} 字符）</div>
                <div>全部条目约：<strong>${Number(allTok).toLocaleString()}</strong> tokens（${allText.length.toLocaleString()} 字符）</div>
            </div>`,
            { submit: null },
        );
    }

    async function changeCharacterAvatar(d) {
        if (!d || d.kind !== 'character' || !d.avatar) throw Error('请先保存角色卡后再更换头像图片');
        const file = await pickFile('.png,.jpg,.jpeg,.webp,.gif');
        if (!file) return;
        const dataBase64 = await fileToBase64(file);
        const res = await charCall('editAvatar', {
            avatar: d.avatar,
            fileName: file.name,
            mimeType: file.type || 'image/png',
            dataBase64,
        });
        d.avatarVersion = res.avatarVersion || Date.now();
        ctxApi.bumpAvatarVersion?.(d.avatar, d.avatarVersion);
        ctxApi.refreshView();
        notify('角色卡图片已更新');
    }

    async function openCharacterWorldBindingsDialog(d) {
        if (!d || d.kind !== 'character' || !d.avatar) throw Error('请先保存角色卡后再修改世界书绑定');
        const lists = ctxApi.runtime().lists || { worldbooks: [] };
        const worlds = lists.worldbooks || [];
        const curPrimary = d.raw?.data?.extensions?.world || '';
        const curAux = new Set(d.charAuxWorlds || []);
        const choices = [['', '（未绑定主世界书）'], ...worlds.map((w) => [w, w])];

        const v = await modal(
            '修改绑定世界书 · ' + d.name,
            field('primaryWorld', '角色主世界书 (data.extensions.world)', curPrimary, 'select', { choices }) +
                `<div class="field"><label><span>附加世界书（可多选，当前 ${curAux.size} 本）</span></label>` +
                `<input type="search" data-aux-filter placeholder="搜索附加世界书…" style="width:100%;margin-bottom:4px">` +
                `<div class="open-picker-list" data-aux-list style="max-height:220px">` +
                (worlds.length
                    ? worlds
                          .map(
                              (w, i) =>
                                  `<label class="picker-item" data-aux-row="${esc(w.toLowerCase())}">` +
                                  `<input type="checkbox" name="aux_${i}" data-aux-name="${esc(w)}" ${curAux.has(w) ? 'checked' : ''}>` +
                                  `<span class="picker-item-label">${esc(w)}</span></label>`,
                          )
                          .join('')
                    : '<p class="muted" style="padding:8px">暂无可选世界书</p>') +
                `</div></div>`,
            {
                wide: false,
                submit: '保存绑定',
                onMount(dialog) {
                    const f = $('[data-aux-filter]', dialog);
                    if (f) {
                        f.oninput = () => {
                            const q = f.value.trim().toLowerCase();
                            for (const row of $$('[data-aux-row]', dialog)) {
                                row.style.display = !q || row.dataset.auxRow.includes(q) ? '' : 'none';
                            }
                        };
                    }
                },
                onSubmit(val, dialog) {
                    const aux = [...$$('[data-aux-name]', dialog)]
                        .filter((el) => el.checked)
                        .map((el) => el.dataset.auxName);
                    return { primaryWorld: val.primaryWorld || '', auxiliaryWorlds: aux };
                },
            },
        );
        if (!v) return;
        const res = await charCall('setWorldBindings', {
            avatar: d.avatar,
            primaryWorld: v.primaryWorld,
            auxiliaryWorlds: v.auxiliaryWorlds,
        });
        ctxApi.setCharacterCatalog?.(res.list);
        d.raw.data ||= {};
        d.raw.data.extensions ||= {};
        d.raw.data.extensions.world = res.primaryWorld;
        if (d.base?.data?.extensions) d.base.data.extensions.world = res.primaryWorld;
        d.charAuxWorlds = res.auxiliaryWorlds;
        ctxApi.refreshView();
        notify('角色卡世界书绑定已更新');
    }

    async function jumpToCharacterWorldbook(d, preferredBook = '') {
        if (!d || d.kind !== 'character') return;
        const primary = d.raw?.data?.extensions?.world || '';
        const aux = d.charAuxWorlds || [];
        let target = preferredBook || '';
        if (!target) {
            const candidates = [...new Set([primary, ...aux].filter(Boolean))];
            if (!candidates.length) {
                notify('该角色卡尚未绑定世界书，请先点击「绑定世界书」选择一本', true);
                return;
            }
            if (candidates.length === 1) {
                target = candidates[0];
            } else {
                const pick = await modal(
                    '选择要跳转的世界书',
                    field('book', '已绑定的世界书', primary || candidates[0], 'select', {
                        choices: candidates.map((b) => [b, b === primary ? `${b}（主世界书）` : `${b}（附加）`]),
                    }),
                    { submit: '打开世界书' },
                );
                if (!pick) return;
                target = pick.book;
            }
        }
        await openExistingTab('worldbook', target);
    }

    async function openCharacterTagsDialog(d) {
        if (!d || d.kind !== 'character' || !d.avatar) throw Error('请先保存角色卡后再修改标签');
        const cat = ctxApi.characterCatalog?.() || (await charCall('list', { refresh: false }));
        const allTags = cat?.allTags || [];
        const currentSet = new Set(d.charTags || []);
        const cardOnlyTags = (d.raw?.data?.tags || []).filter((t) => !allTags.some((x) => x.name === t));
        const mergedPool = [...new Set([...allTags.map((t) => t.name), ...currentSet, ...cardOnlyTags])];

        const v = await modal(
            '修改角色卡标签 · ' + d.name,
            `<div class="field"><label><span>勾选已有酒馆标签（当前已选 ${currentSet.size} 个）</span></label>` +
                `<input type="search" data-tag-filter placeholder="搜索标签…" style="width:100%;margin-bottom:4px">` +
                `<div class="check-grid open-picker-list" data-tag-list style="max-height:190px;padding:8px">` +
                (mergedPool.length
                    ? mergedPool
                          .map(
                              (t, i) =>
                                  `<label class="check" data-tag-row="${esc(t.toLowerCase())}">` +
                                  `<input type="checkbox" name="tg_${i}" data-tag-name="${esc(t)}" ${currentSet.has(t) ? 'checked' : ''}>${esc(t)}</label>`,
                          )
                          .join('')
                    : '<span class="muted">暂无已有标签，可在下方输入新标签名创建。</span>') +
                `</div></div>` +
                field('newTags', '新增标签（逗号分隔，自动创建到酒馆标签库）', '', 'text') +
                field('syncCardTags', '同时写入角色卡内嵌 data.tags（导出时携带）', true, 'checkbox'),
            {
                wide: false,
                submit: '保存标签',
                onMount(dialog) {
                    const f = $('[data-tag-filter]', dialog);
                    if (f) {
                        f.oninput = () => {
                            const q = f.value.trim().toLowerCase();
                            for (const row of $$('[data-tag-row]', dialog)) {
                                row.style.display = !q || row.dataset.tagRow.includes(q) ? '' : 'none';
                            }
                        };
                    }
                },
                onSubmit(val, dialog) {
                    const picked = [...$$('[data-tag-name]', dialog)]
                        .filter((el) => el.checked)
                        .map((el) => el.dataset.tagName);
                    const added = String(val.newTags || '')
                        .split(/[,，\n]/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                    return {
                        tagNames: [...new Set([...picked, ...added])],
                        syncCardTags: Boolean(val.syncCardTags),
                    };
                },
            },
        );
        if (!v) return;
        const res = await charCall('setTags', {
            avatar: d.avatar,
            tagNames: v.tagNames,
            syncCardTags: v.syncCardTags,
        });
        ctxApi.setCharacterCatalog?.(res.list);
        d.charTags = res.tags;
        if (v.syncCardTags) {
            d.raw.tags = [...res.tags];
            d.raw.data.tags = [...res.tags];
            if (d.base) {
                d.base.tags = [...res.tags];
                if (d.base.data) d.base.data.tags = [...res.tags];
            }
        }
        ctxApi.refreshView();
        notify('角色卡标签已更新（共 ' + res.tags.length + ' 个）');
    }

    async function batchDeleteCharacters(avatars) {
        const list = [...new Set((avatars || []).filter(Boolean))];
        if (!list.length) return false;
        const cat = ctxApi.characterCatalog?.();
        const nameMap = new Map((cat?.items || []).map((c) => [c.avatar, c.name]));
        const v = await modal(
            `批量删除角色卡（共 ${list.length} 张）`,
            `<p>确定永久删除以下 <strong>${list.length}</strong> 张角色卡吗？每张删除前都会自动备份。</p>` +
                `<div class="db-segment" style="max-height:180px;overflow:auto">${list.map((a) => `<div>• ${esc(nameMap.get(a) || a)}</div>`).join('')}</div>` +
                field('deleteChats', '同时删除所选角色卡的全部关联聊天记录（默认不勾选）', false, 'checkbox'),
            { submit: `确认删除 (${list.length})` },
        );
        if (!v) return false;
        const res = await charCall('delete', { avatars: list, deleteChats: Boolean(v.deleteChats) });
        ctxApi.setCharacterCatalog?.(res.list);
        for (const avatar of res.deleted || []) {
            const opened = ctxApi.findTab('character', avatar);
            if (opened) await ctxApi.closeTab(opened.id, true);
        }
        notify(`已批量删除 ${res.deleted.length} 张角色卡（均已自动备份）`);
        return true;
    }

    async function openReceiptsDialog() {
        const list = ctxApi.receipts();
        const backups = ctxApi.backups ? ctxApi.backups() : [];
        const backupHtml = backups.length
            ? backups
                  .slice(0, 40)
                  .map(
                      (b) => `
                  <div class="settings-row">
                      <span><strong>${esc(b.name)}</strong> <span class="badge">${esc(KIND_LABEL[b.kind] || b.kind)}</span> <span class="muted">${esc(new Date(b.at).toLocaleString())}</span></span>
                      <button type="button" class="mini-btn" data-restore-bk="${esc(b.id)}">载入恢复草稿</button>
                  </div>`,
                  )
                  .join('')
            : '<p class="muted" style="margin:0">暂无预设/世界书保存前原件备份。</p>';

        const receiptHtml = list.length
            ? list
                  .map(
                      (r) => `
                  <div class="settings-row">
                      <span><strong>${esc(r.label)}</strong> <span class="muted">${esc(new Date(r.at).toLocaleString())}</span></span>
                      ${r.backup?.path ? `<button type="button" class="mini-btn" data-dl-bk="${esc(r.backup.path)}">下载备份</button>` : ''}
                  </div>`,
                  )
                  .join('')
            : '<p class="muted" style="margin:0">本次会话暂无数据库操作回执。</p>';

        await modal(
            '备份与操作回执',
            `<section class="settings-card">
                <div class="settings-card-head"><strong>预设与世界书原件备份</strong><span class="badge">${backups.length}</span></div>
                <div class="entry-list">${backupHtml}</div>
            </section>
            <section class="settings-card">
                <div class="settings-card-head"><strong>数据库操作回执</strong><span class="badge">${list.length}</span></div>
                <div class="entry-list">${receiptHtml}</div>
            </section>`,
            {
                wide: true,
                submit: null,
                onMount(m, close) {
                    for (const b of $$('[data-restore-bk]', m)) {
                        b.onclick = run(async () => {
                            const v = await rpc('backup.read', { id: b.dataset.restoreBk });
                            if (ctxApi.restoreBackup) await ctxApi.restoreBackup(v);
                            close();
                        });
                    }
                    for (const b of $$('[data-dl-bk]', m)) {
                        b.onclick = run(async () => {
                            const r = await fetch(b.dataset.dlBk, { cache: 'no-store' });
                            if (!r.ok) throw Error('读取备份失败');
                            download(b.dataset.dlBk.split('/').pop(), await r.json());
                        });
                    }
                },
            },
        );
    }

    async function openDocMetaJsonDialog(d) {
        if (!d) return;
        const v = await modal(
            '文档完整 JSON · ' + d.name,
            field('raw', '原始文档 JSON', d.raw, 'json', { rows: 22 }),
            { wide: true, submit: '校验并写入草稿' },
        );
        if (!v) return;
        if (isDatabaseKind(d.kind)) assertSafePatch(v.raw);
        commit(d, '编辑文档完整 JSON', () => {
            d.raw = clone(v.raw);
        });
        ctxApi.markMutated(d);
        notify('文档 JSON 已写入草稿');
    }

    async function batchDeleteLibrary(kind, names) {
        const list = [...new Set((names || []).filter(Boolean))];
        if (!list.length) return false;
        const ok = await modal(
            `批量删除 ${KIND_LABEL[kind] || kind}（共 ${list.length} 项）`,
            `<p>确定永久删除以下 <strong>${list.length}</strong> 项吗？每项删除前都会自动备份。</p>` +
                `<div class="db-segment" style="max-height:180px;overflow:auto">${list.map((n) => `<div>• ${esc(n)}</div>`).join('')}</div>`,
            { submit: `确认删除 (${list.length})` },
        );
        if (!ok) return false;
        let deleted = 0;
        for (const name of list) {
            if (kind === 'preset') {
                ctxApi.runtime().lists = await rpc('preset.delete', { name });
            } else if (kind === 'worldbook') {
                ctxApi.runtime().lists = await rpc('world.delete', { name });
            } else {
                const res = await dbCall('delete', { kind, name });
                if (res.needsReload) ctxApi.markNeedsReload();
                ctxApi.addReceipt(res, '批量删除 · ' + name);
            }
            const opened = ctxApi.findTab(kind, name);
            if (opened) await ctxApi.closeTab(opened.id, true);
            deleted++;
        }
        notify(`已批量删除 ${deleted} 项（均已自动备份）`);
        return true;
    }

    return {
        openNewTabDialog,
        openExistingTab,
        createNewDocumentTab,
        loadCurrentPromptTab,
        importDocumentTab,
        importIntoDraft,
        importCharacterFile,
        renameDocument,
        deleteDocument,
        batchDeleteLibrary,
        batchDeleteCharacters,
        changeCharacterAvatar,
        openCharacterWorldBindingsDialog,
        jumpToCharacterWorldbook,
        openCharacterTagsDialog,
        saveDraft,
        applyDatabaseDraft,
        openFeatureSwitchDialog,
        openDbRunConfig,
        globalFindReplace,
        openToolsDialog,
        compareAllDialog,
        exportDraft,
        editFoldersDialog,
        openBindingsDialog,
        tokenStatsDialog,
        openReceiptsDialog,
        openDocMetaJsonDialog,
    };
}
