// 右侧常驻详情编辑器（SPreset Inspector 风格）+ 双条目高亮对比视图（双栏对照 / 行内 Diff / 直编）
import {
    clone,
    entries,
    findEntry,
    setEnabled,
    canToggleEntry,
    canEditEntry,
    specialConfig,
    writeSpecialConfig,
    comparable,
    equal,
    makeToolCode,
} from './core.js';
import { isDatabaseKind, isPromptKind, assertSafePatch } from './database-model.js';
import { isCharacterKind, updateCharacterUnit, ensureCharacterShape } from './character-model.js';
import * as prompts from './prompt-model.js';
import { $, $$, esc, field, notify, values, run } from './ui.js';
import { iconBtn, svg } from './icons.js';
import { highlightHtml, renderInlineDiffHtml, renderSideBySideDiffHtml } from './diff-search.js';
import { rpc } from './bridge.js';
import { renderAI } from './ai-panel.js';

const WORLD_POSITIONS = [
    [0, '角色定义前'],
    [1, '角色定义后'],
    [2, '作者注释前'],
    [3, '作者注释后'],
    [4, '按深度注入 (@D)'],
    [5, '对话示例前 (↑EM)'],
    [6, '对话示例后 (↓EM)'],
    [7, '出口 (Outlet)'],
];

const WB_STRATEGY_META = {
    constant: { icon: 'wbConstant', cls: 'is-wb-constant', label: '常驻 (绿灯)' },
    selective: { icon: 'wbSelective', cls: 'is-wb-selective', label: '关键词触发 (蓝灯)' },
    vectorized: { icon: 'wbVector', cls: 'is-wb-vector', label: '向量检索 (链接)' },
};

const DIFF_STATUS_LABEL = {
    same: ['相同', ''],
    content: ['正文不同', 'badge-diff-content'],
    settings: ['设置不同', 'badge-diff-settings'],
    added: ['仅右侧新增', 'badge-diff-added'],
    removed: ['仅左侧独有', 'badge-diff-removed'],
    manual: ['手动配对', 'badge-diff-settings'],
};

export function worldStrategyBtnHtml(strategy, extraAttr = '') {
    const m = WB_STRATEGY_META[strategy] || WB_STRATEGY_META.selective;
    return `<button type="button" class="wb-lamp-btn ${m.cls}" ${extraAttr} title="${esc(m.label)}（点击切换）" aria-label="${esc(m.label)}">${svg(m.icon, 14)}</button>`;
}

export function nextWorldStrategy(strategy) {
    return strategy === 'constant' ? 'selective' : strategy === 'selective' ? 'vectorized' : 'constant';
}

export function applyWorldStrategy(raw, strategy) {
    raw.constant = strategy === 'constant';
    raw.vectorized = strategy === 'vectorized';
    raw.selective = strategy === 'selective';
}

function hasMetaForm(kind) {
    return kind === 'preset' || kind === 'worldbook' || kind === 'character' || kind === 'plot' || kind === 'tableTemplate';
}

function fieldDiffSummary(leftEntry, rightEntry) {
    if (!leftEntry || !rightEntry) return '';
    const a = comparable(leftEntry),
        b = comparable(rightEntry);
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'content');
    const diffs = [];
    for (const k of keys) {
        if (!equal(a[k], b[k])) {
            diffs.push({
                key: k,
                left: JSON.stringify(a[k] ?? null),
                right: JSON.stringify(b[k] ?? null),
            });
        }
    }
    if (!diffs.length) return '';
    return `<div class="compare-field-diff"><h4>配置字段差异（${diffs.length} 项）</h4>${diffs
        .map(
            (d) =>
                `<div class="row" style="justify-content:space-between;font-size:11.5px;padding:2px 0;border-top:1px dashed var(--line)"><code>${esc(d.key)}</code><span><del class="pww-diff-del">${esc(d.left)}</del> → <ins class="pww-diff-ins">${esc(d.right)}</ins></span></div>`,
        )
        .join('')}</div>`;
}

