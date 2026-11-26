// 聊天记录管理三栏视图控制器：全角色汇总/按角色入口、排序分组、选择器批量删除、导入导出(TXT/JSONL)、选择+排除标签双生效筛选与右侧分页手动编辑。
import {
    sortChatItems,
    groupChatItemsByCharacter,
    detectChatTags,
    normalizeTagList,
    computeEffectiveFloors,
    paginateFloors,
    serializeChatToTxt,
    serializeChatToJsonl,
} from './chat-model.js';
import { $, $$, esc, field, modal, notify, pickFile, run } from './ui.js';
import { svg, iconBtn } from './icons.js';
import { highlightHtml, findSearchRanges, normalizeQuery } from './diff-search.js';
import { rpc } from './bridge.js';

export const chatCall = (method, args = {}) => rpc('chat.call', { method, args });

function downloadTextFile(fileName, content, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function formatShortTime(val) {
    if (!val) return '';
    if (typeof val === 'number') {
        const d = new Date(val);
        if (!Number.isNaN(d.getTime())) {
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        }
    }
    return String(val).slice(0, 19);
}

export function createChatController(hostApi) {
    const st = {
        catalog: null, // { items, characters, currentAvatar, currentChatId }
        loading: false,
        filterAvatar: '', // '' 全部角色汇总 | 指定角色 avatar
        filterCharName: '',
        sortMode: 'grouped', // 'grouped' | 'last_mes' | 'chat_items' | 'file_size' | 'name'
        sortDir: 'desc',
        search: '',
        selectMode: false,
        selectedKeys: new Set(),

        active: null, // { key, avatar, charName, fileId, fileName, header, messages, detectedTags, manualEdits: Map, deletedFloors: Set, dirty }
        loadingChat: false,
        filter: {
            includeTags: [],
            excludeTags: [],
            stripOuterTags: true,
            keepUserMessages: true,
            hideEmpty: true,
            skipSystem: false,
            search: '',
        },
        searchMode: 'filter', // 'filter' 筛选只显示命中 | 'jump' 定位跳转
        hitCursor: 0,
        page: 1,
        pageSize: 20,
        focusFloorIndex: null,
        dirLimit: 80,
    };
    let lastCoalesceKey = '';
    let lastCoalesceAt = 0;

    function pushHistory(label, coalesceKey = '') {
        const c = st.active;
        if (!c) return;
        const now = Date.now();
        const snap = {
            edits: new Map(c.manualEdits),
            deleted: new Set(c.deletedFloors),
            label,
        };
        if (coalesceKey && coalesceKey === lastCoalesceKey && now - lastCoalesceAt < 900 && c.cursor > 0) {
            c.history[c.cursor] = snap;
        } else {
            c.history = c.history.slice(0, c.cursor + 1);
            c.history.push(snap);
            if (c.history.length > 30) c.history.shift();
            c.cursor = c.history.length - 1;
        }
        lastCoalesceKey = coalesceKey;
        lastCoalesceAt = now;
        c.dirty = c.manualEdits.size > 0 || c.deletedFloors.size > 0;
        hostApi.onHistoryChange?.();
    }

    function canUndo() {
        return Boolean(st.active && st.active.cursor > 0);
    }

    function canRedo() {
        return Boolean(st.active && st.active.cursor < (st.active.history?.length || 1) - 1);
    }

    function applyUndoRedo(step) {
        const c = st.active;
        if (!c || !Array.isArray(c.history)) return false;
        const next = c.cursor + step;
        if (next < 0 || next >= c.history.length) return false;
        c.cursor = next;
        const snap = c.history[next];
        c.manualEdits = new Map(snap.edits);
        c.deletedFloors = new Set(snap.deleted);
        c.dirty = c.manualEdits.size > 0 || c.deletedFloors.size > 0;
        lastCoalesceKey = '';
        hostApi.renderChatPanels();
        hostApi.onHistoryChange?.();
        return true;
    }

    function filteredChats() {
        let items = st.catalog?.items || [];
        if (st.filterAvatar) {
            items = items.filter((it) => it.avatar === st.filterAvatar);
        }
        const q = st.search.trim().toLowerCase();
        if (q) {
            items = items.filter(
                (it) =>
                    (it.file_id || '').toLowerCase().includes(q) ||
                    (it.charName || '').toLowerCase().includes(q) ||
                    (it.mes || '').toLowerCase().includes(q),
            );
        }
        return sortChatItems(items, st.sortMode, st.sortDir);
    }

    function activeMessagesExcludingDeleted() {
        if (!st.active) return [];
        if (!st.active.deletedFloors.size) return st.active.messages;
        return st.active.messages.map((m, idx) => (st.active.deletedFloors.has(idx) ? null : m));
    }

    function currentEffectiveFloors() {
        if (!st.active) return [];
        return computeEffectiveFloors(
            activeMessagesExcludingDeleted(),
            { ...st.filter, filterBySearch: st.searchMode === 'filter' },
            st.active.manualEdits,
        );
    }

    function collectFloorHits(floors, query) {
        const q = normalizeQuery(query);
        if (!q) return [];
        const hits = [];
        for (const f of floors) {
            if (findSearchRanges(f.name, q).length || findSearchRanges(f.text, q).length) {
                hits.push(f);
            }
        }
        return hits;
    }

    async function ensureCatalog(force = false) {
        if (!force && (st.catalog || st.loading)) return st.catalog;
        st.loading = true;
        try {
            const res = await chatCall('listAll');
            st.catalog = res || { items: [], characters: [], currentAvatar: '', currentChatId: '' };
        } catch (err) {
            if (force) notify('读取聊天记录汇总失败：' + err.message, true);
        } finally {
            st.loading = false;
        }
        hostApi.renderChatPanels();
        return st.catalog;
    }

    async function openForCharacter(avatar, charName = '') {
        st.filterAvatar = avatar || '';
        st.filterCharName = charName || (avatar ? avatar.replace(/\.png$/i, '') : '');
        st.selectMode = false;
        st.selectedKeys.clear();
        await ensureCatalog(false);
        // 单独同步一次该角色目录确保最新
        if (avatar) {
            try {
                const sub = await chatCall('listByCharacter', { avatar });
                if (st.catalog && Array.isArray(sub?.items)) {
                    const others = st.catalog.items.filter((x) => x.avatar !== avatar);
                    st.catalog.items = [...others, ...sub.items];
                }
            } catch {}
        }
        hostApi.renderChatPanels();
    }

    async function openChatItem(item) {
        if (!item?.avatar || !item?.file_id) return;
        if (st.active?.dirty) {
            const ok = await modal(
                '切换聊天记录？',
                `<p>当前聊天「${esc(st.active.fileId)}」有尚未保存的手动编辑，切换后将放弃未保存修改。</p>`,
                { submit: '放弃修改并切换' },
            );
            if (!ok) return;
        }
        st.loadingChat = true;
        hostApi.renderChatPanels();
        try {
            const res = await chatCall('read', {
                avatar: item.avatar,
                fileId: item.file_id,
                charName: item.charName,
            });
            st.active = {
                key: item.key,
                avatar: res.avatar,
                charName: res.charName,
                fileId: res.fileId,
                fileName: res.fileName,
                header: res.header,
                messages: res.messages || [],
                detectedTags: detectChatTags(res.messages || []),
                manualEdits: new Map(),
                deletedFloors: new Set(),
                history: [{ edits: new Map(), deleted: new Set(), label: '载入' }],
                cursor: 0,
                dirty: false,
            };
            st.page = 1;
            st.dirLimit = 80;
            st.hitCursor = 0;
            st.focusFloorIndex = null;
            st.filter.search = '';
            lastCoalesceKey = '';
            hostApi.onSelectChat?.();
            hostApi.onHistoryChange?.();
        } catch (err) {
            notify('读取聊天记录失败：' + err.message, true);
        } finally {
            st.loadingChat = false;
        }
        hostApi.renderChatPanels();
    }

    async function importChatDialog() {
        await ensureCatalog(false);
        const chars = st.catalog?.characters || [];
        if (!chars.length) throw Error('当前酒馆没有可用角色卡，请先创建或导入角色卡');
        const defaultAvatar = st.filterAvatar || st.active?.avatar || st.catalog?.currentAvatar || chars[0].avatar;
        const v = await modal(
            '导入聊天记录',
            field('avatar', '导入到角色卡', defaultAvatar, 'select', {
                choices: chars.map((c) => [c.avatar, c.name]),
            }) +
                '<p class="muted">支持 SillyTavern 聊天记录 <code>.jsonl</code>、第三方 <code>.json</code> 以及纯文本 <code>.txt</code>（自动转为标准聊天记录）。</p>',
            { submit: '选择文件并导入' },
        );
        if (!v) return;
        const file = await pickFile('.jsonl,.json,.txt');
        if (!file) return;
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!['jsonl', 'json', 'txt'].includes(ext)) {
            throw Error('不支持的聊天文件格式：.' + ext);
        }
        const text = await file.text();
        const targetChar = chars.find((c) => c.avatar === v.avatar);
        const res = await chatCall('import', {
            avatar: v.avatar,
            charName: targetChar?.name || '',
            fileName: file.name,
            fileType: ext,
            text,
        });
        await ensureCatalog(true);
        const importedName = res.fileNames?.[0];
        if (importedName) {
            const match = (st.catalog?.items || []).find(
                (it) => it.avatar === v.avatar && (it.file_name === importedName || it.file_id === importedName.replace(/\.jsonl$/i, '')),
            );
            if (match) await openChatItem(match);
        }
        notify(`已导入聊天记录到「${res.charName}」`);
    }

    async function exportChatDialog(format) {
        if (!st.active) throw Error('请先打开一条聊天记录');
        const allEffective = currentEffectiveFloors();
        const hasFilterOrEdit =
            st.filter.includeTags.length > 0 ||
            st.filter.excludeTags.length > 0 ||
            st.active.manualEdits.size > 0 ||
            st.active.deletedFloors.size > 0;
        const baseName = st.active.fileId || 'chat';

        if (format === 'txt') {
            const v = await modal(
                '导出 TXT 纯文本版 · ' + baseName,
                field('scope', '导出内容范围', hasFilterOrEdit ? 'filtered' : 'raw', 'select', {
                    choices: [
                        ['filtered', `当前筛选与编辑后结果（${allEffective.length} 楼）`],
                        ['raw', `原始全部楼层（${st.active.messages.length} 楼）`],
                    ],
                }) +
                    '<div class="check-grid">' +
                    field('includeHeader', '包含说话人名称与时间', true, 'checkbox') +
                    field('includeFloorNo', '包含 #楼层号', true, 'checkbox') +
                    field('hideEmpty', '跳过空白楼层', true, 'checkbox') +
                    '</div>',
                { submit: '导出 TXT' },
            );
            if (!v) return;
            const floors =
                v.scope === 'raw'
                    ? computeEffectiveFloors(st.active.messages, { hideEmpty: false }, new Map())
                    : allEffective;
            const txt = serializeChatToTxt(floors, {
                includeHeader: Boolean(v.includeHeader),
                includeFloorNo: Boolean(v.includeFloorNo),
                hideEmpty: Boolean(v.hideEmpty),
            });
            downloadTextFile(`${baseName}${v.scope === 'filtered' && hasFilterOrEdit ? '_filtered' : ''}.txt`, txt, 'text/plain;charset=utf-8');
            notify(`已导出 TXT 版（共 ${floors.length} 楼）`);
            return;
        }

        const v = await modal(
            '导出聊天记录版 (.jsonl) · ' + baseName,
            field('scope', '导出内容范围', hasFilterOrEdit ? 'filtered' : 'raw', 'select', {
                choices: [
                    ['filtered', `当前筛选与编辑后结果（可重新导回酒馆）`],
                    ['raw', `原始完整聊天记录（含全部原始标签）`],
                ],
            }) +
                field('dropHidden', '剔除筛选后为空或已删除的楼层', true, 'checkbox') +
                '<p class="muted">导出的 <code>.jsonl</code> 保留聊天头与角色元数据，可直接通过「导入聊天」或酒馆原生界面重新导入。</p>',
            { submit: '导出 JSONL' },
        );
        if (!v) return;
        const jsonl =
            v.scope === 'raw'
                ? serializeChatToJsonl(st.active.header, st.active.messages, [], { dropHidden: false })
                : serializeChatToJsonl(st.active.header, activeMessagesExcludingDeleted(), allEffective, {
                      dropHidden: Boolean(v.dropHidden),
                  });
        downloadTextFile(`${baseName}${v.scope === 'filtered' && hasFilterOrEdit ? '_filtered' : ''}.jsonl`, jsonl, 'application/x-ndjson;charset=utf-8');
        notify('已导出标准聊天记录版 (.jsonl)');
    }

    async function saveActiveChat() {
        if (!st.active) throw Error('没有已打开的聊天记录');
        const hasFilter = st.filter.includeTags.length > 0 || st.filter.excludeTags.length > 0;
        const editCount = st.active.manualEdits.size;
        const delCount = st.active.deletedFloors.size;
        if (!editCount && !delCount && !hasFilter) {
            notify('当前没有需要保存的改动');
            return;
        }

        let mode = 'edits';
        if (hasFilter) {
            const v = await modal(
                '保存并应用修改到聊天记录 · ' + st.active.fileId,
                field(
                    'mode',
                    '写入方式',
                    editCount || delCount ? 'edits' : 'all_filtered',
                    'select',
                    {
                        choices: [
                            ['edits', `仅保存手动编辑的 ${editCount} 楼（与删除的 ${delCount} 楼），保留其余楼层原始隐藏标签`],
                            ['all_filtered', '将当前标签筛选 + 手动编辑结果整体写入全部楼层（会永久清洗未编辑楼层的排除标签）'],
                        ],
                    },
                ) + '<p class="muted">保存时酒馆会自动在 backups 目录保留旧版本备份。</p>',
                { submit: '保存并应用' },
            );
            if (!v) return;
            mode = v.mode;
        } else {
            const ok = await modal(
                '保存并应用聊天记录修改 · ' + st.active.fileId,
                `<p>即将写回手动编辑的 <strong>${editCount}</strong> 楼${delCount ? `并移除 <strong>${delCount}</strong> 楼` : ''}，酒馆将自动创建备份。</p>`,
                { submit: '保存并应用' },
            );
            if (!ok) return;
        }

        const nextMessages = [];
        const effAll = mode === 'all_filtered' ? new Map(currentEffectiveFloors().map((f) => [f.floorIndex, f.text])) : null;
        for (let i = 0; i < st.active.messages.length; i++) {
            if (st.active.deletedFloors.has(i)) continue;
            const orig = st.active.messages[i];
            if (mode === 'all_filtered') {
                const text = effAll.has(i) ? effAll.get(i) : orig.mes;
                if (st.filter.hideEmpty && !String(text || '').trim()) continue;
                const copy = structuredClone(orig);
                copy.mes = text;
                if (Array.isArray(copy.swipes) && typeof copy.swipe_id === 'number' && copy.swipes[copy.swipe_id] !== undefined) {
                    copy.swipes[copy.swipe_id] = text;
                }
                nextMessages.push(copy);
            } else if (st.active.manualEdits.has(i)) {
                const text = st.active.manualEdits.get(i);
                const copy = structuredClone(orig);
                copy.mes = text;
                if (Array.isArray(copy.swipes) && typeof copy.swipe_id === 'number' && copy.swipes[copy.swipe_id] !== undefined) {
                    copy.swipes[copy.swipe_id] = text;
                }
                nextMessages.push(copy);
            } else {
                nextMessages.push(orig);
            }
        }

        const res = await chatCall('save', {
            avatar: st.active.avatar,
            charName: st.active.charName,
            fileId: st.active.fileId,
            header: st.active.header,
            messages: nextMessages,
        });
        st.active.messages = nextMessages;
        st.active.detectedTags = detectChatTags(nextMessages);
        st.active.manualEdits.clear();
        st.active.deletedFloors.clear();
        st.active.history = [{ edits: new Map(), deleted: new Set(), label: '已保存' }];
        st.active.cursor = 0;
        st.active.dirty = false;
        lastCoalesceKey = '';
        await ensureCatalog(true);
        hostApi.onHistoryChange?.();
        notify('聊天记录已保存' + (res.isCurrent ? '（这是当前对话，如正在聊天请刷新对话生效）' : ''));
    }

    async function renameActiveChat() {
        if (!st.active) return;
        const v = await modal(
            '重命名聊天记录 · ' + st.active.fileId,
            field('name', '新聊天文件名（无需 .jsonl 后缀）', st.active.fileId, 'text', { required: true }),
            { submit: '确认重命名' },
        );
        if (!v) return;
        const newName = v.name.trim();
        if (!newName || newName === st.active.fileId) return;
        const res = await chatCall('rename', {
            avatar: st.active.avatar,
            oldFileName: st.active.fileName,
            newName,
        });
        st.active.fileId = res.fileId;
        st.active.fileName = res.fileName;
        st.active.key = `${res.avatar}::${res.fileName}`;
        await ensureCatalog(true);
        notify('聊天记录已重命名为「' + res.fileId + '」');
    }

    async function deleteChats(targets) {
        const list = (targets || []).filter((it) => it?.avatar && it?.fileName);
        if (!list.length) return false;
        const ok = await modal(
            `删除聊天记录（共 ${list.length} 条）`,
            `<p>确定永久删除以下 <strong>${list.length}</strong> 条聊天记录吗？</p>` +
                `<div class="db-segment" style="max-height:180px;overflow:auto">${list
                    .map((it) => `<div>• ${esc(it.charName || it.avatar)} — ${esc(it.fileName.replace(/\.jsonl$/i, ''))}</div>`)
                    .join('')}</div>`,
            { submit: `确认删除 (${list.length})` },
        );
        if (!ok) return false;
        const res = await chatCall('delete', {
            items: list.map((it) => ({ avatar: it.avatar, fileName: it.fileName })),
        });
        const deletedKeys = new Set((res.deleted || []).map((d) => `${d.avatar}::${d.fileName}`));
        if (st.active && deletedKeys.has(st.active.key)) {
            st.active = null;
        }
        for (const k of deletedKeys) st.selectedKeys.delete(k);
        await ensureCatalog(true);
        notify(`已删除 ${res.deleted.length} 条聊天记录`);
        return true;
    }

    // === 左栏：聊天记录库（默认按角色分类，排序后按排序列表 + 选择/取消/全选/取消全选/删除） ===
    function renderNav(col, navHeadHtml, bindNavSwitcher) {
        if (!st.catalog && !st.loading) void ensureCatalog(false);
        const totalAll = st.catalog?.items?.length || 0;
        const validKeys = new Set((st.catalog?.items || []).map((it) => it.key));
        for (const k of [...st.selectedKeys]) if (!validKeys.has(k)) st.selectedKeys.delete(k);

        const drawList = () => {
            const listBox = $('[data-chat-list-box]', col);
            const selAllBtn = $('[data-chat-act="sel-all"]', col);
            const delBtn = $('[data-chat-act="del-selected"]', col);
            const countEl = $('[data-chat-count]', col);
            if (!listBox) return;

            const visible = filteredChats();
            const visKeys = visible.map((it) => it.key);
            const allVisSelected = visKeys.length > 0 && visKeys.every((k) => st.selectedKeys.has(k));

            if (countEl) {
                countEl.textContent =
                    st.filterAvatar || st.search.trim() ? `${visible.length}/${totalAll}` : String(totalAll);
            }
            if (selAllBtn) selAllBtn.textContent = allVisSelected ? '取消全选' : '全选';
            if (delBtn) {
                delBtn.disabled = st.selectedKeys.size === 0;
                delBtn.innerHTML = `${svg('trash', 12)} 删除 (${st.selectedKeys.size})`;
            }

            if (st.loading && !st.catalog) {
                listBox.innerHTML = '<p class="muted" style="padding:12px;text-align:center">正在汇总全部聊天记录…</p>';
                return;
            }
            if (!visible.length) {
                listBox.innerHTML = `<p class="muted" style="padding:12px;text-align:center">${totalAll ? '没有匹配的聊天记录' : '暂无聊天记录'}</p>`;
                return;
            }

            const renderRow = (it, showCharAvatar) => {
                const isActive = st.active?.key === it.key;
                const checked = st.selectedKeys.has(it.key);
                const subBits = [
                    showCharAvatar ? it.charName : '',
                    `${it.chat_items} 楼`,
                    it.file_size,
                    formatShortTime(it.last_mes),
                ].filter(Boolean);
                const inner = `
                    ${showCharAvatar ? `<img class="char-thumb chat-mini-thumb" src="${esc(hostApi.charThumbUrl(it.avatar))}" alt="" loading="lazy">` : ''}
                    <div class="char-list-meta">
                        <div class="char-list-name">
                            ${it.isCurrent ? '<span class="lamp-dot is-live" title="酒馆当前对话"></span>' : ''}
                            <span class="nav-item-label">${esc(it.file_id)}</span>
                        </div>
                        <div class="char-list-sub" title="${esc(subBits.join(' · '))}">${esc(subBits.join(' · '))}</div>
                    </div>`;
                if (st.selectMode) {
                    return `
                        <label class="nav-item char-list-item nav-item-check ${checked ? 'active' : ''}" title="${esc(it.file_id)}">
                            <input type="checkbox" data-chat-pick="${esc(it.key)}" ${checked ? 'checked' : ''}>
                            ${inner}
                        </label>`;
                }
                return `
                    <button type="button" class="nav-item char-list-item ${isActive ? 'active' : ''}" data-chat-open="${esc(it.key)}" title="${esc(it.charName + ' · ' + it.file_id)}">
                        ${inner}
                    </button>`;
            };

            if (st.sortMode === 'grouped' && !st.filterAvatar) {
                const groups = groupChatItemsByCharacter(visible);
                listBox.innerHTML = groups
                    .map(
                        (g) => `
                        <div class="chat-group-block">
                            <div class="chat-group-head">
                                <img class="chat-group-avatar" src="${esc(hostApi.charThumbUrl(g.avatar))}" alt="" loading="lazy">
                                <span class="chat-group-name" title="${esc(g.charName)}">${esc(g.charName)}</span>
                                <span class="nav-badge">${g.items.length}</span>
                            </div>
                            <div class="nav-list">
                                ${g.items.map((it) => renderRow(it, false)).join('')}
                            </div>
                        </div>`,
                    )
                    .join('');
            } else {
                listBox.innerHTML = visible.map((it) => renderRow(it, !st.filterAvatar)).join('');
            }

            const byKey = new Map(visible.map((it) => [it.key, it]));
            for (const chk of $$('[data-chat-pick]', listBox)) {
                chk.onchange = () => {
                    const k = chk.dataset.chatPick;
                    if (chk.checked) st.selectedKeys.add(k);
                    else st.selectedKeys.delete(k);
                    chk.closest('.char-list-item')?.classList.toggle('active', chk.checked);
                    const vis = filteredChats().map((x) => x.key);
                    if (selAllBtn) {
                        selAllBtn.textContent = vis.length > 0 && vis.every((x) => st.selectedKeys.has(x)) ? '取消全选' : '全选';
                    }
                    if (delBtn) {
                        delBtn.disabled = st.selectedKeys.size === 0;
                        delBtn.innerHTML = `${svg('trash', 12)} 删除 (${st.selectedKeys.size})`;
                    }
                };
            }
            for (const btn of $$('[data-chat-open]', listBox)) {
                btn.onclick = run(async () => {
                    const item = byKey.get(btn.dataset.chatOpen);
                    if (item) await openChatItem(item);
                });
            }
        };

        const charScopeBanner = st.filterAvatar
            ? `<div class="chat-scope-bar">
                   <img class="chat-group-avatar" src="${esc(hostApi.charThumbUrl(st.filterAvatar))}" alt="">
                   <span class="chat-scope-label" title="${esc(st.filterCharName)}">仅看：${esc(st.filterCharName)}</span>
                   <button type="button" class="mini-btn" data-chat-act="clear-char-scope">查看全部</button>
               </div>`
            : '';

        const bulkBar = st.selectMode
            ? `<div class="nav-select-bar">
                   <button type="button" class="mini-btn" data-chat-act="sel-all">全选</button>
                   <button type="button" class="mini-btn danger" data-chat-act="del-selected" ${st.selectedKeys.size ? '' : 'disabled'}>${svg('trash', 12)} 删除 (${st.selectedKeys.size})</button>
               </div>`
            : '';

        col.innerHTML = `
            ${navHeadHtml}
            ${charScopeBanner}
            <div class="panel-subbar char-nav-tools">
                <span class="muted" style="font-size:calc(11.5px * var(--pww-scale))">聊天 <strong data-chat-count>${totalAll}</strong> 条</span>
                <div class="row" style="gap:3px">
                    ${iconBtn('import', '导入聊天记录 (.jsonl / .json / .txt)', 'data-chat-act="import"', 'sm')}
                    ${iconBtn('refresh', '刷新聊天记录汇总', 'data-chat-act="refresh"', 'sm')}
                </div>
            </div>
            <div class="char-sort-bar">
                <select data-chat-sort title="聊天记录排序方式">
                    <option value="grouped" ${st.sortMode === 'grouped' ? 'selected' : ''}>默认按角色分类</option>
                    <option value="last_mes" ${st.sortMode === 'last_mes' ? 'selected' : ''}>按最近聊天时间</option>
                    <option value="chat_items" ${st.sortMode === 'chat_items' ? 'selected' : ''}>按消息楼层数</option>
                    <option value="file_size" ${st.sortMode === 'file_size' ? 'selected' : ''}>按文件大小</option>
                    <option value="name" ${st.sortMode === 'name' ? 'selected' : ''}>按名称排序</option>
                </select>
                ${
                    st.sortMode === 'grouped'
                        ? ''
                        : `<button type="button" class="mini-btn" data-chat-sort-dir title="切换升序 / 降序">${st.sortDir === 'asc' ? '升序 ↑' : '降序 ↓'}</button>`
                }
            </div>
            <div class="char-search-wrap nav-search-row">
                <input type="search" data-chat-search placeholder="搜索角色名 / 聊天名 / 摘要…" value="${esc(st.search)}">
                <button type="button" class="nav-sel-toggle ${st.selectMode ? 'active' : ''}" data-chat-act="toggle-select" title="${st.selectMode ? '退出选择模式' : '批量选择并删除聊天记录'}">${st.selectMode ? '取消' : '选择'}</button>
            </div>
            ${bulkBar}
            <div class="panel-scroll">
                <div class="nav-list char-nav-list" data-chat-list-box></div>
            </div>
        `;

        bindNavSwitcher(col);
        drawList();

        const sortSel = $('[data-chat-sort]', col);
        if (sortSel) {
            sortSel.onchange = () => {
                st.sortMode = sortSel.value;
                st.sortDir = st.sortMode === 'name' ? 'asc' : 'desc';
                renderNav(col, navHeadHtml, bindNavSwitcher);
            };
        }
        const dirBtn = $('[data-chat-sort-dir]', col);
        if (dirBtn) {
            dirBtn.onclick = () => {
                st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
                dirBtn.textContent = st.sortDir === 'asc' ? '升序 ↑' : '降序 ↓';
                drawList();
            };
        }
        const sInp = $('[data-chat-search]', col);
        if (sInp) {
            let comp = false;
            sInp.addEventListener('compositionstart', () => (comp = true));
            sInp.addEventListener('compositionend', () => {
                comp = false;
                st.search = sInp.value;
                drawList();
            });
            sInp.addEventListener('input', () => {
                if (!comp) {
                    st.search = sInp.value;
                    drawList();
                }
            });
        }

        for (const b of $$('[data-chat-act]', col)) {
            b.onclick = run(async () => {
                const act = b.dataset.chatAct;
                if (act === 'clear-char-scope') {
                    st.filterAvatar = '';
                    st.filterCharName = '';
                    renderNav(col, navHeadHtml, bindNavSwitcher);
                    return;
                }
                if (act === 'toggle-select') {
                    st.selectMode = !st.selectMode;
                    if (!st.selectMode) st.selectedKeys.clear();
                    renderNav(col, navHeadHtml, bindNavSwitcher);
                    return;
                }
                if (act === 'sel-all') {
                    const vis = filteredChats().map((x) => x.key);
                    const allSel = vis.length > 0 && vis.every((k) => st.selectedKeys.has(k));
                    if (allSel) {
                        for (const k of vis) st.selectedKeys.delete(k);
                    } else {
                        for (const k of vis) st.selectedKeys.add(k);
                    }
                    drawList();
                    return;
                }
                if (act === 'del-selected') {
                    const byKey = new Map((st.catalog?.items || []).map((it) => [it.key, it]));
                    const targets = [...st.selectedKeys].map((k) => byKey.get(k)).filter(Boolean);
                    const ok = await deleteChats(targets.map((it) => ({ avatar: it.avatar, fileName: it.file_name, charName: it.charName })));
                    if (ok) {
                        st.selectedKeys.clear();
                        st.selectMode = false;
                        hostApi.renderChatPanels();
                    }
                    return;
                }
                if (act === 'import') {
                    await importChatDialog();
                    return;
                }
                if (act === 'refresh') {
                    await ensureCatalog(true);
                    notify('聊天记录汇总已刷新');
                }
            });
        }
    }

    // === 中栏：标签筛选控制台（选择标签 + 排除标签同时生效）与楼层目录 ===
    function renderMiddle(col) {
        if (st.loadingChat) {
            col.innerHTML = `
                <div class="panel-head"><div class="panel-head-title">${svg('chat', 15)}<h2>正在加载聊天记录…</h2></div></div>
                <div class="panel-scroll" style="display:flex"><div class="inspector-empty"><p class="muted">正在读取楼层并自动扫描标签…</p></div></div>
            `;
            return;
        }
        if (!st.active) {
            col.innerHTML = `
                <div class="panel-head">
                    <div class="panel-head-title">${svg('chat', 15)}<h2>聊天记录管理</h2></div>
                    <div class="panel-head-actions">
                        ${iconBtn('import', '导入聊天记录', 'data-chat-mid="import"', 'sm primary')}
                    </div>
                </div>
                <div class="panel-subbar"><span class="muted">支持汇总查看、选择与排除标签同时生效、分页预览编辑与 TXT/JSONL 导出</span></div>
                <div class="panel-scroll" style="display:flex">
                    <div class="inspector-empty">
                        ${svg('chat', 34)}
                        <h3 style="margin:4px 0">聊天记录管理</h3>
                        <p>请在左侧选择任意角色的聊天记录，或点击下方导入聊天文件。</p>
                        <div class="row">
                            <button type="button" class="primary" data-chat-mid="import">${svg('import', 14)} 导入聊天记录</button>
                        </div>
                    </div>
                </div>
            `;
            for (const b of $$('[data-chat-mid="import"]', col)) b.onclick = run(() => importChatDialog());
            return;
        }

        const c = st.active;
        const floors = currentEffectiveFloors();
        const hits = collectFloorHits(floors, st.filter.search);
        if (hits.length && st.hitCursor >= hits.length) st.hitCursor = 0;
        const focusedHitFloor = hits.length ? hits[st.hitCursor]?.floorIndex : null;
        const hasSearch = Boolean(normalizeQuery(st.filter.search));
        const incSet = new Set(st.filter.includeTags.map((t) => t.toLowerCase()));
        const excSet = new Set(st.filter.excludeTags.map((t) => t.toLowerCase()));
        const editCount = c.manualEdits.size + c.deletedFloors.size;
        const statusBadge = editCount
            ? `<span class="badge badge-dirty"><span class="lamp-dot is-dirty"></span>已改 ${editCount} 楼</span>`
            : `<span class="badge">${c.messages.length} 楼</span>`;

        const detectedHtml = c.detectedTags.length
            ? c.detectedTags
                  .slice(0, 36)
                  .map((t) => {
                      const low = t.tag.toLowerCase();
                      const mode = incSet.has(low) ? 'include' : excSet.has(low) ? 'exclude' : 'none';
                      const cls = mode === 'include' ? 'is-include' : mode === 'exclude' ? 'is-exclude' : '';
                      const prefix = mode === 'include' ? '✓ ' : mode === 'exclude' ? '✕ ' : '';
                      return `<button type="button" class="chat-tag-chip ${cls}" data-tag-cycle="${esc(t.tag)}" title="点击切换：不限 → 选择提取 → 排除剔除（出现 ${t.count} 次 / ${t.msgCount} 楼）">${prefix}&lt;${esc(t.tag)}&gt;<span>${t.count}</span></button>`;
                  })
                  .join('')
            : '<span class="muted" style="font-size:calc(11.5px * var(--pww-scale))">该聊天未检测到成对 XML/HTML 标签，可手动输入标签名。</span>';

        const slice = floors.slice(0, st.dirLimit);
        const hasMore = slice.length < floors.length;

        col.innerHTML = `
            <div class="panel-head">
                <div class="panel-head-title">
                    ${svg('chat', 15)}
                    <h2 title="${esc(c.charName + ' · ' + c.fileId)}">${esc(c.fileId)}</h2>
                    ${statusBadge}
                </div>
                <div class="panel-head-actions">
                    ${iconBtn('save', '保存并应用 (Ctrl+S)', 'data-chat-mid="save"', 'sm primary')}
                    ${iconBtn('rename', '重命名聊天文件', 'data-chat-mid="rename"', 'sm')}
                    ${iconBtn('more', '更多聊天操作', 'data-chat-mid="more"', 'sm')}
                </div>
            </div>
            <div class="panel-subbar">
                <div class="search-bar">
                    ${svg('search', 14)}
                    <input type="search" data-chat-floor-search placeholder="搜索关键词（Enter 跳转并高亮）…" value="${esc(st.filter.search)}">
                    <span class="search-count ${hits.length ? 'has-hits' : ''}" data-chat-hit-count>${
                        hasSearch ? (hits.length ? `${st.hitCursor + 1}/${hits.length}` : '0/0') : `${floors.length}楼`
                    }</span>
                    ${iconBtn('prev', '上一处命中 (Shift+Enter)', 'data-chat-search-nav="prev"', 'sm')}
                    ${iconBtn('next', '下一处命中 (Enter)', 'data-chat-search-nav="next"', 'sm')}
                    ${iconBtn(
                        st.searchMode === 'filter' ? 'filter' : 'locate',
                        st.searchMode === 'filter' ? '当前：筛选模式（点此切为定位跳转）' : '当前：定位跳转模式（点此切为筛选）',
                        'data-chat-search-mode',
                        st.searchMode === 'filter' ? 'sm active' : 'sm',
                    )}
                </div>
            </div>
            <div class="panel-scroll" data-chat-mid-scroll>
                <section class="chat-filter-card">
                    <div class="chat-filter-head">
                        <strong>${svg('tag', 13)} 标签筛选（选择与排除同时生效）</strong>
                        ${
                            st.filter.includeTags.length || st.filter.excludeTags.length
                                ? '<button type="button" class="mini-btn" data-chat-mid="clear-tags">清空标签</button>'
                                : ''
                        }
                    </div>
                    <div class="chat-tag-inputs">
                        <label class="chat-tag-field">
                            <span class="chat-tag-label is-include">选择标签（仅提取）</span>
                            <input type="text" data-tag-input="include" placeholder="如 content, opening（逗号分隔）" value="${esc(st.filter.includeTags.join(', '))}">
                        </label>
                        <label class="chat-tag-field">
                            <span class="chat-tag-label is-exclude">排除标签（彻底剔除）</span>
                            <input type="text" data-tag-input="exclude" placeholder="如 thinking, status_bar, image" value="${esc(st.filter.excludeTags.join(', '))}">
                        </label>
                    </div>
                    <div class="chat-detected-wrap">
                        <div class="muted" style="font-size:calc(11px * var(--pww-scale));margin-bottom:4px">探测到的标签（点击切换：不限 → ✓选择 → ✕排除）：</div>
                        <div class="chat-tag-pool">${detectedHtml}</div>
                    </div>
                    <div class="chat-filter-checks">
                        <label class="check"><input type="checkbox" data-chat-opt="stripOuterTags" ${st.filter.stripOuterTags ? 'checked' : ''}>去外层标签壳</label>
                        <label class="check"><input type="checkbox" data-chat-opt="keepUserMessages" ${st.filter.keepUserMessages ? 'checked' : ''}>保留用户楼层</label>
                        <label class="check"><input type="checkbox" data-chat-opt="hideEmpty" ${st.filter.hideEmpty ? 'checked' : ''}>隐藏空楼层</label>
                    </div>
                </section>

                <div class="chat-dir-head">
                    <span>楼层目录（点击定位到右侧编辑）</span>
                    <span class="muted">所属角色：${esc(c.charName)}</span>
                </div>
                <div class="entry-list">
                    ${
                        slice
                            .map((f) => {
                                const snippet = f.text.replace(/\s+/g, ' ').slice(0, 70);
                                const roleCls = f.isUser ? 'role-user' : f.isSystem ? '' : 'role-assistant';
                                const isFocus = st.focusFloorIndex === f.floorIndex || focusedHitFloor === f.floorIndex;
                                const nameHtml = hasSearch ? highlightHtml(f.name, st.filter.search) : esc(f.name);
                                const snipHtml = hasSearch && snippet ? highlightHtml(snippet, st.filter.search) : esc(snippet || '（空内容）');
                                return `
                                    <article class="prompt-card chat-dir-card ${isFocus ? 'is-active is-search-focus' : ''}" data-jump-floor="${f.floorIndex}">
                                        <span class="role-bar ${roleCls}"></span>
                                        <div class="card-main">
                                            <div class="card-title-row">
                                                <span class="badge">#${f.floorNo}</span>
                                                <span class="card-title">${nameHtml}</span>
                                                ${f.isEdited ? '<span class="badge badge-dirty">已改</span>' : ''}
                                                <span class="badge">${f.text.length} 字</span>
                                            </div>
                                            <div class="card-sub-row">
                                                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${snipHtml}</span>
                                            </div>
                                        </div>
                                    </article>`;
                            })
                            .join('') || '<p class="muted" style="padding:14px;text-align:center">当前筛选条件下没有楼层</p>'
                    }
                </div>
                ${
                    hasMore
                        ? `<div class="list-window-more">
                               <span class="muted">已显示 ${slice.length} / ${floors.length} 楼</span>
                               <div class="row" style="gap:6px">
                                   <button type="button" data-dir-more>继续加载 80 楼</button>
                                   <button type="button" data-dir-all>显示全部</button>
                               </div>
                           </div>`
                        : ''
                }
            </div>
        `;

        // 顶部与快捷操作
        const midActions = {
            save: () => saveActiveChat(),
            rename: () => renameActiveChat(),
            import: () => importChatDialog(),
            'export-txt': () => exportChatDialog('txt'),
            'export-jsonl': () => exportChatDialog('jsonl'),
            delete: () => deleteChats([{ avatar: c.avatar, fileName: c.fileName, charName: c.charName }]),
            more: (btn) =>
                hostApi.showMenu?.(btn, [
                    { icon: 'import', label: '导入聊天记录', action: () => importChatDialog() },
                    { icon: 'fileText', label: '导出 TXT 纯文本版', action: () => exportChatDialog('txt') },
                    { icon: 'export', label: '导出聊天记录版 (.jsonl)', action: () => exportChatDialog('jsonl') },
                    '-',
                    {
                        icon: 'trash',
                        label: '删除此聊天记录',
                        danger: true,
                        action: () => deleteChats([{ avatar: c.avatar, fileName: c.fileName, charName: c.charName }]),
                    },
                ]),
            'clear-tags': () => {
                st.filter.includeTags = [];
                st.filter.excludeTags = [];
                st.page = 1;
                hostApi.renderChatPanels();
            },
        };
        for (const b of $$('[data-chat-mid]', col)) {
            b.onclick = run(() => midActions[b.dataset.chatMid]?.(b));
        }

        // 点击探测标签胶囊：不限 → 选择 → 排除 → 不限
        for (const chip of $$('[data-tag-cycle]', col)) {
            chip.onclick = () => {
                const tag = chip.dataset.tagCycle;
                const low = tag.toLowerCase();
                const inInc = st.filter.includeTags.some((x) => x.toLowerCase() === low);
                const inExc = st.filter.excludeTags.some((x) => x.toLowerCase() === low);
                if (!inInc && !inExc) {
                    st.filter.includeTags.push(tag);
                } else if (inInc) {
                    st.filter.includeTags = st.filter.includeTags.filter((x) => x.toLowerCase() !== low);
                    st.filter.excludeTags.push(tag);
                } else {
                    st.filter.excludeTags = st.filter.excludeTags.filter((x) => x.toLowerCase() !== low);
                }
                st.page = 1;
                hostApi.renderChatPanels();
            };
        }

        // 手动输入选择 / 排除标签
        for (const inp of $$('[data-tag-input]', col)) {
            const commitTags = () => {
                const parsed = normalizeTagList(inp.value);
                if (inp.dataset.tagInput === 'include') {
                    st.filter.includeTags = parsed;
                    const incLow = new Set(parsed.map((x) => x.toLowerCase()));
                    st.filter.excludeTags = st.filter.excludeTags.filter((x) => !incLow.has(x.toLowerCase()));
                } else {
                    st.filter.excludeTags = parsed;
                    const excLow = new Set(parsed.map((x) => x.toLowerCase()));
                    st.filter.includeTags = st.filter.includeTags.filter((x) => !excLow.has(x.toLowerCase()));
                }
                st.page = 1;
                hostApi.renderChatPanels();
            };
            inp.addEventListener('change', commitTags);
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTags();
                }
            });
        }

        // 筛选开关
        for (const chk of $$('[data-chat-opt]', col)) {
            chk.onchange = () => {
                st.filter[chk.dataset.chatOpt] = chk.checked;
                st.page = 1;
                hostApi.renderChatPanels();
            };
        }

        const jumpToHit = (delta) => {
            const curFloors = currentEffectiveFloors();
            const curHits = collectFloorHits(curFloors, st.filter.search);
            if (!curHits.length) {
                notify('没有找到包含该关键词的楼层');
                return;
            }
            st.hitCursor = (st.hitCursor + delta + curHits.length) % curHits.length;
            const hitFloor = curHits[st.hitCursor];
            const pos = curFloors.findIndex((f) => f.floorIndex === hitFloor.floorIndex);
            if (pos >= 0) st.page = Math.floor(pos / st.pageSize) + 1;
            st.focusFloorIndex = hitFloor.floorIndex;
            if (pos >= st.dirLimit) st.dirLimit = pos + 30;
            hostApi.onFocusFloor?.();
            hostApi.renderChatPanels();
            const rightCard = $(`#pww-col-c [data-floor-card="${hitFloor.floorIndex}"]`);
            rightCard?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            const dirCard = $(`#pww-col-b [data-jump-floor="${hitFloor.floorIndex}"]`);
            dirCard?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            // 自动选中右栏文本框内的关键词位置
            const ta = rightCard ? $('[data-floor-editor]', rightCard) : null;
            const needle = normalizeQuery(st.filter.search);
            if (ta && needle) {
                const idx = ta.value.toLocaleLowerCase().indexOf(needle);
                if (idx >= 0) {
                    ta.focus();
                    ta.setSelectionRange(idx, idx + needle.length);
                }
            }
        };

        // 搜索框（不丢焦点：只刷新目录列表与右栏）
        const sInp = $('[data-chat-floor-search]', col);
        if (sInp) {
            let comp = false;
            const onS = () => {
                st.filter.search = sInp.value;
                st.hitCursor = 0;
                st.page = 1;
                const curFloors = currentEffectiveFloors();
                const curHits = collectFloorHits(curFloors, st.filter.search);
                if (curHits.length) {
                    const pos = curFloors.findIndex((f) => f.floorIndex === curHits[0].floorIndex);
                    if (pos >= 0) st.page = Math.floor(pos / st.pageSize) + 1;
                    st.focusFloorIndex = curHits[0].floorIndex;
                } else {
                    st.focusFloorIndex = null;
                }
                hostApi.renderChatPanels();
                const nextInp = $('[data-chat-floor-search]', col);
                if (nextInp) {
                    nextInp.focus();
                    nextInp.setSelectionRange(nextInp.value.length, nextInp.value.length);
                }
            };
            sInp.addEventListener('compositionstart', () => (comp = true));
            sInp.addEventListener('compositionend', () => {
                comp = false;
                onS();
            });
            sInp.addEventListener('input', () => {
                if (!comp) onS();
            });
            sInp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    jumpToHit(e.shiftKey ? -1 : 1);
                }
            });
        }
        for (const b of $$('[data-chat-search-nav]', col)) {
            b.onclick = () => jumpToHit(b.dataset.chatSearchNav === 'prev' ? -1 : 1);
        }
        const modeBtn = $('[data-chat-search-mode]', col);
        if (modeBtn) {
            modeBtn.onclick = () => {
                st.searchMode = st.searchMode === 'filter' ? 'jump' : 'filter';
                st.page = 1;
                st.hitCursor = 0;
                hostApi.renderChatPanels();
            };
        }

        // 点击目录楼层：定位到右侧对应分页并跳转编辑区（手机端自动切到编辑页）
        for (const card of $$('[data-jump-floor]', col)) {
            card.onclick = () => {
                const floorIndex = Number(card.dataset.jumpFloor);
                const pos = floors.findIndex((f) => f.floorIndex === floorIndex);
                if (pos >= 0) {
                    st.page = Math.floor(pos / st.pageSize) + 1;
                    st.focusFloorIndex = floorIndex;
                    hostApi.onFocusFloor?.();
                    hostApi.renderChatPanels();
                    const rightEl = $(`#pww-col-c [data-floor-card="${floorIndex}"]`);
                    rightEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
            };
        }

        const moreBtn = $('[data-dir-more]', col);
        if (moreBtn) {
            moreBtn.onclick = () => {
                st.dirLimit += 80;
                renderMiddle(col);
            };
        }
        const allBtn = $('[data-dir-all]', col);
        if (allBtn) {
            allBtn.onclick = () => {
                st.dirLimit = floors.length;
                renderMiddle(col);
            };
        }
    }

    // === 右栏：筛选后实时预览 + 按楼层分页 + 手动编辑 ===
    function renderRight(col) {
        if (!st.active) {
            col.innerHTML = `
                <div class="panel-head"><div class="panel-head-title">${svg('sliders', 15)}<h2>楼层预览与编辑</h2></div></div>
                <div class="panel-scroll" style="display:flex">
                    <div class="inspector-empty">
                        ${svg('fileText', 34)}
                        <p>打开聊天记录后，右侧将按楼层分页显示经过「选择标签 + 排除标签」筛选后的实时结果，并支持直接手动编辑与导出。</p>
                    </div>
                </div>
            `;
            return;
        }

        const c = st.active;
        const floors = currentEffectiveFloors();
        const paged = paginateFloors(floors, st.page, st.pageSize);
        st.page = paged.page;
        const rangeLabel = paged.items.length
            ? `#${paged.items[0].floorNo} ~ #${paged.items.at(-1).floorNo} 楼`
            : '0 楼';

        col.innerHTML = `
            <div class="panel-head">
                <div class="panel-head-title">
                    ${svg('fileText', 15)}
                    <h2>筛选结果 · ${rangeLabel}</h2>
                    <span class="badge">共 ${paged.total} 楼</span>
                </div>
                <div class="panel-head-actions">
                    ${
                        c.manualEdits.size || c.deletedFloors.size
                            ? `<button type="button" class="mini-btn" data-chat-right="reset-all" title="放弃全部手动编辑与删除">重置全部</button>`
                            : ''
                    }
                    <button type="button" class="mini-btn primary" data-chat-right="save">${svg('save', 12)} 保存并应用</button>
                </div>
            </div>
            <div class="panel-subbar chat-pager-bar">
                <div class="row" style="gap:4px">
                    <button type="button" class="mini-btn" data-page-go="1" ${paged.page <= 1 ? 'disabled' : ''}>首页</button>
                    <button type="button" class="mini-btn" data-page-go="${paged.page - 1}" ${paged.page <= 1 ? 'disabled' : ''}>上一页</button>
                    <span class="chat-page-num">第 <strong>${paged.page}</strong> / ${paged.totalPages} 页</span>
                    <button type="button" class="mini-btn" data-page-go="${paged.page + 1}" ${paged.page >= paged.totalPages ? 'disabled' : ''}>下一页</button>
                    <button type="button" class="mini-btn" data-page-go="${paged.totalPages}" ${paged.page >= paged.totalPages ? 'disabled' : ''}>末页</button>
                </div>
                <div class="row" style="gap:4px">
                    <input type="number" min="1" max="${c.messages.length}" class="chat-jump-input" data-jump-floor-no placeholder="跳楼层" title="输入楼层号后回车跳转">
                    <select data-page-size title="每页显示楼层数" style="padding:2px 5px;font-size:calc(11.5px * var(--pww-scale))">
                        ${[10, 20, 50]
                            .map((n) => `<option value="${n}" ${st.pageSize === n ? 'selected' : ''}>${n}楼/页</option>`)
                            .join('')}
                    </select>
                </div>
            </div>
            <div class="panel-scroll" data-chat-right-scroll>
                <div class="chat-floor-list">
                    ${
                        paged.items
                            .map((f) => {
                                const rows = Math.min(14, Math.max(3, Math.ceil((f.text.length || 40) / 48)));
                                const q = normalizeQuery(st.filter.search);
                                const isHit = Boolean(q && findSearchRanges(f.text, q).length);
                                const hitPreview = isHit
                                    ? `<div class="search-preview-box" style="max-height:110px">${highlightHtml(f.text, st.filter.search, st.focusFloorIndex === f.floorIndex ? 0 : -1)}</div>`
                                    : '';
                                return `
                                    <section class="chat-floor-card ${st.focusFloorIndex === f.floorIndex ? 'is-focused' : ''} ${f.isEdited ? 'is-edited' : ''}" data-floor-card="${f.floorIndex}">
                                        <header class="chat-floor-head">
                                            <div class="row" style="gap:6px">
                                                <span class="badge ${f.isUser ? 'badge-user' : 'badge-char'}">#${f.floorNo} · ${esc(f.name)}</span>
                                                ${f.sendDate ? `<span class="muted" style="font-size:calc(11px * var(--pww-scale))">${esc(f.sendDate)}</span>` : ''}
                                                ${f.isEdited ? '<span class="badge badge-dirty" data-floor-flag>已手动编辑</span>' : f.changedByFilter ? '<span class="badge badge-live" data-floor-flag>已按标签筛选</span>' : '<span class="badge" data-floor-flag>原文</span>'}
                                            </div>
                                            <div class="row" style="gap:3px">
                                                <span class="muted" style="font-size:calc(11px * var(--pww-scale))" data-floor-chars="${f.floorIndex}">${f.text.length} 字</span>
                                                ${
                                                    f.isEdited
                                                        ? `<button type="button" class="mini-btn" data-floor-act="restore-filtered" data-floor-idx="${f.floorIndex}" title="还原为当前标签筛选后的原文（保持标签筛选）">还原原文</button>`
                                                        : ''
                                                }
                                                ${iconBtn('trash', '标记删除本楼（保存后生效）', `data-floor-act="del-floor" data-floor-idx="${f.floorIndex}"`, 'sm danger')}
                                            </div>
                                        </header>
                                        ${hitPreview}
                                        <textarea class="chat-floor-editor" rows="${rows}" data-floor-editor="${f.floorIndex}" spellcheck="false">${esc(f.text)}</textarea>
                                    </section>`;
                            })
                            .join('') || '<p class="muted" style="padding:20px;text-align:center">当前页没有可显示的楼层（请检查标签筛选或搜索条件）</p>'
                    }
                </div>
            </div>
        `;

        // 分页按钮
        for (const b of $$('[data-page-go]', col)) {
            b.onclick = () => {
                st.page = Number(b.dataset.pageGo);
                st.focusFloorIndex = null;
                renderRight(col);
                $('[data-chat-right-scroll]', col)?.scrollTo(0, 0);
            };
        }
        const psSel = $('[data-page-size]', col);
        if (psSel) {
            psSel.onchange = () => {
                st.pageSize = Number(psSel.value) || 20;
                st.page = 1;
                renderRight(col);
            };
        }
        const jumpInp = $('[data-jump-floor-no]', col);
        if (jumpInp) {
            jumpInp.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const targetNo = Number(jumpInp.value);
                if (!targetNo || targetNo < 1) return;
                const pos = floors.findIndex((f) => f.floorNo >= targetNo);
                if (pos < 0) {
                    notify(`未找到第 #${targetNo} 楼（可能已被筛选隐藏）`, true);
                    return;
                }
                st.page = Math.floor(pos / st.pageSize) + 1;
                st.focusFloorIndex = floors[pos].floorIndex;
                renderRight(col);
                $(`[data-floor-card="${st.focusFloorIndex}"]`, col)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            });
        }

        // 右栏顶部保存/重置
        for (const b of $$('[data-chat-right]', col)) {
            b.onclick = run(async () => {
                const act = b.dataset.chatRight;
                if (act === 'save') await saveActiveChat();
                else if (act === 'reset-all') {
                    c.manualEdits.clear();
                    c.deletedFloors.clear();
                    pushHistory('重置全部编辑');
                    hostApi.renderChatPanels();
                    notify('已重置全部手动编辑');
                }
            });
        }

        // 实时手动编辑楼层内容（原地更新，绝不销毁文本框丢焦点，同时同步更新撤销栈与顶栏撤销按钮）
        for (const ta of $$('[data-floor-editor]', col)) {
            ta.addEventListener('input', () => {
                const idx = Number(ta.dataset.floorEditor);
                c.manualEdits.set(idx, ta.value);
                pushHistory(`编辑 #${idx + 1} 楼`, `floor:${idx}`);
                const card = ta.closest('.chat-floor-card');
                card?.classList.add('is-edited');
                const flag = card ? $('[data-floor-flag]', card) : null;
                if (flag) {
                    flag.className = 'badge badge-dirty';
                    flag.textContent = '已手动编辑';
                }
                const charEl = $(`[data-floor-chars="${idx}"]`, col);
                if (charEl) charEl.textContent = `${ta.value.length} 字`;
                // 同步刷新中栏标题未保存徽标
                const midBadge = $('#pww-col-b .panel-head-title .badge');
                if (midBadge) {
                    const totalMod = c.manualEdits.size + c.deletedFloors.size;
                    midBadge.className = 'badge badge-dirty';
                    midBadge.innerHTML = `<span class="lamp-dot is-dirty"></span>已改 ${totalMod} 楼`;
                }
            });
        }

        // 每楼快捷按钮（还原原文[保持标签筛选] / 删除本楼）
        for (const b of $$('[data-floor-act]', col)) {
            b.onclick = () => {
                const idx = Number(b.dataset.floorIdx);
                const act = b.dataset.floorAct;
                if (act === 'restore-filtered') {
                    c.manualEdits.delete(idx);
                    pushHistory(`还原 #${idx + 1} 楼筛选原文`);
                } else if (act === 'del-floor') {
                    c.deletedFloors.add(idx);
                    c.manualEdits.delete(idx);
                    pushHistory(`删除 #${idx + 1} 楼`);
                }
                hostApi.renderChatPanels();
            };
        }
    }

    return {
        state: st,
        canUndo,
        canRedo,
        undo: () => applyUndoRedo(-1),
        redo: () => applyUndoRedo(1),
        ensureCatalog,
        openForCharacter,
        openChatItem,
        importChatDialog,
        saveActiveChat,
        renderNav,
        renderMiddle,
        renderRight,
    };
}