export function renderCompareInspector(container, { leftDraft, rightDraft, pair, compareState, query, activeHit, actions }) {
    if (!leftDraft || !rightDraft) {
        container.innerHTML = `<div class="panel-head"><div class="panel-head-title">${svg('diffAll', 15)}<h2>差异对比</h2></div></div><div class="panel-subbar"><span class="muted">请先在左侧与中间选择两份文档</span></div><div class="inspector-body"><div class="inspector-empty">${svg('compare', 28)}<p>从顶部标签栏打开两份文档并在 A / B 栏选中，再分别点击条目即可查看双条目精准差异。</p></div></div>`;
        return;
    }

    const leftAll = entries(leftDraft);
    const rightAll = entries(rightDraft);
    const l = pair?.left || null;
    const r = pair?.right || null;

    const pickerBar = `
        <div class="compare-entry-pickers">
            <label class="cmp-pick-item">
                <span class="badge">A</span>
                <select data-cmp-entry="left">
                    <option value="">（未选 A 条目）</option>
                    ${leftAll.map((it) => `<option value="${esc(it.id)}" ${l?.id === it.id ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}
                </select>
            </label>
            <label class="cmp-pick-item">
                <span class="badge">B</span>
                <select data-cmp-entry="right">
                    <option value="">（未选 B 条目）</option>
                    ${rightAll.map((it) => `<option value="${esc(it.id)}" ${r?.id === it.id ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}
                </select>
            </label>
        </div>
    `;

    const bindPickers = () => {
        for (const sel of $$('[data-cmp-entry]', container)) {
            sel.onchange = () => actions.pickCompareEntry?.(sel.dataset.cmpEntry, sel.value || null);
        }
        for (const b of $$('[data-cmp-merge]', container)) {
            b.onclick = run(() => actions.mergeCompare(b.dataset.cmpMerge, l, r));
        }
    };

    // 强制至少两个条目同时就位才能对比正文
    if (!l || !r) {
        const hasOne = Boolean(l || r);
        const [statusText, statusCls] = l ? DIFF_STATUS_LABEL.removed : r ? DIFF_STATUS_LABEL.added : ['等待选择', ''];
        container.innerHTML = `
            <div class="panel-head">
                <div class="panel-head-title">
                    ${svg('diffAll', 15)}
                    <h2>${hasOne ? esc(l?.name || r?.name) : '双条目对比'}</h2>
                    <span class="badge ${statusCls}">${statusText}</span>
                </div>
                <div class="panel-head-actions">
                    ${l && !r ? iconBtn('arrowRight', '复制此条目到右侧 (A → B)', 'data-cmp-merge="ltr-copy"', 'sm') : ''}
                    ${!l && r ? iconBtn('arrowLeft', '复制此条目到左侧 (B → A)', 'data-cmp-merge="rtl-copy"', 'sm') : ''}
                </div>
            </div>
            ${pickerBar}
            <div class="inspector-body">
                <div class="inspector-empty" style="max-width:340px">
                    ${svg('compare', 28)}
                    <p><strong>对比需要同时展示 A、B 两个条目</strong></p>
                    <p class="muted">${
                        !hasOne
                            ? '请在左侧 A 和中间 B 列表中分别点击要对比的条目，或直接使用上方下拉框选择。'
                            : l
                              ? `「${esc(l.name)}」在右侧 B 中未自动匹配到同名条目。请直接点击 B 栏任意条目（或使用上方 B 下拉框）与之对比，也可以直接将它复制到 B。`
                              : `「${esc(r.name)}」在左侧 A 中未自动匹配到同名条目。请直接点击 A 栏任意条目（或使用上方 A 下拉框）与之对比，也可以直接将它复制到 A。`
                    }</p>
                    ${
                        l
                            ? `<button type="button" class="primary" data-cmp-merge="ltr-copy">${svg('arrowRight', 14)} 复制 A 到右侧 B</button>`
                            : r
                              ? `<button type="button" class="primary" data-cmp-merge="rtl-copy">${svg('arrowLeft', 14)} 复制 B 到左侧 A</button>`
                              : ''
                    }
                </div>
            </div>
        `;
        bindPickers();
        return;
    }

    const status = pair?.status || (l.content !== r.content ? 'content' : equal(comparable(l), comparable(r)) ? 'same' : 'settings');
    const [statusText, statusCls] = DIFF_STATUS_LABEL[status] || ['对比中', ''];
    const mode = compareState.mode || 'sbs';
    const diffRes =
        mode === 'diff'
            ? renderInlineDiffHtml(l.content ?? '', r.content ?? '', query, activeHit)
            : renderSideBySideDiffHtml(l.content ?? '', r.content ?? '', query, activeHit);
    const settingsHtml = fieldDiffSummary(l, r);

    container.innerHTML = `
        <div class="panel-head">
            <div class="panel-head-title">
                ${svg('diffAll', 15)}
                <h2 title="${esc(l.name + ' ↔ ' + r.name)}">${esc(l.name === r.name ? l.name : `${l.name} ↔ ${r.name}`)}</h2>
                <span class="badge ${statusCls}">${statusText}</span>
            </div>
            <div class="panel-head-actions">
                ${iconBtn('compare', '双栏并排对照 (左 A | 右 B)', 'data-cmp-mode="sbs"', mode === 'sbs' ? 'active sm' : 'sm')}
                ${iconBtn('diffAll', '行内合并差异', 'data-cmp-mode="diff"', mode === 'diff' ? 'active sm' : 'sm')}
                ${iconBtn('sliders', '双栏直接编辑', 'data-cmp-mode="edit"', mode === 'edit' ? 'active sm' : 'sm')}
                ${iconBtn('arrowRight', '用左侧正文覆盖右侧 (A → B)', 'data-cmp-merge="ltr-content"', 'sm')}
                ${iconBtn('arrowLeft', '用右侧正文覆盖左侧 (B → A)', 'data-cmp-merge="rtl-content"', 'sm')}
            </div>
        </div>
        ${pickerBar}
        <div class="inspector-body">
            ${
                mode === 'edit'
                    ? `<div class="comparison-editors">
                           <div class="field">
                               <label><span>A · ${esc(l.name)}</span>${l.marker ? '<span class="badge">占位只读</span>' : ''}</label>
                               <textarea data-cmp-edit="left" rows="16" ${l.marker ? 'readonly' : ''}>${esc(l.content ?? '')}</textarea>
                           </div>
                           <div class="field">
                               <label><span>B · ${esc(r.name)}</span>${r.marker ? '<span class="badge">占位只读</span>' : ''}</label>
                               <textarea data-cmp-edit="right" rows="16" ${r.marker ? 'readonly' : ''}>${esc(r.content ?? '')}</textarea>
                           </div>
                       </div>
                       <div class="form-actions full">
                           <button type="button" class="primary" data-cmp-save-edit>${svg('apply', 14)} 应用两侧修改到草稿</button>
                       </div>`
                    : `${settingsHtml}
                       <div class="row" style="justify-content:space-between;font-size:11.5px">
                           <span class="muted">左侧 A（删掉项红底划掉） ↔ 右侧 B（新增项绿底高亮）</span>
                           <span class="badge">${diffRes.changedCount} 处行变动</span>
                       </div>
                       ${
                           mode === 'sbs'
                               ? `<div class="pww-sbs-box" data-diff-box>
                                      <div class="pww-sbs-head">
                                          <span title="${esc(leftDraft.name + ' · ' + l.name)}">A · ${esc(l.name)}</span>
                                          <span title="${esc(rightDraft.name + ' · ' + r.name)}">B · ${esc(r.name)}</span>
                                      </div>
                                      ${diffRes.html}
                                  </div>`
                               : `<div class="pww-diff-box" data-diff-box>${diffRes.html}</div>`
                       }
                       <div class="form-actions full">
                           <button type="button" data-cmp-merge="ltr-all">${svg('arrowRight', 13)} 整条 A → B</button>
                           <button type="button" data-cmp-merge="rtl-all">${svg('arrowLeft', 13)} 整条 B → A</button>
                       </div>`
            }
        </div>
    `;

    bindPickers();
    for (const b of $$('[data-cmp-mode]', container)) {
        b.onclick = () => actions.setCompareMode(b.dataset.cmpMode);
    }
    const saveEditBtn = $('[data-cmp-save-edit]', container);
    if (saveEditBtn) {
        saveEditBtn.onclick = run(() => {
            const leftVal = $('[data-cmp-edit="left"]', container)?.value;
            const rightVal = $('[data-cmp-edit="right"]', container)?.value;
            actions.saveCompareInline(l, r, leftVal, rightVal);
        });
    }
    const curHit = $('.pww-hit.is-current', container);
    if (curHit) curHit.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function renderInspector(container, { draft, entryId, tab, query, activeHit, env, actions }) {
    if (tab === 'ai') {
        const showMeta = draft ? hasMetaForm(draft.kind) : false;
        container.innerHTML = `
            <div class="panel-head">
                <div class="panel-head-title">
                    ${svg('ai', 15)}
                    <h2>AI 编辑助手</h2>
                    <span class="badge">审阅后采纳</span>
                </div>
                <div class="panel-head-actions">
                    ${draft ? iconBtn('sliders', '编辑 AI 提示词模板', 'data-ai-head="templates"', 'sm') : ''}
                    ${iconBtn('close', '返回条目编辑器', 'data-insp-tab="content"', 'sm')}
                </div>
            </div>
            <div class="inspector-tabs">
                <button type="button" class="insp-tab" data-insp-tab="content">正文</button>
                ${showMeta ? '<button type="button" class="insp-tab" data-insp-tab="meta">参数</button>' : ''}
                <button type="button" class="insp-tab active" data-insp-tab="ai">AI 助手</button>
            </div>
            <aside id="ai-panel" class="ai-panel"></aside>
        `;
        for (const b of $$('[data-insp-tab]', container)) b.onclick = () => actions.setInspectorTab(b.dataset.inspTab);
        renderAI(env);
        const tplBtn = $('[data-ai-head="templates"]', container);
        if (tplBtn) {
            tplBtn.onclick = () => $('[data-ai="templates"]', container)?.click();
        }
        return;
    }

    if (!draft) {
        container.innerHTML = `
            <div class="panel-head"><div class="panel-head-title">${svg('sliders', 15)}<h2>检查器</h2></div></div>
            <div class="panel-subbar"><span class="muted">未打开文档</span></div>
            <div class="inspector-body"><div class="inspector-empty">${svg('preset', 28)}<p>点击顶部 <strong>+</strong> 打开预设、世界书或数据库文档。</p></div></div>
        `;
        return;
    }

    const e = entryId ? findEntry(draft, entryId) : null;
    if (!e) {
        container.innerHTML = `
            <div class="panel-head">
                <div class="panel-head-title">${svg('sliders', 15)}<h2>${esc(draft.name)}</h2></div>
                <div class="panel-head-actions">
                    ${iconBtn('json', '查看整份文档配置/JSON', 'data-act="doc-meta"', 'sm')}
                </div>
            </div>
            <div class="panel-subbar"><span class="muted">共 ${entries(draft).length} 个条目</span></div>
            <div class="inspector-body"><div class="inspector-empty">${svg('chain', 26)}<p>点击中间列表任意条目，直接在此实时编辑正文、注入参数与原始字段。</p></div></div>
        `;
        for (const b of $$('[data-insp-tab]', container)) b.onclick = () => actions.setInspectorTab(b.dataset.inspTab);
        for (const b of $$('[data-act]', container)) b.onclick = run(() => actions.runDocAction(b.dataset.act));
        return;
    }

    const isPreset = draft.kind === 'preset';
    const isWorld = draft.kind === 'worldbook';
    const isChar = isCharacterKind(draft.kind);
    const isDb = isDatabaseKind(draft.kind);
    const showMeta = hasMetaForm(draft.kind);
    let activeTab = tab || 'content';
    if (!isPreset && activeTab === 'special') activeTab = 'content';
    if (!showMeta && activeTab === 'meta') activeTab = 'content';
    const roleCls = e.role === 'user' || e.role === 'USER' ? 'badge-usr' : e.role === 'assistant' || e.role === 'ASSISTANT' ? 'badge-ast' : 'badge-sys';
    const canEdit = canEditEntry(e);
    const canToggle = isDb ? Boolean(e.toggleable) : isChar ? false : canToggleEntry(e);

    const headBadgeHtml = isWorld
        ? worldStrategyBtnHtml(e.strategy, 'data-wb-cycle-strategy')
        : isChar
          ? `<span class="badge">${esc(e.groupLabel || e.group || '角色卡')}</span>`
          : e.role
            ? `<span class="badge ${roleCls}">${esc(e.role)}</span>`
            : '';

    container.innerHTML = `
        <div class="panel-head">
            <div class="panel-head-title">
                ${isWorld ? headBadgeHtml : ''}
                <h2 title="${esc(e.name)}">${esc(e.name)}</h2>
                ${!isWorld ? headBadgeHtml : ''}
                ${e.marker ? '<span class="badge">占位</span>' : ''}
                ${e.nativeProtected && !isChar ? '<span class="badge">保留段</span>' : ''}
            </div>
        </div>
        <div class="inspector-tabs">
            <button type="button" class="insp-tab ${activeTab === 'content' ? 'active' : ''}" data-insp-tab="content">正文</button>
            ${
                showMeta
                    ? `<button type="button" class="insp-tab ${activeTab === 'meta' ? 'active' : ''}" data-insp-tab="meta">${isPreset ? '注入与条件' : isWorld ? '触发与策略' : isChar ? '卡片属性' : '属性配置'}</button>`
                    : ''
            }
            ${isPreset ? `<button type="button" class="insp-tab ${activeTab === 'special' ? 'active' : ''}" data-insp-tab="special">SPreset</button>` : ''}
            <button type="button" class="insp-tab ${activeTab === 'json' ? 'active' : ''}" data-insp-tab="json">JSON</button>
        </div>
        <div class="inspector-body" data-insp-body></div>
    `;

    for (const b of $$('[data-insp-tab]', container)) b.onclick = () => actions.setInspectorTab(b.dataset.inspTab);
    const wbCycleBtn = $('[data-wb-cycle-strategy]', container);
    if (wbCycleBtn && isWorld) {
        wbCycleBtn.onclick = run(() => {
            const next = nextWorldStrategy(e.strategy);
            actions.mutateEntry(e.id, '切换世界书触发灯', (item) => applyWorldStrategy(item.raw, next), true);
        });
    }

    const body = $('[data-insp-body]', container);

    if (activeTab === 'content') {
        renderContentTab(body, { draft, e, isPreset, isWorld, isChar, isDb, canEdit, canToggle, query, activeHit, actions });
    } else if (activeTab === 'meta' && showMeta) {
        renderMetaTab(body, { draft, e, isPreset, isWorld, isChar, isDb, actions });
    } else if (activeTab === 'special' && isPreset) {
        renderSpecialTab(body, { draft, e, actions });
    } else if (activeTab === 'json') {
        renderJsonTab(body, { draft, e, isChar, isDb, actions });
    }
}

function renderContentTab(body, { draft, e, isPreset, isWorld, isChar, isDb, canEdit, canToggle, query, activeHit, actions }) {
    const showNameInput = isPreset || isWorld || draft.kind === 'plot' || draft.kind === 'tableTemplate';
    const roleVal = e.raw.role ?? (isWorld ? 0 : 'system');
    const isPrompt = isPromptKind(draft.kind);
    const hasSearch = Boolean(String(query || '').trim());
    const contentReadOnly = Boolean(e.marker || e.contentReadOnly || !canEdit);

    let mainArea = '';
    if (draft.kind === 'tableTemplate') {
        const headers = Array.isArray(e.raw.content?.[0]) ? e.raw.content[0].join(', ') : '';
        const dataRows = Array.isArray(e.raw.content) ? e.raw.content.slice(1) : [];
        const sd = e.raw.sourceData || {};
        const aliases = Array.isArray(sd.tableAliases) ? sd.tableAliases.join(', ') : sd.tableAliases || '';
        mainArea = `
            <div class="field"><label><span>表头列（逗号分隔）</span></label><input type="text" name="headers" value="${esc(headers)}"></div>
            <div class="field"><label><span>表别名 (tableAliases，逗号分隔)</span></label><input type="text" name="tableAliases" value="${esc(aliases)}"></div>
            <div class="field"><label><span>SQL 建表语句 (sourceData.ddl)</span></label><textarea name="ddl" rows="6" spellcheck="false" placeholder="CREATE TABLE ...">${esc(sd.ddl || '')}</textarea></div>
            <div class="field"><label><span>表说明 (note)</span></label><textarea name="note" rows="3">${esc(sd.note || '')}</textarea></div>
            <div class="field"><label><span>初始化规则 (initNode)</span></label><textarea name="initNode" rows="3">${esc(sd.initNode || '')}</textarea></div>
            <div class="field"><label><span>新增规则 (insertNode)</span></label><textarea name="insertNode" rows="3">${esc(sd.insertNode || '')}</textarea></div>
            <div class="field"><label><span>更新规则 (updateNode)</span></label><textarea name="updateNode" rows="3">${esc(sd.updateNode || '')}</textarea></div>
            <div class="field"><label><span>删除规则 (deleteNode)</span></label><textarea name="deleteNode" rows="2">${esc(sd.deleteNode || '')}</textarea></div>
            <details class="insp-fold">
                <summary>初始数据 / 种子行（当前 ${dataRows.length} 行）</summary>
                <div class="field" style="margin-top:6px">
                    <label><span>行数据 JSON（二维数组，每项对应一行）</span></label>
                    <textarea name="seedRowsJson" rows="5" spellcheck="false">${esc(JSON.stringify(dataRows, null, 2))}</textarea>
                    <div class="form-actions" style="margin-top:4px"><button type="button" data-save-seed-rows>${svg('apply', 13)} 写入行数据</button></div>
                </div>
            </details>
        `;
    } else if (draft.kind === 'plot') {
        const pg = Array.isArray(e.raw.promptGroup) ? e.raw.promptGroup : [];
        mainArea = `
            <div class="field"><label><span>任务说明</span></label><input type="text" name="description" value="${esc(e.raw.description || '')}"></div>
            <div class="field"><label><span>最终指令模板</span></label><textarea name="finalDirectiveTemplate" rows="3">${esc(e.raw.finalDirectiveTemplate || '')}</textarea></div>
            <div class="field"><label><span>提示词段（共 ${pg.length} 段）</span><button type="button" data-plot-add-seg>${svg('plus', 13)} 新增段</button></label></div>
            <div class="entry-list" data-plot-segs>
                ${pg
                    .map(
                        (seg, i) => `
                    <div class="db-segment" data-seg-idx="${i}">
                        <div class="row" style="justify-content:space-between">
                            <select data-seg-role="${i}">
                                ${['SYSTEM', 'USER', 'ASSISTANT']
                                    .map((r) => `<option value="${r}" ${String(seg.role).toUpperCase() === r ? 'selected' : ''}>${r}</option>`)
                                    .join('')}
                            </select>
                            <span class="muted">第 ${i + 1} 段${seg.mainSlot ? ' · 主槽位 ' + seg.mainSlot : ''}</span>
                            ${seg.deletable === false || seg.mainSlot ? '' : iconBtn('trash', '删除此段', `data-seg-del="${i}"`, 'sm danger')}
                        </div>
                        <textarea data-seg-content="${i}" rows="5">${esc(seg.content || '')}</textarea>
                    </div>`,
                    )
                    .join('')}
            </div>
        `;
    } else {
        mainArea = `
            ${
                hasSearch
                    ? `<div class="field"><label><span>搜索命中高亮定位</span><span class="muted">关键字：${esc(query)}</span></label><div class="search-preview-box">${highlightHtml(e.content, query, activeHit)}</div></div>`
                    : ''
            }
            <div class="content-editor-box">
                <div class="field" style="flex:1;display:flex;flex-direction:column">
                    <label>
                        <span>正文内容${contentReadOnly ? '（只读保护）' : ''}</span>
                        <span class="muted" data-char-count>${e.content.length.toLocaleString()} 字符</span>
                    </label>
                    <textarea name="content" ${contentReadOnly ? 'readonly' : ''} placeholder="输入提示词或设定正文…">${esc(isPrompt ? e.raw.content : e.content)}</textarea>
                </div>
                ${
                    isPrompt && e.raw.snapshotTemplate !== undefined
                        ? `<div class="field"><label><span>快照模板 (snapshotTemplate)</span></label><textarea name="snapshotTemplate" rows="6">${esc(e.raw.snapshotTemplate || '')}</textarea></div>`
                        : ''
                }
            </div>
        `;
    }

    body.innerHTML = `
        <div class="inspector-grid">
            ${
                showNameInput
                    ? `<div class="field full"><label><span>名称 / 标题</span>${
                          canToggle
                              ? `<label class="check"><input type="checkbox" name="enabled" ${e.enabled ? 'checked' : ''}>${draft.kind === 'tableTemplate' ? '世界书导出' : '启用'}</label>`
                              : ''
                      }</label><input type="text" name="name" value="${esc(e.name)}"></div>`
                    : canToggle
                      ? `<div class="field full"><label class="check"><input type="checkbox" name="enabled" ${e.enabled ? 'checked' : ''}>启用此消息段</label></div>`
                      : ''
            }
            ${
                isPreset || draft.kind === 'contentReplace' || isPrompt
                    ? `<div class="field"><label><span>角色 (role)</span></label><select name="role" ${e.nativeProtected && (e.raw.pinned || prompts.fixedSlot(e.raw)) ? 'disabled' : ''}>${(
                          isPreset ? ['system', 'user', 'assistant'] : ['SYSTEM', 'USER', 'ASSISTANT']
                      )
                          .map((r) => {
                              const val = isPrompt && e.raw.role === String(e.raw.role).toLowerCase() ? r.toLowerCase() : r;
                              return `<option value="${val}" ${String(roleVal).toLowerCase() === r.toLowerCase() ? 'selected' : ''}>${val}</option>`;
                          })
                          .join('')}</select></div>`
                    : ''
            }
            ${
                isWorld
                    ? `<div class="field full"><label><span>主关键词（逗号分隔）</span></label><input type="text" name="key" value="${esc((e.raw.key || []).join(', '))}"></div>`
                    : ''
            }
        </div>
        ${mainArea}
    `;

    const curHit = $('.pww-hit.is-current', body);
    if (curHit) curHit.scrollIntoView({ block: 'center', behavior: 'smooth' });

    let timer;
    const flush = () => {
        clearTimeout(timer);
        if (draft.kind === 'tableTemplate') {
            const headers = ($('[name="headers"]', body)?.value || '')
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean);
            const aliases = ($('[name="tableAliases"]', body)?.value || '')
                .split(/[,，\n]/)
                .map((s) => s.trim())
                .filter(Boolean);
            const nameVal = $('[name="name"]', body)?.value ?? e.name;
            const enVal = $('[name="enabled"]', body)?.checked ?? e.enabled;
            actions.mutateEntry(e.id, '编辑表格规则与 SQL', (item) => {
                item.raw.name = nameVal;
                item.raw.exportConfig ||= {};
                item.raw.exportConfig.enabled = enVal;
                if (headers.length) {
                    item.raw.content ||= [headers];
                    item.raw.content[0] = headers;
                    for (let r = 1; r < item.raw.content.length; r++) {
                        while (item.raw.content[r].length < headers.length) item.raw.content[r].push('');
                        item.raw.content[r].length = headers.length;
                    }
                }
                item.raw.sourceData ||= {};
                item.raw.sourceData.tableAliases = aliases;
                for (const k of ['ddl', 'note', 'initNode', 'insertNode', 'updateNode', 'deleteNode']) {
                    const el = $(`[name="${k}"]`, body);
                    if (el) item.raw.sourceData[k] = el.value;
                }
            });
            return;
        }
        if (draft.kind === 'plot') {
            const nameVal = $('[name="name"]', body)?.value ?? e.name;
            const enVal = $('[name="enabled"]', body)?.checked ?? e.enabled;
            const descVal = $('[name="description"]', body)?.value ?? '';
            const dirVal = $('[name="finalDirectiveTemplate"]', body)?.value ?? '';
            const segs = [...$$('[data-seg-idx]', body)].map((box, i) => ({
                ...clone(e.raw.promptGroup[i] || { deletable: true }),
                role: $(`[data-seg-role="${i}"]`, box)?.value || 'USER',
                content: $(`[data-seg-content="${i}"]`, box)?.value ?? '',
            }));
            actions.mutateEntry(e.id, '编辑剧情任务', (item) => {
                item.raw.name = nameVal;
                item.raw.enabled = enVal;
                item.raw.description = descVal;
                item.raw.finalDirectiveTemplate = dirVal;
                item.raw.promptGroup = segs;
            });
            return;
        }
        const nameEl = $('[name="name"]', body);
        const roleEl = $('[name="role"]', body);
        const enEl = $('[name="enabled"]', body);
        const contentEl = $('[name="content"]', body);
        const snapEl = $('[name="snapshotTemplate"]', body);
        const keyEl = $('[name="key"]', body);

        if (contentEl && $('[data-char-count]', body)) {
            $('[data-char-count]', body).textContent = contentEl.value.length.toLocaleString() + ' 字符';
        }

        actions.mutateEntry(e.id, '编辑条目', (item) => {
            if (isPreset) {
                if (nameEl) item.raw.name = nameEl.value;
                if (roleEl) item.raw.role = roleEl.value;
                if (contentEl && !contentReadOnly) item.raw.content = contentEl.value;
                if (enEl && canToggle) setEnabled(draft, e.id, enEl.checked);
            } else if (isWorld) {
                if (nameEl) item.raw.comment = nameEl.value;
                if (contentEl) item.raw.content = contentEl.value;
                if (enEl) item.raw.disable = !enEl.checked;
                if (keyEl) {
                    item.raw.key = keyEl.value
                        .split(/[,，\n]/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                }
            } else if (isPrompt) {
                const patch = {};
                if (roleEl && !roleEl.disabled) patch.role = roleEl.value;
                if (contentEl && !contentReadOnly) patch.content = contentEl.value;
                if (snapEl) patch.snapshotTemplate = snapEl.value;
                if (enEl && canToggle) patch.enabled = enEl.checked;
                prompts.update(draft, e.id, patch);
            } else if (draft.kind === 'contentReplace') {
                if (roleEl) item.raw.role = roleEl.value;
                if (contentEl) item.raw.content = contentEl.value;
            } else if (isChar) {
                if (contentEl) updateCharacterUnit(draft, e.id, contentEl.value);
            }
        });
    };

    const scheduleFlush = (ev) => {
        if (ev?.target?.name === 'seedRowsJson') return;
        clearTimeout(timer);
        timer = setTimeout(() => {
            try {
                flush();
            } catch (err) {
                notify(err.message, true);
            }
        }, 120);
    };

    body.addEventListener('input', scheduleFlush);
    body.addEventListener('change', (ev) => {
        if (ev?.target?.name === 'seedRowsJson') return;
        try {
            flush();
        } catch (err) {
            notify(err.message, true);
        }
    });

    if (draft.kind === 'tableTemplate') {
        const seedBtn = $('[data-save-seed-rows]', body);
        if (seedBtn) {
            seedBtn.onclick = run(() => {
                const txt = $('[name="seedRowsJson"]', body)?.value || '[]';
                const parsed = JSON.parse(txt);
                if (!Array.isArray(parsed) || parsed.some((r) => !Array.isArray(r)))
                    throw Error('种子行必须是二维数组 JSON，例如 [["值1","值2"]]');
                actions.mutateEntry(
                    e.id,
                    '编辑表格种子行数据',
                    (item) => {
                        const header = Array.isArray(item.raw.content?.[0]) ? item.raw.content[0] : [];
                        const normalized = parsed.map((row) => {
                            const copy = row.map((cell) => String(cell ?? ''));
                            if (header.length) {
                                while (copy.length < header.length) copy.push('');
                                copy.length = header.length;
                            }
                            return copy;
                        });
                        item.raw.content = [header, ...normalized];
                        if ('seedRows' in item.raw) item.raw.seedRows = clone(normalized);
                    },
                    true,
                );
                notify('初始行数据已写入草稿');
            });
        }
    }

    if (draft.kind === 'plot') {
        const addBtn = $('[data-plot-add-seg]', body);
        if (addBtn) {
            addBtn.onclick = () => {
                actions.mutateEntry(
                    e.id,
                    '新增任务提示词段',
                    (item) => {
                        item.raw.promptGroup ||= [];
                        item.raw.promptGroup.push({ role: 'USER', content: '', deletable: true });
                    },
                    true,
                );
            };
        }
        for (const delBtn of $$('[data-seg-del]', body)) {
            delBtn.onclick = () => {
                const idx = Number(delBtn.dataset.segDel);
                actions.mutateEntry(
                    e.id,
                    '删除任务提示词段',
                    (item) => {
                        item.raw.promptGroup.splice(idx, 1);
                    },
                    true,
                );
            };
        }
    }
}

function renderMetaTab(body, { draft, e, isPreset, isWorld, isChar, actions }) {
    if (isChar) {
        ensureCharacterShape(draft.raw);
        const data = draft.raw.data;
        const ext = data.extensions || {};
        const dp = ext.depth_prompt || { prompt: '', depth: 4, role: 'system' };
        const primaryWorld = ext.world || '';
        const auxWorlds = draft.charAuxWorlds || [];
        const tags = draft.charTags || [];
        body.innerHTML = `<form class="inspector-grid" data-meta-form>
            ${field('creator', '创作者 (creator)', data.creator || '', 'text')}
            ${field('character_version', '版本号 (version)', data.character_version || '', 'text')}
            ${field('talkativeness', '健谈度 (0~1)', ext.talkativeness ?? draft.raw.talkativeness ?? '0.5', 'number')}
            ${field('dp_depth', '深度提示词 Depth', dp.depth ?? 4, 'number')}
            ${field('dp_role', '深度提示词角色', dp.role || 'system', 'select', {
                choices: [['system', 'System'], ['user', 'User'], ['assistant', 'Assistant']],
            })}
            <div class="check-grid full">
                ${field('fav', '收藏此角色卡 (fav)', Boolean(ext.fav ?? draft.raw.fav), 'checkbox')}
            </div>
            <div class="settings-card full">
                <div class="settings-card-head">
                    <strong>${svg('worldbook', 13)} 绑定世界书</strong>
                    <div class="row" style="gap:4px">
                        <button type="button" class="mini-btn" data-char-act="bind-world">修改绑定</button>
                        <button type="button" class="mini-btn primary" data-char-act="jump-world" ${primaryWorld || auxWorlds.length ? '' : 'disabled'}>${svg('external', 12)} 跳转到世界书</button>
                    </div>
                </div>
                <div class="muted">主世界书：<strong>${esc(primaryWorld || '未绑定')}</strong></div>
                <div class="muted">附加世界书：${auxWorlds.length ? auxWorlds.map((w) => `<span class="badge">${esc(w)}</span>`).join(' ') : '无'}</div>
            </div>
            <div class="settings-card full">
                <div class="settings-card-head">
                    <strong>${svg('tag', 13)} 角色标签</strong>
                    <button type="button" class="mini-btn" data-char-act="edit-tags">修改标签</button>
                </div>
                <div class="filter-chips">${tags.length ? tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('') : '<span class="muted">暂无标签</span>'}</div>
            </div>
            <div class="settings-card full">
                <div class="settings-card-head">
                    <strong>${svg('image', 13)} 角色图片与更新</strong>
                    <div class="row" style="gap:4px">
                        <button type="button" class="mini-btn" data-char-act="edit-avatar">${svg('image', 12)} 修改图片</button>
                        <button type="button" class="mini-btn" data-char-act="update-card">${svg('upload', 12)} 更新角色卡</button>
                    </div>
                </div>
            </div>
            <div class="form-actions full"><button type="submit" class="primary">${svg('apply', 14)} 保存卡片属性到草稿</button></div>
        </form>`;
        for (const b of $$('[data-char-act]', body)) {
            b.onclick = run(() => actions.runDocAction(b.dataset.charAct));
        }
        $('[data-meta-form]', body).onsubmit = run((ev) => {
            ev.preventDefault();
            const v = values(ev.target);
            actions.mutateEntry(
                e.id,
                '修改角色卡属性',
                () => {
                    ensureCharacterShape(draft.raw);
                    draft.raw.data.creator = v.creator || '';
                    draft.raw.data.character_version = v.character_version || '';
                    draft.raw.data.extensions ||= {};
                    draft.raw.data.extensions.talkativeness = String(v.talkativeness ?? 0.5);
                    draft.raw.talkativeness = String(v.talkativeness ?? 0.5);
                    draft.raw.data.extensions.fav = Boolean(v.fav);
                    draft.raw.fav = Boolean(v.fav);
                    draft.raw.data.extensions.depth_prompt = {
                        prompt: draft.raw.data.extensions.depth_prompt?.prompt || '',
                        depth: Number(v.dp_depth ?? 4),
                        role: v.dp_role || 'system',
                    };
                },
                true,
            );
            notify('角色卡属性已更新到草稿');
        });
        return;
    }
    if (isPreset) {
        const cfg = specialConfig(draft.raw);
        const hidden = (cfg.HiddenPrompts || []).includes(e.id);
        const cond = cfg.ConditionalPrompts?.[e.id] || {};
        body.innerHTML = `<form class="inspector-grid" data-meta-form>
            ${field('injection_position', '注入模式', String(e.raw.injection_position ?? 0), 'select', {
                choices: [
                    ['0', '顺序提示词区（相对位置）'],
                    ['1', '自动注入区（按深度插入）'],
                ],
            })}
            ${field('injection_depth', '注入深度 (Depth)', e.raw.injection_depth ?? 4, 'number')}
            ${field('injection_order', '注入顺序 (Order)', e.raw.injection_order ?? 100, 'number')}
            ${field('injection_trigger', '触发器（逗号分隔）', e.raw.injection_trigger || [], 'list')}
            <div class="check-grid full">
                ${field('forbid_overrides', '禁止角色卡覆盖', Boolean(e.raw.forbid_overrides), 'checkbox')}
                ${field('sp_hidden', '原生列表隐藏 (SPreset)', hidden, 'checkbox')}
                ${field('sp_cond_on', '条件启用 (SPreset)', Boolean(cond.enabled), 'checkbox')}
            </div>
            ${field('sp_cond_expr', '条件表达式 (JS 返回布尔值)', cond.condition || '', 'textarea', { rows: 3, wide: true })}
            <div class="form-actions full"><button type="submit" class="primary">${svg('apply', 14)} 保存参数到草稿</button></div>
        </form>`;
        $('[data-meta-form]', body).onsubmit = run((ev) => {
            ev.preventDefault();
            const v = values(ev.target);
            actions.mutateEntry(
                e.id,
                '修改预设注入参数',
                (item) => {
                    item.raw.injection_position = Number(v.injection_position || 0);
                    item.raw.injection_depth = Number(v.injection_depth ?? 4);
                    item.raw.injection_order = Number(v.injection_order ?? 100);
                    item.raw.injection_trigger = v.injection_trigger;
                    item.raw.forbid_overrides = Boolean(v.forbid_overrides);
                    const nextCfg = specialConfig(draft.raw);
                    const h = new Set(nextCfg.HiddenPrompts || []);
                    v.sp_hidden ? h.add(e.id) : h.delete(e.id);
                    if (h.size || nextCfg.HiddenPrompts) nextCfg.HiddenPrompts = [...h];
                    if (v.sp_cond_on || v.sp_cond_expr.trim()) {
                        nextCfg.ConditionalPrompts ||= {};
                        nextCfg.ConditionalPrompts[e.id] = {
                            enabled: Boolean(v.sp_cond_on),
                            condition: v.sp_cond_expr,
                        };
                    } else if (nextCfg.ConditionalPrompts) {
                        delete nextCfg.ConditionalPrompts[e.id];
                    }
                    if (Object.keys(nextCfg).length) writeSpecialConfig(draft.raw, nextCfg);
                },
                true,
            );
            notify('注入与条件参数已更新到草稿');
        });
        return;
    }

    if (isWorld) {
        const strategy = e.raw.constant ? 'constant' : e.raw.vectorized ? 'vectorized' : 'selective';
        const triVal = (v) => (v === true ? 'true' : v === false ? 'false' : '');
        const parseTri = (s) => (s === 'true' ? true : s === 'false' ? false : null);
        const delayRecVal =
            typeof e.raw.delayUntilRecursion === 'number'
                ? e.raw.delayUntilRecursion
                : e.raw.delayUntilRecursion
                  ? 1
                  : 0;
        body.innerHTML = `<form class="inspector-grid" data-meta-form>
            ${field('strategy', '触发策略', strategy, 'select', {
                choices: [
                    ['constant', '常驻 (绿灯)'],
                    ['selective', '关键词触发 (蓝灯)'],
                    ['vectorized', '向量检索 (链灯)'],
                ],
            })}
            ${field('position', '注入位置', String(e.raw.position ?? 0), 'select', {
                choices: WORLD_POSITIONS.map(([k, l]) => [String(k), l]),
            })}
            ${field('order', '插入顺序 (Order)', e.raw.order ?? 100, 'number')}
            ${field('depth', '注入深度 (Depth)', e.raw.depth ?? 4, 'number')}
            ${field('role', '注入角色', String(e.raw.role ?? 0), 'select', {
                choices: [
                    ['0', 'System'],
                    ['1', 'User'],
                    ['2', 'Assistant'],
                ],
            })}
            ${field('probability', '触发概率 (%)', e.raw.probability ?? 100, 'number')}
            ${field('keysecondary', '次要关键词', e.raw.keysecondary || [], 'list', { wide: true })}
            ${field('selectiveLogic', '次要关键词逻辑', String(e.raw.selectiveLogic ?? 0), 'select', {
                choices: [
                    ['0', 'AND ANY'],
                    ['1', 'NOT ALL'],
                    ['2', 'NOT ANY'],
                    ['3', 'AND ALL'],
                ],
            })}
            ${field('scanDepth', '扫描深度（空=全局）', e.raw.scanDepth ?? '', 'number')}
            ${field('sticky', '黏性 (Sticky)', e.raw.sticky ?? 0, 'number')}
            ${field('cooldown', '冷却 (Cooldown)', e.raw.cooldown ?? 0, 'number')}
            ${field('delay', '延迟 (Delay)', e.raw.delay ?? 0, 'number')}
            ${field('delayUntilRecursion', '递归延迟层数 (0=关)', delayRecVal, 'number')}
            <div class="check-grid full">
                ${field('useProbability', '启用概率', e.raw.useProbability !== false, 'checkbox')}
                ${field('excludeRecursion', '不可被递归触发', Boolean(e.raw.excludeRecursion), 'checkbox')}
                ${field('preventRecursion', '阻止进一步递归', Boolean(e.raw.preventRecursion), 'checkbox')}
                ${field('ignoreBudget', '忽略预算 (ignoreBudget)', Boolean(e.raw.ignoreBudget), 'checkbox')}
            </div>
            <details class="insp-fold full">
                <summary>分组互斥、匹配策略与自动化</summary>
                <div class="inspector-grid" style="margin-top:8px">
                    ${field('group', '互斥分组 (Group)', e.raw.group || '', 'text')}
                    ${field('groupWeight', '分组权重', e.raw.groupWeight ?? 100, 'number')}
                    ${field('useGroupScoring', '分组评分', triVal(e.raw.useGroupScoring), 'select', {
                        choices: [['', '跟随全局'], ['true', '启用'], ['false', '禁用']],
                    })}
                    ${field('automationId', '自动化 ID', e.raw.automationId || '', 'text')}
                    ${field('caseSensitive', '区分大小写', triVal(e.raw.caseSensitive), 'select', {
                        choices: [['', '跟随全局'], ['true', '启用'], ['false', '禁用']],
                    })}
                    ${field('matchWholeWords', '全词匹配', triVal(e.raw.matchWholeWords), 'select', {
                        choices: [['', '跟随全局'], ['true', '启用'], ['false', '禁用']],
                    })}
                    ${field('triggers', '限定触发源（normal, continue 等）', e.raw.triggers || [], 'list', { wide: true })}
                    <div class="check-grid full">
                        ${field('groupOverride', '分组优先覆盖', Boolean(e.raw.groupOverride), 'checkbox')}
                    </div>
                </div>
            </details>
            <details class="insp-fold full">
                <summary>扩展匹配源（人设 / 角色卡 / 场景 / 注释）</summary>
                <div class="check-grid" style="margin-top:8px">
                    ${field('matchPersonaDescription', '匹配用户人设', Boolean(e.raw.matchPersonaDescription), 'checkbox')}
                    ${field('matchCharacterDescription', '匹配角色描述', Boolean(e.raw.matchCharacterDescription), 'checkbox')}
                    ${field('matchCharacterPersonality', '匹配角色性格', Boolean(e.raw.matchCharacterPersonality), 'checkbox')}
                    ${field('matchCharacterDepthPrompt', '匹配深度提示词', Boolean(e.raw.matchCharacterDepthPrompt), 'checkbox')}
                    ${field('matchScenario', '匹配场景设定', Boolean(e.raw.matchScenario), 'checkbox')}
                    ${field('matchCreatorNotes', '匹配创作者注释', Boolean(e.raw.matchCreatorNotes), 'checkbox')}
                </div>
            </details>
            <div class="form-actions full"><button type="submit" class="primary">${svg('apply', 14)} 保存参数到草稿</button></div>
        </form>`;
        $('[data-meta-form]', body).onsubmit = run((ev) => {
            ev.preventDefault();
            const v = values(ev.target);
            actions.mutateEntry(
                e.id,
                '修改世界书参数',
                (item) => {
                    applyWorldStrategy(item.raw, v.strategy);
                    item.raw.position = Number(v.position ?? 0);
                    item.raw.order = Number(v.order ?? 100);
                    item.raw.depth = Number(v.depth ?? 4);
                    item.raw.role = Number(v.role ?? 0);
                    item.raw.probability = Number(v.probability ?? 100);
                    item.raw.keysecondary = v.keysecondary;
                    item.raw.selectiveLogic = Number(v.selectiveLogic ?? 0);
                    item.raw.group = v.group;
                    item.raw.groupOverride = Boolean(v.groupOverride);
                    item.raw.groupWeight = Number(v.groupWeight ?? 100);
                    item.raw.useGroupScoring = parseTri(v.useGroupScoring);
                    item.raw.automationId = v.automationId || '';
                    item.raw.triggers = v.triggers;
                    item.raw.sticky = Number(v.sticky ?? 0);
                    item.raw.cooldown = Number(v.cooldown ?? 0);
                    item.raw.delay = Number(v.delay ?? 0);
                    item.raw.scanDepth = v.scanDepth === null ? null : Number(v.scanDepth);
                    const dr = Number(v.delayUntilRecursion ?? 0);
                    item.raw.delayUntilRecursion = dr > 0 ? dr : false;
                    item.raw.useProbability = Boolean(v.useProbability);
                    item.raw.excludeRecursion = Boolean(v.excludeRecursion);
                    item.raw.preventRecursion = Boolean(v.preventRecursion);
                    item.raw.ignoreBudget = Boolean(v.ignoreBudget);
                    item.raw.caseSensitive = parseTri(v.caseSensitive);
                    item.raw.matchWholeWords = parseTri(v.matchWholeWords);
                    item.raw.matchPersonaDescription = Boolean(v.matchPersonaDescription);
                    item.raw.matchCharacterDescription = Boolean(v.matchCharacterDescription);
                    item.raw.matchCharacterPersonality = Boolean(v.matchCharacterPersonality);
                    item.raw.matchCharacterDepthPrompt = Boolean(v.matchCharacterDepthPrompt);
                    item.raw.matchScenario = Boolean(v.matchScenario);
                    item.raw.matchCreatorNotes = Boolean(v.matchCreatorNotes);
                },
                true,
            );
            notify('世界书参数已更新到草稿');
        });
        return;
    }

    if (draft.kind === 'plot') {
        const ac = e.raw.agentControl || {};
        body.innerHTML = `<form class="inspector-grid" data-meta-form>
            ${field('stage', '阶段 (Stage)', e.raw.stage ?? 1, 'number')}
            ${field('order', '顺序 (Order)', e.raw.order ?? 0, 'number')}
            ${field('minLength', '最小长度', e.raw.minLength ?? 0, 'number')}
            ${field('maxRetries', '最大重试', e.raw.maxRetries ?? 3, 'number')}
            ${field('mergeStrategy', '合并策略 (mergeStrategy)', e.raw.mergeStrategy || '', 'select', {
                choices: [
                    ['', '默认'],
                    ['append', '追加 (append)'],
                    ['replace', '覆盖 (replace)'],
                    ['prepend', '前置 (prepend)'],
                ],
            })}
            ${field('triggerWhen', '触发条件', e.raw.triggerWhen || '', 'text')}
            ${field('extractTags', '提取标签', e.raw.extractTags || '', 'text')}
            ${field('extractInjectTags', '注入标签', e.raw.extractInjectTags || '', 'text')}
            <details class="insp-fold full" open>
                <summary>Agent 调度控制 (agentControl)</summary>
                <div class="inspector-grid" style="margin-top:8px">
                    <div class="check-grid full">
                        ${field('ac_enabled', '启用 Agent 控制', Boolean(ac.enabled), 'checkbox')}
                        ${field('ac_selectable', '允许选择', ac.selectable !== false, 'checkbox')}
                        ${field('ac_defaultSelected', '默认选中', Boolean(ac.defaultSelected), 'checkbox')}
                        ${field('ac_allowSequential', '允许串行', ac.allowSequential !== false, 'checkbox')}
                        ${field('ac_allowParallel', '允许并行', ac.allowParallel !== false, 'checkbox')}
                    </div>
                    ${field('ac_dependsOn', '前置依赖任务 ID（逗号分隔）', ac.dependsOnTaskIds || [], 'list', { wide: true })}
                    ${field('ac_blocks', '互斥阻塞任务 ID（逗号分隔）', ac.blocksTaskIds || [], 'list', { wide: true })}
                </div>
            </details>
            <details class="insp-fold full">
                <summary>文档级全局最终系统指令 (finalSystemDirective)</summary>
                <div style="margin-top:8px">
                    ${field('doc_finalSystemDirective', '全局最终系统指令（作用于整份剧情推进预设）', draft.raw.finalSystemDirective || '', 'textarea', { rows: 4, wide: true })}
                </div>
            </details>
            <div class="form-actions full"><button type="submit" class="primary">${svg('apply', 14)} 保存参数</button></div>
        </form>`;
        $('[data-meta-form]', body).onsubmit = run((ev) => {
            ev.preventDefault();
            const v = values(ev.target);
            actions.mutateEntry(
                e.id,
                '修改剧情任务参数',
                (item) => {
                    item.raw.stage = Number(v.stage ?? 1);
                    item.raw.order = Number(v.order ?? 0);
                    item.raw.minLength = Number(v.minLength ?? 0);
                    item.raw.maxRetries = Number(v.maxRetries ?? 3);
                    item.raw.mergeStrategy = v.mergeStrategy || '';
                    item.raw.triggerWhen = v.triggerWhen || '';
                    item.raw.extractTags = v.extractTags || '';
                    item.raw.extractInjectTags = v.extractInjectTags || '';
                    item.raw.agentControl = {
                        ...(item.raw.agentControl || {}),
                        enabled: Boolean(v.ac_enabled),
                        selectable: Boolean(v.ac_selectable),
                        defaultSelected: Boolean(v.ac_defaultSelected),
                        allowSequential: Boolean(v.ac_allowSequential),
                        allowParallel: Boolean(v.ac_allowParallel),
                        dependsOnTaskIds: v.ac_dependsOn || [],
                        blocksTaskIds: v.ac_blocks || [],
                    };
                    if (v.doc_finalSystemDirective !== undefined) {
                        draft.raw.finalSystemDirective = v.doc_finalSystemDirective;
                    }
                },
                true,
            );
            notify('任务参数已更新到草稿');
        });
        return;
    }

    if (draft.kind === 'tableTemplate') {
        const ec = e.raw.exportConfig || {};
        const uc = e.raw.updateConfig || {};
        const globalInj = draft.raw.mate?.globalInjectionConfig || {};
        body.innerHTML = `<form class="inspector-grid" data-meta-form>
            ${field('entryName', '导出条目名', ec.entryName || '', 'text')}
            ${field('entryType', '条目类型', ec.entryType || 'constant', 'select', { choices: [['constant', '常驻'], ['keyword', '关键词']] })}
            ${field('keywords', '触发关键词', ec.keywords || '', 'text', { wide: true })}
            <div class="check-grid full">
                ${field('splitByRow', '按行拆分导出 (splitByRow)', Boolean(ec.splitByRow), 'checkbox')}
                ${field('preventRecursion', '阻止递归 (preventRecursion)', Boolean(ec.preventRecursion), 'checkbox')}
            </div>
            ${field('contextDepth', '上下文深度', uc.contextDepth ?? 8, 'number')}
            ${field('updateFrequency', '更新频率', uc.updateFrequency ?? 1, 'number')}
            ${field('batchSize', '批大小', uc.batchSize ?? 1, 'number')}
            ${field('skipFloors', '跳过楼层', uc.skipFloors ?? 0, 'number')}
            ${field('groupId', '更新分组 ID (groupId)', uc.groupId ?? '', 'number')}
            ${field('uiSentinel', 'UI 哨兵 (uiSentinel)', uc.uiSentinel ?? '', 'number')}
            ${field('injectionTemplate', '常规注入模板 (injectionTemplate)', ec.injectionTemplate || '', 'textarea', { rows: 4, wide: true })}
            ${field('sqlInjectionTemplate', 'SQL 注入模板 (sqlInjectionTemplate)', ec.sqlInjectionTemplate || '', 'textarea', { rows: 4, wide: true })}
            <details class="insp-fold full">
                <summary>额外索引条目配置 (Extra Index)</summary>
                <div class="inspector-grid" style="margin-top:8px">
                    <div class="check-grid full">
                        ${field('extraIndexEnabled', '启用额外索引条目', Boolean(ec.extraIndexEnabled), 'checkbox')}
                    </div>
                    ${field('extraIndexEntryName', '额外索引条目名', ec.extraIndexEntryName || '', 'text', { wide: true })}
                    ${field('extraIndexColumns', '索引列（逗号分隔）', ec.extraIndexColumns || [], 'list', { wide: true })}
                    ${field('extraIndexColumnModes', '列模式 JSON (extraIndexColumnModes)', ec.extraIndexColumnModes || {}, 'json', { rows: 3, wide: true })}
                    ${field('extraIndexInjectionTemplate', '索引注入模板', ec.extraIndexInjectionTemplate || '', 'textarea', { rows: 3, wide: true })}
                </div>
            </details>
            <details class="insp-fold full">
                <summary>世界书插入位置 (Placement 4 组)</summary>
                <div class="inspector-grid" style="margin-top:8px">
                    ${field('entryPlacement', '条目位置 (entryPlacement)', ec.entryPlacement || {}, 'json', { rows: 3 })}
                    ${field('extraIndexPlacement', '额外索引位置 (extraIndexPlacement)', ec.extraIndexPlacement || {}, 'json', { rows: 3 })}
                    ${field('fixedEntryPlacement', '固定条目位置 (fixedEntryPlacement)', ec.fixedEntryPlacement || {}, 'json', { rows: 3 })}
                    ${field('fixedIndexPlacement', '固定索引位置 (fixedIndexPlacement)', ec.fixedIndexPlacement || {}, 'json', { rows: 3 })}
                </div>
            </details>
            <details class="insp-fold full">
                <summary>文档级全局注入配置 (mate.globalInjectionConfig)</summary>
                <div style="margin-top:8px">
                    ${field('doc_globalInjectionConfig', '全局注入配置 JSON（作用于整份表格模板）', globalInj, 'json', { rows: 5, wide: true })}
                </div>
            </details>
            <div class="form-actions full"><button type="submit" class="primary">${svg('apply', 14)} 保存参数</button></div>
        </form>`;
        $('[data-meta-form]', body).onsubmit = run((ev) => {
            ev.preventDefault();
            const v = values(ev.target);
            actions.mutateEntry(
                e.id,
                '修改表格导出、SQL 注入与更新配置',
                (item) => {
                    item.raw.exportConfig ||= {};
                    item.raw.updateConfig ||= {};
                    Object.assign(item.raw.exportConfig, {
                        entryName: v.entryName,
                        entryType: v.entryType,
                        keywords: v.keywords,
                        splitByRow: Boolean(v.splitByRow),
                        preventRecursion: Boolean(v.preventRecursion),
                        injectionTemplate: v.injectionTemplate,
                        sqlInjectionTemplate: v.sqlInjectionTemplate,
                        extraIndexEnabled: Boolean(v.extraIndexEnabled),
                        extraIndexEntryName: v.extraIndexEntryName,
                        extraIndexColumns: v.extraIndexColumns || [],
                        extraIndexColumnModes: v.extraIndexColumnModes || {},
                        extraIndexInjectionTemplate: v.extraIndexInjectionTemplate,
                        entryPlacement: v.entryPlacement || {},
                        extraIndexPlacement: v.extraIndexPlacement || {},
                        fixedEntryPlacement: v.fixedEntryPlacement || {},
                        fixedIndexPlacement: v.fixedIndexPlacement || {},
                    });
                    Object.assign(item.raw.updateConfig, {
                        contextDepth: Number(v.contextDepth ?? 8),
                        updateFrequency: Number(v.updateFrequency ?? 1),
                        batchSize: Number(v.batchSize ?? 1),
                        skipFloors: Number(v.skipFloors ?? 0),
                    });
                    if (v.groupId !== null) item.raw.updateConfig.groupId = Number(v.groupId);
                    else delete item.raw.updateConfig.groupId;
                    if (v.uiSentinel !== null) item.raw.updateConfig.uiSentinel = Number(v.uiSentinel);
                    if (v.doc_globalInjectionConfig && typeof v.doc_globalInjectionConfig === 'object') {
                        draft.raw.mate ||= {};
                        draft.raw.mate.globalInjectionConfig = v.doc_globalInjectionConfig;
                    }
                },
                true,
            );
            notify('表格配置已更新到草稿');
        });
        return;
    }
}

function renderSpecialTab(body, { draft, e, actions }) {
    const cfg = specialConfig(draft.raw);
    const tool = cfg.ToolBindings?.[e.id] || null;
    const inj = cfg.MessageInjections?.[e.id] || null;
    body.innerHTML = `<form class="inspector-grid" data-special-form>
        <div class="field full">
            <label><span>SPreset 工具绑定 JSON (ToolBindings)</span><button type="button" data-gen-tool>生成模板</button></label>
            <textarea name="tool" rows="7" data-type="json">${esc(JSON.stringify(tool, null, 2))}</textarea>
        </div>
        <div class="field full">
            <label><span>SPreset 结构化消息 JSON (MessageInjections)</span><button type="button" data-preview-inj>发送预览</button></label>
            <textarea name="inj" rows="7" data-type="json">${esc(JSON.stringify(inj, null, 2))}</textarea>
        </div>
        <div class="form-actions full">
            <button type="button" data-val-tool>验证工具代码</button>
            <button type="submit" class="primary">${svg('apply', 14)} 保存 SPreset 配置</button>
        </div>
    </form>`;
    $('[data-gen-tool]', body).onclick = () => {
        const sample = {
            enabled: false,
            name: 'custom_tool',
            description: '自定义工具',
            code: makeToolCode({ name: 'custom_tool', displayName: '自定义工具', description: '自定义工具' }),
        };
        $('[name="tool"]', body).value = JSON.stringify(sample, null, 2);
    };
    $('[data-preview-inj]', body).onclick = run(async () => {
        const data = JSON.parse($('[name="inj"]', body).value || 'null');
        const res = await rpc('special.preview', { data });
        notify('预览结果：' + JSON.stringify(res).slice(0, 180));
    });
    $('[data-val-tool]', body).onclick = run(async () => {
        const data = JSON.parse($('[name="tool"]', body).value || 'null');
        if (!data?.code) throw Error('没有可验证的 code 字段');
        const res = await rpc('special.validateTool', { code: data.code });
        notify('验证通过：' + JSON.stringify(res).slice(0, 140));
    });
    $('[data-special-form]', body).onsubmit = run((ev) => {
        ev.preventDefault();
        const v = values(ev.target);
        actions.mutateEntry(
            e.id,
            '编辑 SPreset 特殊配置',
            () => {
                const next = specialConfig(draft.raw);
                if (v.tool) {
                    next.ToolBindings ||= {};
                    next.ToolBindings[e.id] = v.tool;
                } else if (next.ToolBindings) delete next.ToolBindings[e.id];
                if (v.inj) {
                    next.MessageInjections ||= {};
                    next.MessageInjections[e.id] = v.inj;
                } else if (next.MessageInjections) delete next.MessageInjections[e.id];
                writeSpecialConfig(draft.raw, next);
            },
            true,
        );
        notify('SPreset 配置已同步到草稿');
    });
}

function renderJsonTab(body, { draft, e, isChar, isDb, actions }) {
    const jsonSource = isChar ? draft.raw : e.raw;
    body.innerHTML = `<form class="field" style="flex:1;display:flex;flex-direction:column" data-json-form>
        <label><span>${isChar ? '角色卡完整 V2 JSON' : '条目完整原始 JSON'}</span></label>
        <textarea name="raw" data-type="json" style="flex:1;min-height:320px">${esc(JSON.stringify(jsonSource, null, 2))}</textarea>
        <div class="form-actions" style="margin-top:8px">
            <button type="submit" class="primary">${svg('apply', 14)} 校验并写入草稿</button>
        </div>
    </form>`;
    $('[data-json-form]', body).onsubmit = run((ev) => {
        ev.preventDefault();
        const v = values(ev.target);
        if (!v.raw || typeof v.raw !== 'object' || Array.isArray(v.raw)) throw Error('必须是合法 JSON 对象');
        if (isDb) assertSafePatch(v.raw);
        if (isChar) {
            ensureCharacterShape(v.raw);
            actions.mutateEntry(
                e.id,
                '编辑角色卡完整 JSON',
                () => {
                    for (const k of Object.keys(draft.raw)) delete draft.raw[k];
                    Object.assign(draft.raw, clone(v.raw));
                    draft.unitIds = undefined;
                },
                true,
            );
            notify('角色卡 JSON 已写入草稿');
            return;
        }
        actions.mutateEntry(
            e.id,
            '编辑原始 JSON',
            (item) => {
                for (const k of Object.keys(item.raw)) delete item.raw[k];
                Object.assign(item.raw, clone(v.raw));
            },
            true,
        );
        notify('原始 JSON 已写入草稿');
    });
}
