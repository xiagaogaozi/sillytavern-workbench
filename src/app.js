// 酒馆工作台 0.7.1：SPreset Editor 风格多标签三栏引擎 · 预设/世界书/角色卡/聊天记录/数据库一体管理
import {
    clone,
    uuid,
    commit,
    commitEntry,
    undo,
    dirty,
    isLiveUnsaved,
    createDraft,
    entries,
    findEntry,
    makeEntry,
    addEntry,
    removeEntries,
    moveEntries,
    setEnabled,
    canToggleEntry,
    transfer,
    pairIndex,
    overwriteEntry,
    folderMeta,
} from './core.js';
import { isDatabaseKind, isPromptKind } from './database-model.js';
import { isCharacterKind, sortCharacters } from './character-model.js';
import { createChatController } from './chat-view.js';
import * as prompts from './prompt-model.js';
import { $, $$, esc, modal, notify, run } from './ui.js';
import { rpc, onHost } from './bridge.js';
import { storePut, storeGet, storeDelete, dehydrateDraft, hydrateDraft } from './store.js';
import { svg, iconBtn } from './icons.js';
import { highlightHtml, collectEntrySearchHits, normalizeQuery } from './diff-search.js';
import {
    renderInspector,
    renderCompareInspector,
    worldStrategyBtnHtml,
    nextWorldStrategy,
    applyWorldStrategy,
} from './inspector.js';
import { createActions, dbCall, charCall, KIND_LABEL } from './workspace-actions.js';
import { openSettings } from './settings.js';

const META_STORAGE_KEY = 'workspace-meta-v2';
const LIST_WINDOW_INIT = 80;
const LIST_WINDOW_STEP = 80;

let state = {
    tabs: [],
    activeTabId: null,
    compare: {
        enabled: false,
        leftTabId: null,
        rightTabId: null,
        selectedLeftId: null,
        selectedRightId: null,
        filter: 'all',
        mode: 'sbs',
        leftSearch: '',
        rightSearch: '',
    },
    inspectorTab: 'content',
    navCollapsed: false,
    mobilePane: 'list',
    needsReload: false,
    receipts: [],
    sessions: {},
};

const draftCache = new Map(); // tabId -> draft object
const dbCatalogCache = new Map(); // kind -> { items, activeName, matchedActive }
const listWindowState = new Map(); // tabId -> { limit, key }
let navSelectMode = false;
let navSelectedNames = new Set();
let navLibSearch = '';
let navLibSortMode = 'default'; // 'default' | 'name'
let navLibSortDir = 'asc'; // 'asc' | 'desc'
let navPaneMode = 'library'; // 'library' 预设库 | 'characters' 角色卡库 | 'chats' 聊天记录管理
let charCatalog = null; // { items: [], allTags: [], currentAvatar: '' }
let charCatalogLoading = false;
let charSortMode = 'name'; // 'name' | 'date_added' | 'date_last_chat'
let charSortDir = 'asc'; // 'asc' | 'desc'
let charSearch = '';
let charSelectMode = false;
let charSelectedAvatars = new Set();
const avatarVersions = new Map();
let config = {};
let runtime = { lists: { presets: [], worldbooks: [] }, theme: {}, activeEntries: [] };
let dbCaps = null;
let saveTimers = new Map();
let metaTimer = null;
let activePopMenu = null;
let activeSubMenu = null;

function charThumbUrl(avatar, ver) {
    if (!avatar) return '';
    const v = ver || avatarVersions.get(avatar) || '';
    return `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}${v ? '&t=' + encodeURIComponent(String(v)) : ''}`;
}

const chatCtrl = createChatController({
    charThumbUrl,
    renderChatPanels() {
        if (navPaneMode === 'chats' && !state.compare.enabled) {
            renderNavPanel();
            renderSingleListPanel();
            renderRightInspector();
            renderFooter();
        }
    },
    onSelectChat() {
        state.mobilePane = 'list';
        applyGridLayout();
    },
    onFocusFloor() {
        state.mobilePane = 'inspector';
        applyGridLayout();
    },
    onHistoryChange() {
        renderHeaderTabs();
    },
});

async function openChatsForCharacter(avatar, charName) {
    state.compare.enabled = false;
    state.navCollapsed = false;
    navPaneMode = 'chats';
    state.mobilePane = 'nav';
    renderAll();
    await chatCtrl.openForCharacter(avatar, charName);
}

async function openAllChatsView() {
    state.compare.enabled = false;
    state.navCollapsed = false;
    navPaneMode = 'chats';
    state.mobilePane = 'nav';
    chatCtrl.state.filterAvatar = '';
    chatCtrl.state.filterCharName = '';
    renderAll();
    await chatCtrl.ensureCatalog(false);
}

async function ensureCharacterCatalog(force = false) {
    if (!force && (charCatalog || charCatalogLoading)) return charCatalog;
    charCatalogLoading = true;
    try {
        const res = await charCall('list', { refresh: force });
        charCatalog = res || { items: [], allTags: [], currentAvatar: '' };
    } catch (err) {
        if (force) notify('读取角色卡列表失败：' + err.message, true);
    } finally {
        charCatalogLoading = false;
    }
    renderHeaderTabs();
    renderNavPanel();
    return charCatalog;
}

function tabById(id) {
    return state.tabs.find((t) => t.id === id) || null;
}
function activeTab() {
    return tabById(state.activeTabId) || state.tabs[0] || null;
}
function draftFor(tabId) {
    return draftCache.get(tabId) || null;
}
function activeDraft() {
    const t = activeTab();
    return t ? draftFor(t.id) : null;
}
function otherCompareDraft() {
    if (!state.compare.enabled) return null;
    const cur = activeTab();
    if (!cur) return null;
    const otherId = cur.id === state.compare.leftTabId ? state.compare.rightTabId : state.compare.leftTabId;
    return otherId ? draftFor(otherId) : null;
}

function defaultView() {
    return {
        search: '',
        searchMode: 'jump', // 'jump' 定位跳转 | 'filter' 筛选
        hitCursor: 0,
        status: 'all',
        sort: 'original',
        folder: '',
        group: '',
    };
}

function tabView(tab) {
    if (!tab) return defaultView();
    tab.view ||= defaultView();
    return tab.view;
}

function buildMetaSnapshot() {
    return {
        schemaVersion: 5,
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        compare: state.compare,
        inspectorTab: state.inspectorTab,
        navCollapsed: state.navCollapsed,
        receipts: state.receipts.slice(0, 40),
    };
}

function persistMeta() {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(() => {
        metaTimer = null;
        storePut(META_STORAGE_KEY, buildMetaSnapshot()).catch(() => {});
    }, 220);
}

function persistDraft(tabId) {
    const d = draftFor(tabId);
    if (!d) return;
    const isDirty = dirty(d);
    const tab = tabById(tabId);
    if (tab) {
        tab.name = d.name;
        tab.sourceName = d.sourceName;
        tab.fromLive = Boolean(d.fromLive);
        tab.dirty = isDirty;
    }
    clearTimeout(saveTimers.get(tabId));
    // 仅当存在未保存修改或尚未入库的草稿时才落盘 IndexedDB，避免每次切换大世界书都写入数十 MB
    if (!isDirty && d.sourceName) {
        saveTimers.delete(tabId);
        storeDelete('tab-draft:' + tabId).catch(() => {});
        persistMeta();
        return;
    }
    saveTimers.set(
        tabId,
        setTimeout(() => {
            saveTimers.delete(tabId);
            storePut('tab-draft:' + tabId, dehydrateDraft(d)).catch(() => {});
        }, 280),
    );
    persistMeta();
}

async function flushAllPendingPersistence() {
    const jobs = [];
    if (metaTimer) {
        clearTimeout(metaTimer);
        metaTimer = null;
        jobs.push(storePut(META_STORAGE_KEY, buildMetaSnapshot()).catch(() => {}));
    }
    for (const [tabId, timer] of [...saveTimers.entries()]) {
        clearTimeout(timer);
        saveTimers.delete(tabId);
        const d = draftFor(tabId);
        if (d && (dirty(d) || !d.sourceName)) {
            jobs.push(storePut('tab-draft:' + tabId, dehydrateDraft(d)).catch(() => {}));
        }
    }
    if (jobs.length) await Promise.all(jobs);
}

async function closeWorkbench() {
    await flushAllPendingPersistence();
    await rpc('close');
}

async function ensureDraftLoaded(tabId) {
    if (!tabId) return null;
    if (draftCache.has(tabId)) return draftCache.get(tabId);
    const tab = tabById(tabId);
    if (!tab) return null;
    const stored = await storeGet('tab-draft:' + tabId);
    if (stored) {
        const d = hydrateDraft(stored);
        draftCache.set(tabId, d);
        tab.dirty = dirty(d);
        tab.fromLive = Boolean(d.fromLive);
        return d;
    }
    // 懒加载酒馆/数据库当前实际配置
    if (tab.fromLive && !tab.sourceName) {
        try {
            if (isDatabaseKind(tab.kind)) {
                const res = await dbCall('current', { kind: tab.kind });
                const matched = res.matchedActive && res.activeName ? res.activeName : null;
                const displayName = matched || KIND_LABEL[tab.kind];
                const d = createDraft(tab.kind, res.raw, displayName, Boolean(matched), { fromLive: true, takeOwnership: true });
                d.nativeScope = res.scope;
                draftCache.set(tabId, d);
                tab.name = displayName;
                tab.sourceName = matched;
                tab.activeEntryId ||= entries(d)[0]?.id || null;
                tab.dirty = false;
                tab.fromLive = true;
                return d;
            }
            if (tab.kind === 'preset') {
                const curName = runtime.lists?.currentPreset;
                const raw = curName
                    ? await rpc('documents.read', { kind: 'preset', name: curName })
                    : await rpc('documents.currentPreset');
                const d = createDraft('preset', raw, curName || tab.name, Boolean(curName), {
                    fromLive: !curName,
                    takeOwnership: true,
                });
                draftCache.set(tabId, d);
                tab.sourceName = d.sourceName;
                tab.fromLive = Boolean(d.fromLive);
                tab.activeEntryId ||= entries(d)[0]?.id || null;
                tab.dirty = false;
                return d;
            }
        } catch (err) {
            notify('读取「' + tab.name + '」失败：' + err.message, true);
            return null;
        }
    }
    if (tab.sourceName) {
        try {
            if (isCharacterKind(tab.kind)) {
                const res = await charCall('read', { avatar: tab.sourceName });
                const d = createDraft('character', res.raw, res.name, true, { takeOwnership: true });
                d.avatar = res.avatar;
                d.sourceName = res.avatar;
                d.charTags = res.tags || [];
                d.charAuxWorlds = res.auxiliary || [];
                d.avatarVersion = avatarVersions.get(res.avatar) || Date.now();
                draftCache.set(tabId, d);
                tab.name = res.name;
                tab.activeEntryId ||= entries(d)[0]?.id || null;
                return d;
            }
            const raw = isDatabaseKind(tab.kind)
                ? (await dbCall('read', { kind: tab.kind, name: tab.sourceName })).raw
                : await rpc('documents.read', { kind: tab.kind, name: tab.sourceName });
            const d = createDraft(tab.kind, raw, tab.sourceName, true, { takeOwnership: true });
            draftCache.set(tabId, d);
            tab.activeEntryId ||= entries(d)[0]?.id || null;
            return d;
        } catch {}
    }
    return null;
}

function closeSubMenu() {
    if (activeSubMenu) {
        activeSubMenu.remove();
        activeSubMenu = null;
    }
}

function closePopMenu() {
    closeSubMenu();
    if (activePopMenu) {
        activePopMenu.remove();
        activePopMenu = null;
    }
}

function showPopMenu(anchor, items) {
    closePopMenu();
    const menu = document.createElement('div');
    menu.className = 'pop-menu';
    for (const item of items) {
        if (item === '-') {
            menu.append(document.createElement('hr'));
            continue;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        if (item.danger) btn.className = 'danger';
        btn.innerHTML =
            (item.icon ? svg(item.icon, 14) : '') +
            `<span class="pop-menu-label">${esc(item.label)}</span>` +
            (item.hasSub ? '<span class="pop-menu-caret">▸</span>' : '');
        btn.onclick = () => {
            if (!item.keepOpen) closePopMenu();
            run(() => item.action(btn))();
        };
        menu.append(btn);
    }
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, right: anchor.x, top: anchor.y };
    const mw = menu.offsetWidth || 180;
    const mh = menu.offsetHeight || 200;
    const left = Math.min(window.innerWidth - mw - 8, Math.max(8, rect.left));
    const top = rect.bottom + mh + 8 > window.innerHeight ? Math.max(8, rect.top - mh - 4) : rect.bottom + 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    activePopMenu = menu;
}

async function copyEntryToTargetTab(sourceDraft, entryId, targetTab) {
    const targetDraft = await ensureDraftLoaded(targetTab.id);
    if (!targetDraft) throw Error('无法加载目标标签草稿：' + targetTab.name);
    commit(targetDraft, '跨预设复制条目', () => transfer(sourceDraft, targetDraft, [entryId]));
    persistDraft(targetTab.id);
    renderHeaderTabs();
    renderFooter();
    if (state.compare.enabled) renderCompareColumns();
    notify(`已复制到标签「${targetTab.name}」（草稿已标黄灯，切到该标签保存即可）`);
}

async function copyEntryToSavedPreset(sourceDraft, entryId, targetName) {
    const existing = state.tabs.find((t) => t.kind === sourceDraft.kind && t.sourceName === targetName);
    if (existing) return copyEntryToTargetTab(sourceDraft, entryId, existing);
    let targetDraft;
    if (isCharacterKind(sourceDraft.kind)) {
        const res = await charCall('read', { avatar: targetName });
        targetDraft = createDraft('character', res.raw, res.name, true, { takeOwnership: true });
        targetDraft.avatar = res.avatar;
        targetDraft.sourceName = res.avatar;
        targetDraft.charTags = res.tags || [];
        targetDraft.charAuxWorlds = res.auxiliary || [];
        targetDraft.avatarVersion = avatarVersions.get(res.avatar) || Date.now();
    } else if (isDatabaseKind(sourceDraft.kind)) {
        const res = await dbCall('read', { kind: sourceDraft.kind, name: targetName });
        targetDraft = createDraft(sourceDraft.kind, res.raw, res.name, true, { takeOwnership: true });
        targetDraft.nativeRevision = res.revision;
        targetDraft.nativeScope = res.scope;
    } else {
        const raw = await rpc('documents.read', { kind: sourceDraft.kind, name: targetName });
        targetDraft = createDraft(sourceDraft.kind, raw, targetName, true, { takeOwnership: true });
    }
    commit(targetDraft, '跨文档复制条目', () => transfer(sourceDraft, targetDraft, [entryId]));
    await addTab(targetDraft);
    const added = entries(targetDraft).at(-1);
    const newTab = activeTab();
    if (newTab && added) {
        newTab.activeEntryId = added.id;
        renderAll();
    }
    notify(`已打开「${targetDraft.name}」并复制该条目，核对后点击保存即可写回`);
}

async function openCopyToOtherPresetSubMenu(triggerBtn, sourceTab, sourceDraft, entryId) {
    closeSubMenu();
    const kind = sourceDraft.kind;
    const sub = document.createElement('div');
    sub.className = 'pop-menu pop-submenu';
    sub.innerHTML =
        `<div class="pop-submenu-head"><input type="search" data-sub-filter placeholder="搜索同类别${esc(KIND_LABEL[kind])}…"></div>` +
        `<div class="pop-submenu-list" data-sub-list><p class="muted" style="padding:10px;text-align:center">正在加载列表…</p></div>`;
    document.body.append(sub);
    activeSubMenu = sub;

    const positionSub = () => {
        const rect = triggerBtn.getBoundingClientRect();
        const sw = sub.offsetWidth || 240;
        const sh = sub.offsetHeight || 260;
        const spaceRight = window.innerWidth - rect.right;
        const left = spaceRight >= sw + 12 ? rect.right + 4 : Math.max(8, rect.left - sw - 4);
        const top = Math.min(window.innerHeight - sh - 8, Math.max(8, rect.top - 4));
        sub.style.left = left + 'px';
        sub.style.top = top + 'px';
    };
    positionSub();

    // 收集同类别目标：1) 当前打开的标签页（排除当前标签） 2) 其他同类别已保存项
    const openSameTabs = state.tabs.filter((t) => t.kind === kind && t.id !== sourceTab.id);
    const openedKeys = new Set(openSameTabs.map((t) => t.sourceName).filter(Boolean));
    if (sourceDraft.sourceName) openedKeys.add(sourceDraft.sourceName);

    let allItems = [];
    if (kind === 'preset') {
        allItems = (runtime.lists?.presets || []).map((n) => ({ value: n, label: n }));
    } else if (kind === 'worldbook') {
        allItems = (runtime.lists?.worldbooks || []).map((n) => ({ value: n, label: n }));
    } else if (kind === 'character') {
        if (!charCatalog) await ensureCharacterCatalog(false);
        allItems = (charCatalog?.items || []).map((c) => ({ value: c.avatar, label: c.name }));
    } else {
        let cat = dbCatalogCache.get(kind);
        if (!cat) {
            try {
                cat = await dbCall('list', { kind });
                dbCatalogCache.set(kind, cat || { items: [], activeName: '', matchedActive: false });
            } catch {}
        }
        allItems = (cat?.items || []).map((i) => ({ value: i.name, label: i.name }));
    }
    if (!sub.isConnected) return;

    const otherItems = allItems.filter((it) => !openedKeys.has(it.value));
    const filterInp = $('[data-sub-filter]', sub);
    const listBox = $('[data-sub-list]', sub);

    const draw = () => {
        const q = filterInp.value.trim().toLowerCase();
        const fOpen = openSameTabs.filter((t) => !q || t.name.toLowerCase().includes(q));
        const fOther = otherItems.filter((it) => !q || it.label.toLowerCase().includes(q));
        let html = '';
        if (fOpen.length) {
            html +=
                `<div class="picker-group-title"><span>当前打开的标签页</span></div>` +
                fOpen
                    .map(
                        (t) =>
                            `<button type="button" class="pop-sub-item" data-copy-tab="${esc(t.id)}" title="复制到已打开标签：${esc(t.name)}">` +
                            `${svg(tabIconName(t.kind), 13)}<span class="pop-menu-label">${esc(t.name)}</span><span class="badge">已打开</span></button>`,
                    )
                    .join('');
        }
        if (fOther.length) {
            html +=
                `<div class="picker-group-title"><span>其他${esc(KIND_LABEL[kind])}</span></div>` +
                fOther
                    .map(
                        (it) =>
                            `<button type="button" class="pop-sub-item" data-copy-name="${esc(it.value)}" title="打开并复制到：${esc(it.label)}">` +
                            `${svg(tabIconName(kind), 13)}<span class="pop-menu-label">${esc(it.label)}</span></button>`,
                    )
                    .join('');
        }
        listBox.innerHTML = html || `<p class="muted" style="padding:10px;text-align:center">没有其他同类别${esc(KIND_LABEL[kind])}</p>`;
        for (const b of $$('[data-copy-tab]', listBox)) {
            b.onclick = run(async () => {
                const t = tabById(b.dataset.copyTab);
                closePopMenu();
                if (t) await copyEntryToTargetTab(sourceDraft, entryId, t);
            });
        }
        for (const b of $$('[data-copy-name]', listBox)) {
            b.onclick = run(async () => {
                const name = b.dataset.copyName;
                closePopMenu();
                await copyEntryToSavedPreset(sourceDraft, entryId, name);
            });
        }
        positionSub();
    };
    filterInp.oninput = draw;
    draw();
    filterInp.focus();
}

document.addEventListener('pointerdown', (e) => {
    const inMain = activePopMenu && activePopMenu.contains(e.target);
    const inSub = activeSubMenu && activeSubMenu.contains(e.target);
    if ((activePopMenu || activeSubMenu) && !inMain && !inSub) closePopMenu();
});

function applyTheme(host) {
    runtime.theme = host || {};
    for (const [k, v] of Object.entries(runtime.theme)) if (v) document.documentElement.style.setProperty(k, v);
    const t = config.theme || {};
    document.documentElement.dataset.theme = t.mode || 'inherit';
    const channels = (runtime.theme['--SmartThemeBlurTintColor'] || '').match(/\d+(?:\.\d+)?/g);
    document.documentElement.style.colorScheme =
        t.mode === 'light'
            ? 'light'
            : t.mode === 'dark'
              ? 'dark'
              : channels && Number(channels[0]) * 0.299 + Number(channels[1]) * 0.587 + Number(channels[2]) * 0.114 > 150
                ? 'light'
                : 'dark';
    document.documentElement.dataset.pwwScheme = document.documentElement.style.colorScheme;
    document.documentElement.style.setProperty('--pww-scale', String(t.fontScale || 1));
    document.documentElement.style.setProperty('--pww-row-min', (t.rowHeight || 52) + 'px');
    const wb = $('.workbench');
    if (wb) wb.classList.toggle('fullscreen', t.fullscreen !== false);
}

// 兼容 AI 面板与设置的 env 适配器
const env = {
    get state() {
        return state;
    },
    get config() {
        return config;
    },
    set config(v) {
        config = v;
    },
    getDraft: () => activeDraft(),
    otherDraft: () => otherCompareDraft(),
    persist: () => {
        const t = activeTab();
        if (t) persistDraft(t.id);
        else persistMeta();
    },
    changed: () => {
        const t = activeTab();
        if (t) persistDraft(t.id);
        renderAll();
    },
    async saveConfig() {
        config = await rpc('config.save', { value: config });
        applyTheme(runtime.theme || {});
        renderAll();
    },
    async useDraft(d) {
        await addTab(d);
    },
    async restoreBackup(v) {
        const base = await rpc('documents.read', { kind: v.kind, name: v.name, fresh: true });
        const d = createDraft(v.kind, base, v.name, true);
        commit(d, '恢复原件快照', () => {
            d.raw = clone(v.raw);
        });
        await addTab(d);
        notify('备份已恢复到新标签页，确认后点击保存才写回');
    },
};

const actions = createActions({
    runtime: () => runtime,
    dbCaps: () => dbCaps,
    setDbCaps: (c) => {
        dbCaps = c;
    },
    characterCatalog: () => charCatalog,
    setCharacterCatalog: (cat) => {
        charCatalog = cat || { items: [], allTags: [], currentAvatar: '' };
    },
    bumpAvatarVersion: (avatar, ver) => {
        if (avatar) avatarVersions.set(avatar, ver || Date.now());
    },
    findTab: (kind, name) => state.tabs.find((t) => t.kind === kind && t.sourceName === name),
    listTabNames: (kind) => state.tabs.filter((t) => t.kind === kind).map((t) => t.name),
    activateTab,
    addTab,
    closeTab,
    afterSave(d, { name, sourceName, asNew }) {
        if (!asNew) {
            const t = state.tabs.find((x) => draftFor(x.id) === d);
            if (t) {
                t.name = name;
                t.sourceName = sourceName ?? name;
                t.fromLive = false;
                t.dirty = false;
                persistDraft(t.id);
            }
        }
        // 刷新后台目录缓存
        if (isCharacterKind(d.kind)) {
            renderNavPanel();
        } else if (isDatabaseKind(d.kind)) {
            dbCall('list', { kind: d.kind })
                .then((r) => {
                    dbCatalogCache.set(d.kind, r || { items: [], activeName: '', matchedActive: false });
                    renderNavPanel();
                })
                .catch(() => {});
        } else {
            rpc('documents.list', { refresh: d.kind === 'worldbook' && Boolean(asNew) })
                .then((l) => {
                    runtime.lists = l;
                    renderNavPanel();
                })
                .catch(() => {});
        }
        renderHeaderTabs();
        renderMainArea();
        renderFooter();
    },
    async afterApply(d, result) {
        if (isDatabaseKind(d.kind)) {
            let cat = result?.catalog;
            if (!cat) {
                try {
                    cat = await dbCall('list', { kind: d.kind });
                } catch {}
            }
            if (cat) {
                dbCatalogCache.set(d.kind, cat);
                // 同步清理同模块旧的未入库实配标签的 liveKey/fromLive 标志，确保绿灯精准切到新应用的预设
                if (cat.matchedActive && cat.activeName) {
                    for (const t of state.tabs) {
                        if (t.kind !== d.kind) continue;
                        if (t.sourceName !== cat.activeName) {
                            t.liveKey = null;
                            t.fromLive = false;
                            const td = draftFor(t.id);
                            if (td) td.fromLive = false;
                        }
                    }
                    persistMeta();
                }
            }
        }
        renderAll();
    },
    markMutated(d) {
        const t = state.tabs.find((x) => draftFor(x.id) === d);
        if (t) persistDraft(t.id);
        renderHeaderTabs();
        renderMainArea();
        renderFooter();
    },
    addReceipt(val, label) {
        state.receipts.unshift({ label, at: Date.now(), backup: val?.backup });
        state.receipts = state.receipts.slice(0, 40);
        persistMeta();
    },
    receipts: () => state.receipts,
    backups: () => config.backups || [],
    restoreBackup: (v) => env.restoreBackup(v),
    markNeedsReload() {
        state.needsReload = true;
        renderBanner();
    },
    refreshView: () => renderAll(),
});

async function addTab(draft, opts = {}) {
    if (opts.liveKey) {
        const existing = state.tabs.find((t) => t.liveKey === opts.liveKey);
        if (existing) {
            draftCache.set(existing.id, draft);
            existing.name = draft.name;
            existing.fromLive = Boolean(draft.fromLive);
            existing.dirty = dirty(draft);
            existing.activeEntryId ||= entries(draft)[0]?.id || null;
            state.activeTabId = existing.id;
            persistDraft(existing.id);
            if (isDatabaseKind(draft.kind)) prefetchDbCatalog(draft.kind);
            renderAll();
            return;
        }
    }
    const id = uuid();
    const list = entries(draft);
    const tab = {
        id,
        kind: draft.kind,
        name: draft.name,
        sourceName: draft.sourceName || null,
        fromLive: Boolean(draft.fromLive),
        liveKey: opts.liveKey || null,
        dirty: dirty(draft),
        activeEntryId: list[0]?.id || null,
        view: defaultView(),
    };
    draftCache.set(id, draft);
    state.tabs.push(tab);
    state.activeTabId = id;
    state.mobilePane = 'list';
    if (isCharacterKind(draft.kind)) {
        navPaneMode = 'characters';
        if (state.compare.enabled) state.compare.enabled = false;
        void ensureCharacterCatalog(false);
    } else {
        if (navPaneMode === 'chats') navPaneMode = 'library';
        if (state.compare.enabled && !state.compare.rightTabId && state.compare.leftTabId !== id) {
            state.compare.rightTabId = id;
        }
    }
    persistDraft(id);
    if (isDatabaseKind(draft.kind)) prefetchDbCatalog(draft.kind);
    renderAll();
}

async function activateTab(id) {
    const tab = tabById(id);
    if (!tab) return;
    if (tab.kind !== activeTab()?.kind) {
        navSelectMode = false;
        navSelectedNames.clear();
    }
    if (isCharacterKind(tab.kind)) {
        navPaneMode = 'characters';
        void ensureCharacterCatalog(false);
    } else if (navPaneMode === 'chats' || isCharacterKind(activeTab()?.kind)) {
        navPaneMode = 'library';
    }
    state.activeTabId = id;
    state.mobilePane = 'list';
    await ensureDraftLoaded(id);
    if (isDatabaseKind(tab.kind)) prefetchDbCatalog(tab.kind);
    persistMeta();
    renderAll();
}

async function closeTab(id, force = false) {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = state.tabs[idx];
    const d = draftFor(id);
    if (!force && d && dirty(d)) {
        const ok = await modal('关闭未保存标签？', `<p>「${esc(tab.name)}」有尚未保存的改动，关闭后该标签草稿将被移除。</p>`, {
            submit: '放弃改动并关闭',
        });
        if (!ok) return;
    }
    state.tabs.splice(idx, 1);
    draftCache.delete(id);
    listWindowState.delete(id);
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    storeDelete('tab-draft:' + id).catch(() => {});
    if (state.activeTabId === id) {
        state.activeTabId = state.tabs[Math.min(idx, state.tabs.length - 1)]?.id || null;
        if (state.activeTabId) await ensureDraftLoaded(state.activeTabId);
    }
    if (state.compare.leftTabId === id) state.compare.leftTabId = state.tabs[0]?.id || null;
    if (state.compare.rightTabId === id)
        state.compare.rightTabId = state.tabs.find((t) => t.id !== state.compare.leftTabId)?.id || null;
    persistMeta();
    renderAll();
}

async function closeAllTabs() {
    if (!state.tabs.length) return;
    const dirtyTabs = state.tabs.filter((t) => {
        const d = draftFor(t.id);
        return d ? dirty(d) : Boolean(t.dirty);
    });
    if (dirtyTabs.length) {
        const ok = await modal(
            '关闭所有标签页？',
            `<p>当前有 <strong>${dirtyTabs.length}</strong> 个标签存在尚未保存的修改（${esc(dirtyTabs.map((t) => t.name).slice(0, 4).join('、'))}${dirtyTabs.length > 4 ? ' 等' : ''}），确认全部关闭吗？</p>`,
            { submit: '全部关闭' },
        );
        if (!ok) return;
    }
    const ids = state.tabs.map((t) => t.id);
    state.tabs = [];
    state.activeTabId = null;
    state.compare.enabled = false;
    state.compare.leftTabId = null;
    state.compare.rightTabId = null;
    state.compare.selectedLeftId = null;
    state.compare.selectedRightId = null;
    for (const id of ids) {
        draftCache.delete(id);
        listWindowState.delete(id);
        clearTimeout(saveTimers.get(id));
        saveTimers.delete(id);
        storeDelete('tab-draft:' + id).catch(() => {});
    }
    persistMeta();
    renderAll();
    notify('已关闭所有标签页');
}

function prefetchDbCatalog(kind) {
    if (!isDatabaseKind(kind)) return;
    dbCall('list', { kind })
        .then((r) => {
            dbCatalogCache.set(kind, r || { items: [], activeName: '', matchedActive: false });
            // 若顶栏有该模块的默认实配标签且已匹配预设库条目，自动同步清晰名称
            const liveTab = state.tabs.find((t) => t.liveKey === 'live:' + kind && !t.dirty);
            if (liveTab && r?.matchedActive && r.activeName && !draftFor(liveTab.id)) {
                liveTab.name = r.activeName;
                liveTab.sourceName = r.activeName;
                renderHeaderTabs();
            }
            renderNavPanel();
        })
        .catch(() => {});
}

async function toggleCompareMode() {
    if (!state.compare.enabled) {
        const cur = activeTab();
        const comparableTabs = state.tabs.filter((t) => !isCharacterKind(t.kind));
        if (cur && isCharacterKind(cur.kind) && !comparableTabs.length) {
            notify('角色卡不支持双卡对比；如需对比预设/世界书/数据库，请先打开相应标签');
            return;
        }
        if (!comparableTabs.length) {
            notify('请先打开预设、世界书或数据库标签再开启对比模式');
            return;
        }
        if (cur && isCharacterKind(cur.kind)) {
            notify('角色卡不参与双卡对比，已自动切换为其他可对比标签');
        }
        state.compare.enabled = true;
        const validLeft = tabById(state.compare.leftTabId);
        if (!validLeft || isCharacterKind(validLeft.kind)) {
            state.compare.leftTabId = cur && !isCharacterKind(cur.kind) ? cur.id : comparableTabs[0].id;
        }
        const validRight = tabById(state.compare.rightTabId);
        if (!validRight || isCharacterKind(validRight.kind) || state.compare.rightTabId === state.compare.leftTabId) {
            const leftTab = tabById(state.compare.leftTabId);
            const sameKind = comparableTabs.find((t) => t.id !== state.compare.leftTabId && (!leftTab || t.kind === leftTab.kind));
            state.compare.rightTabId =
                sameKind?.id || comparableTabs.find((t) => t.id !== state.compare.leftTabId)?.id || null;
        }
        await Promise.all([
            ensureDraftLoaded(state.compare.leftTabId),
            ensureDraftLoaded(state.compare.rightTabId),
        ]);
    } else {
        state.compare.enabled = false;
    }
    persistMeta();
    renderAll();
}

function tabIconName(kind) {
    if (kind === 'preset') return 'preset';
    if (kind === 'worldbook') return 'worldbook';
    if (kind === 'character') return 'character';
    return 'database';
}

function filteredEntries(d, v) {
    let list = entries(d);
    if (v.folder) list = list.filter((e) => e.group === v.folder);
    if (v.group) list = list.filter((e) => e.group === v.group);
    if (v.status === 'enabled') list = list.filter((e) => e.enabled);
    else if (v.status === 'disabled') list = list.filter((e) => !e.enabled);
    else if (v.status === 'selected') list = list.filter((e) => d.selected.includes(e.id));
    else if (v.status === 'ordered') list = list.filter((e) => Number(e.raw.injection_position || 0) !== 1);
    else if (v.status === 'injected') list = list.filter((e) => Number(e.raw.injection_position) === 1);
    else if (['constant', 'selective', 'vectorized'].includes(v.status))
        list = list.filter((e) => e.strategy === v.status);

    const q = normalizeQuery(v.search);
    if (q && v.searchMode === 'filter') {
        list = list.filter((e) => (e.name + '\n' + e.content + '\n' + e.id).toLocaleLowerCase().includes(q));
    }
    if (v.sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    else if (v.sort === 'order')
        list = [...list].sort((a, b) => (a.raw.order ?? a.raw.injection_order ?? 100) - (b.raw.order ?? b.raw.injection_order ?? 100));
    return list;
}

// 渲染完整壳（只在首次加载或大模式变更时建壳，后续全局部刷新）
function mountShell() {
    $('#app').innerHTML = `
        <main class="workbench ${config.theme?.fullscreen !== false ? 'fullscreen' : ''}">
            <header class="app-header">
                <div class="header-brand">
                    ${iconBtn('sidebar', '展开/收起左侧预设库', 'data-top="toggle-nav"', 'sm')}
                </div>
                <div class="tab-strip" id="pww-tabs" role="tablist" aria-label="已打开文档标签页"></div>
                <div class="tab-strip-controls" id="pww-tab-controls"></div>
                <div class="header-actions" id="pww-top-actions"></div>
            </header>
            <div class="banner-slot" id="pww-banner"></div>
            <div class="workspace-grid" id="pww-grid">
                <aside class="workspace-panel nav-panel" id="pww-col-a"></aside>
                <section class="workspace-panel chain-panel" id="pww-col-b"></section>
                <aside class="workspace-panel inspector-panel" id="pww-col-c"></aside>
            </div>
            <nav class="mobile-nav" id="pww-mobile-nav">
                <button type="button" data-mpane="nav">${svg('folder', 15)}<span>预设库</span></button>
                <button type="button" data-mpane="list">${svg('chain', 15)}<span>列表</span></button>
                <button type="button" data-mpane="compare-b">${svg('compare', 15)}<span>对比B</span></button>
                <button type="button" data-mpane="inspector">${svg('sliders', 15)}<span>编辑</span></button>
            </nav>
            <footer class="app-footer" id="pww-footer"></footer>
        </main>
    `;
    $('[data-top="toggle-nav"]').onclick = () => {
        state.navCollapsed = !state.navCollapsed;
        persistMeta();
        applyGridLayout();
    };
    for (const b of $$('[data-mpane]')) {
        b.onclick = () => {
            state.mobilePane = b.dataset.mpane;
            applyGridLayout();
        };
    }

    // 顶部标签条滚轮横向滚动 + 按住拖拽平移，彻底解决溢出无法滑动的问题
    const strip = $('#pww-tabs');
    if (strip) {
        strip.addEventListener(
            'wheel',
            (e) => {
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                    e.preventDefault();
                    strip.scrollLeft += e.deltaY;
                }
            },
            { passive: false },
        );
        let dragging = false,
            startX = 0,
            startLeft = 0;
        strip.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.target.closest('[data-tab-close]')) return;
            dragging = true;
            startX = e.clientX;
            startLeft = strip.scrollLeft;
            strip.dataset.dragMoved = '0';
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            if (Math.abs(dx) > 4) {
                strip.dataset.dragMoved = '1';
                strip.classList.add('is-dragging');
                strip.scrollLeft = startLeft - dx;
            }
        });
        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            strip.classList.remove('is-dragging');
            setTimeout(() => {
                if (strip) strip.dataset.dragMoved = '0';
            }, 0);
        });
    }
}

function applyGridLayout() {
    const grid = $('#pww-grid');
    if (!grid) return;
    if (!state.compare.enabled && state.mobilePane === 'compare-b') {
        state.mobilePane = 'list';
    }
    grid.className =
        'workspace-grid' +
        (state.compare.enabled ? ' is-compare' : state.navCollapsed ? ' nav-collapsed' : '');
    grid.dataset.mobilePane = state.mobilePane;
    const colA = $('#pww-col-a');
    const colB = $('#pww-col-b');
    colA.className = state.compare.enabled ? 'workspace-panel chain-panel compare-a-panel' : 'workspace-panel nav-panel';
    colB.className = state.compare.enabled ? 'workspace-panel chain-panel compare-b-panel' : 'workspace-panel chain-panel';
    const mNav = $('#pww-mobile-nav');
    if (mNav) {
        mNav.classList.toggle('is-compare', Boolean(state.compare.enabled));
        const firstLabel = $('[data-mpane="nav"] span', mNav);
        if (firstLabel) {
            firstLabel.textContent = state.compare.enabled
                ? '对比A'
                : navPaneMode === 'characters'
                  ? '角色卡'
                  : navPaneMode === 'chats'
                    ? '聊天'
                    : '预设库';
        }
        const secondLabel = $('[data-mpane="list"] span', mNav);
        if (secondLabel) {
            secondLabel.textContent = navPaneMode === 'chats' && !state.compare.enabled ? '筛选' : '列表';
        }
        const editLabel = $('[data-mpane="inspector"] span', mNav);
        if (editLabel) {
            editLabel.textContent = state.compare.enabled ? '差异' : '编辑';
        }
    }
    for (const b of $$('[data-mpane]')) {
        b.classList.toggle('active', b.dataset.mpane === state.mobilePane);
    }
    const navBtn = $('[data-top="toggle-nav"]');
    if (navBtn) navBtn.classList.toggle('active', !state.navCollapsed && !state.compare.enabled);
}

function renderBanner() {
    const slot = $('#pww-banner');
    if (!slot) return;
    if (!state.needsReload) {
        slot.innerHTML = '';
        return;
    }
    slot.innerHTML = `
        <div class="reload-banner">
            <span><strong>已写入酒馆数据库设置：</strong>刷新酒馆页面后即可同步到数据库运行内存（刷新前请勿在数据库面板保存设置）。</span>
            <div class="row">
                <button type="button" class="primary" data-reload-st>${svg('refresh', 14)} 一键刷新酒馆</button>
                ${iconBtn('close', '稍后再说', 'data-dismiss-reload', 'sm')}
            </div>
        </div>
    `;
    $('[data-reload-st]', slot).onclick = run(() => rpc('host.reload'));
    $('[data-dismiss-reload]', slot).onclick = () => {
        state.needsReload = false;
        renderBanner();
    };
}

function renderHeaderTabs() {
    const strip = $('#pww-tabs');
    const tabCtrl = $('#pww-tab-controls');
    const actBar = $('#pww-top-actions');
    if (!strip || !tabCtrl || !actBar) return;
    const prevScrollLeft = strip.scrollLeft;

    strip.innerHTML = state.tabs
        .map((t) => {
            const isActive = !state.compare.enabled && t.id === state.activeTabId;
            const isA = state.compare.enabled && t.id === state.compare.leftTabId;
            const isB = state.compare.enabled && t.id === state.compare.rightTabId;
            const d = draftFor(t.id);
            const isDirty = d ? dirty(d) : Boolean(t.dirty);
            const cat = isDatabaseKind(t.kind) ? dbCatalogCache.get(t.kind) : null;
            let isCurrentLive = false;
            if (t.kind === 'preset') {
                isCurrentLive =
                    Boolean(t.sourceName && t.sourceName === runtime.lists?.currentPreset) ||
                    Boolean(d ? isLiveUnsaved(d) : t.fromLive && !t.sourceName && !t.dirty);
            } else if (t.kind === 'character') {
                isCurrentLive = Boolean(t.sourceName && charCatalog?.currentAvatar && t.sourceName === charCatalog.currentAvatar);
            } else if (isDatabaseKind(t.kind)) {
                if (cat?.matchedActive && cat?.activeName) {
                    isCurrentLive = Boolean(t.sourceName && t.sourceName === cat.activeName);
                } else {
                    isCurrentLive = Boolean(d ? isLiveUnsaved(d) : t.fromLive && !t.sourceName && !t.dirty);
                }
            }
            const isLive = !isDirty && isCurrentLive;
            const kindAttr = isDatabaseKind(t.kind) ? 'db:' + t.kind : t.kind;
            const lampHtml = isDirty
                ? '<span class="doc-tab-dirty" title="黄灯：已手动修改但尚未保存"></span>'
                : isLive
                  ? '<span class="doc-tab-live" title="绿灯：酒馆/数据库当前实际生效配置"></span>'
                  : '';
            return `
                <div class="doc-tab ${isActive ? 'active' : ''} ${isA ? 'is-compare-a active' : ''} ${isB ? 'is-compare-b active' : ''}"
                     role="tab" data-tab-id="${esc(t.id)}" data-tab-kind="${esc(kindAttr)}"
                     data-cmp-tag="${isA ? 'A' : isB ? 'B' : ''}"
                     title="${esc(KIND_LABEL[t.kind] + ' · ' + t.name)}${isDirty ? '（已手动修改未保存）' : isLive ? '（当前实际生效）' : ''}">
                    <span class="doc-tab-ico">${svg(tabIconName(t.kind), 14)}</span>
                    <span class="doc-tab-name">${esc(t.name)}</span>
                    ${lampHtml}
                    <button type="button" class="doc-tab-close" data-tab-close="${esc(t.id)}" title="关闭标签" aria-label="关闭 ${esc(t.name)}">${svg('close', 12)}</button>
                </div>`;
        })
        .join('');
    strip.scrollLeft = prevScrollLeft;

    tabCtrl.innerHTML =
        iconBtn('plus', '打开 / 新建标签页', 'data-top="new-tab"', 'tab-add-btn sm') +
        iconBtn(
            'closeAll',
            '一键关闭所有标签页',
            `data-top="close-all" ${state.tabs.length ? '' : 'disabled'}`,
            'sm',
        );

    const d = activeDraft();
    const isChatMode = navPaneMode === 'chats' && !state.compare.enabled;
    const canUndo = isChatMode ? chatCtrl.canUndo() : Boolean(d && d.cursor > 0);
    const canRedo = isChatMode ? chatCtrl.canRedo() : Boolean(d && d.cursor < (d.history?.length || 1) - 1);

    actBar.innerHTML =
        iconBtn(
            'character',
            '角色卡管理',
            'data-top="characters"',
            navPaneMode === 'characters' && !state.navCollapsed && !state.compare.enabled ? 'active' : '',
        ) +
        iconBtn(
            'chat',
            '聊天记录汇总管理',
            'data-top="chats"',
            navPaneMode === 'chats' && !state.navCollapsed && !state.compare.enabled ? 'active' : '',
        ) +
        iconBtn('compare', '双条目三栏对比模式', 'data-top="compare"', state.compare.enabled ? 'active' : '') +
        iconBtn('undo', '撤销 (Ctrl+Z)', `data-top="undo" ${canUndo ? '' : 'disabled'}`) +
        iconBtn('redo', '重做 (Ctrl+Y)', `data-top="redo" ${canRedo ? '' : 'disabled'}`) +
        iconBtn('ai', 'AI 编辑助手', 'data-top="ai"', state.inspectorTab === 'ai' && !state.compare.enabled ? 'active' : '') +
        iconBtn('more', '更多功能（开关 / 整理 / 备份 / 设置）', 'data-top="more-menu"') +
        iconBtn('close', '关闭工作台 (Esc)', 'data-top="close"');

    // 绑定标签页点击与右键菜单
    for (const el of $$('.doc-tab', strip)) {
        const id = el.dataset.tabId;
        el.onclick = (e) => {
            if (strip.dataset.dragMoved === '1') return;
            if (e.target.closest('[data-tab-close]')) return;
            const clickedTab = tabById(id);
            if (state.compare.enabled) {
                if (clickedTab && isCharacterKind(clickedTab.kind)) {
                    state.compare.enabled = false;
                    void activateTab(id);
                    return;
                }
                if (state.compare.leftTabId !== id && state.compare.rightTabId !== id) {
                    state.compare.rightTabId = id;
                    ensureDraftLoaded(id).then(() => {
                        persistMeta();
                        renderAll();
                    });
                }
            } else {
                void activateTab(id);
            }
        };
        el.oncontextmenu = (e) => {
            e.preventDefault();
            const ctxTab = tabById(id);
            const menuItems = [];
            if (ctxTab && !isCharacterKind(ctxTab.kind)) {
                menuItems.push(
                    {
                        icon: 'compare',
                        label: '设为对比左侧 (A)',
                        action: async () => {
                            state.compare.enabled = true;
                            state.compare.leftTabId = id;
                            await ensureDraftLoaded(id);
                            persistMeta();
                            renderAll();
                        },
                    },
                    {
                        icon: 'compare',
                        label: '设为对比右侧 (B)',
                        action: async () => {
                            state.compare.enabled = true;
                            state.compare.rightTabId = id;
                            await ensureDraftLoaded(id);
                            persistMeta();
                            renderAll();
                        },
                    },
                    '-',
                );
            }
            menuItems.push(
                {
                    icon: 'save',
                    label: '保存此标签',
                    action: async () => {
                        const doc = await ensureDraftLoaded(id);
                        await actions.saveDraft(doc, false);
                    },
                },
                {
                    icon: 'rename',
                    label: '重命名',
                    action: async () => {
                        const doc = await ensureDraftLoaded(id);
                        await actions.renameDocument(doc, tabById(id));
                    },
                },
                {
                    icon: 'trash',
                    label: ctxTab?.sourceName ? '删除此文档（含备份）' : '移除此标签',
                    danger: true,
                    action: async () => {
                        const doc = await ensureDraftLoaded(id);
                        await actions.deleteDocument(doc, tabById(id));
                    },
                },
                {
                    icon: 'close',
                    label: '关闭标签',
                    action: () => closeTab(id),
                },
            );
            showPopMenu({ x: e.clientX, y: e.clientY }, menuItems);
        };
    }
    for (const btn of $$('[data-tab-close]', strip)) {
        btn.onclick = (e) => {
            e.stopPropagation();
            void closeTab(btn.dataset.tabClose);
        };
    }

    $('[data-top="new-tab"]', tabCtrl).onclick = run(() => actions.openNewTabDialog(activeTab()?.kind || 'preset'));
    $('[data-top="close-all"]', tabCtrl).onclick = run(() => closeAllTabs());

    // 顶栏 SVG 按钮事件
    const topHandlers = {
        characters: async () => {
            state.compare.enabled = false;
            state.navCollapsed = false;
            navPaneMode = 'characters';
            state.mobilePane = 'nav';
            persistMeta();
            renderAll();
            await ensureCharacterCatalog(false);
        },
        chats: () => openAllChatsView(),
        compare: () => toggleCompareMode(),
        undo: () => {
            if (isChatMode) {
                chatCtrl.undo();
                return;
            }
            if (d && undo(d, -1)) {
                persistDraft(activeTab().id);
                renderAll();
            }
        },
        redo: () => {
            if (isChatMode) {
                chatCtrl.redo();
                return;
            }
            if (d && undo(d, 1)) {
                persistDraft(activeTab().id);
                renderAll();
            }
        },
        ai: () => {
            if (state.compare.enabled) state.compare.enabled = false;
            state.inspectorTab = state.inspectorTab === 'ai' ? 'content' : 'ai';
            state.mobilePane = 'inspector';
            renderAll();
        },
        'more-menu': (btn) => {
            const cur = activeDraft();
            const items = [
                { icon: 'power', label: '数据库功能开关（含未启用模块）', action: () => actions.openFeatureSwitchDialog() },
            ];
            if (cur) {
                if (!isCharacterKind(cur.kind)) {
                    items.push({
                        icon: 'tools',
                        label: isDatabaseKind(cur.kind) ? '运行配置 / 恢复默认' : '整理工具 / 体检',
                        action: () => actions.openToolsDialog(cur),
                    });
                }
                items.push({
                    icon: 'json',
                    label: '查看/编辑当前整份文档 JSON',
                    action: () => actions.openDocMetaJsonDialog(cur),
                });
            }
            items.push(
                '-',
                { icon: 'receipt', label: '备份与操作回执', action: () => actions.openReceiptsDialog() },
                { icon: 'settings', label: '工作台设置与主题', action: () => openSettings(env, runtime) },
            );
            showPopMenu(btn, items);
        },
        close: () => closeWorkbench(),
    };
    for (const btn of $$('[data-top]', actBar)) {
        btn.onclick = run(() => topHandlers[btn.dataset.top]?.(btn));
    }
}

function filteredSortedCharacters() {
    const rawItems = charCatalog?.items || [];
    const q = charSearch.trim().toLowerCase();
    const filtered = q
        ? rawItems.filter(
              (c) =>
                  (c.name || '').toLowerCase().includes(q) ||
                  (c.world || '').toLowerCase().includes(q) ||
                  (c.tags || []).some((t) => String(t).toLowerCase().includes(q)),
          )
        : rawItems;
    return sortCharacters(filtered, charSortMode, charSortDir);
}

function navModeHeaderHtml(activeMode) {
    return `
        <div class="panel-head">
            <div class="nav-mode-tabs is-three" role="tablist">
                <button type="button" class="nav-mode-tab ${activeMode === 'library' ? 'active' : ''}" data-nav-mode="library">${svg('folder', 13)} 预设库</button>
                <button type="button" class="nav-mode-tab ${activeMode === 'characters' ? 'active' : ''}" data-nav-mode="characters">${svg('character', 13)} 角色卡</button>
                <button type="button" class="nav-mode-tab ${activeMode === 'chats' ? 'active' : ''}" data-nav-mode="chats">${svg('chat', 13)} 聊天</button>
            </div>
        </div>
    `;
}

function bindNavModeSwitcher(col) {
    for (const b of $$('[data-nav-mode]', col)) {
        b.onclick = run(async () => {
            const next = b.dataset.navMode;
            if (next === navPaneMode) return;
            navPaneMode = next;
            if (next === 'chats') {
                chatCtrl.state.filterAvatar = '';
                chatCtrl.state.filterCharName = '';
            }
            renderAll();
            if (next === 'characters' && !charCatalog) await ensureCharacterCatalog(false);
            if (next === 'chats' && !chatCtrl.state.catalog) await chatCtrl.ensureCatalog(false);
        });
    }
}

function renderCharacterNavPanel(col, d) {
    if (!charCatalog && !charCatalogLoading) {
        void ensureCharacterCatalog(false);
    }
    const totalCount = charCatalog?.items?.length || 0;
    const validAvatarSet = new Set((charCatalog?.items || []).map((c) => c.avatar));
    for (const a of [...charSelectedAvatars]) if (!validAvatarSet.has(a)) charSelectedAvatars.delete(a);

    const drawList = () => {
        const listBox = $('[data-char-list-box]', col);
        const selAllBtn = $('[data-char-act="sel-all"]', col);
        const delBtn = $('[data-char-act="del-selected"]', col);
        const countEl = $('[data-char-count]', col);
        if (!listBox) return;

        const visible = filteredSortedCharacters();
        const visibleAvatars = visible.map((c) => c.avatar);
        const allVisibleSelected =
            visibleAvatars.length > 0 && visibleAvatars.every((a) => charSelectedAvatars.has(a));

        if (countEl) {
            countEl.textContent = charSearch.trim() ? `${visible.length}/${totalCount}` : String(totalCount);
        }
        if (selAllBtn) selAllBtn.textContent = allVisibleSelected ? '取消全选' : '全选';
        if (delBtn) {
            delBtn.disabled = charSelectedAvatars.size === 0;
            delBtn.innerHTML = `${svg('trash', 12)} 删除 (${charSelectedAvatars.size})`;
        }

        if (charCatalogLoading && !charCatalog) {
            listBox.innerHTML = '<p class="muted" style="padding:12px;text-align:center">正在加载角色卡列表…</p>';
            return;
        }
        if (!visible.length) {
            listBox.innerHTML = `<p class="muted" style="padding:12px;text-align:center">${totalCount ? '无匹配角色卡' : '暂无角色卡'}</p>`;
            return;
        }

        listBox.innerHTML = visible
            .map((c) => {
                const isCurTab = Boolean(d?.kind === 'character' && d?.avatar === c.avatar);
                const checked = charSelectedAvatars.has(c.avatar);
                const metaParts = [];
                if (c.world) metaParts.push(c.world);
                if (c.tags?.length) metaParts.push(c.tags.slice(0, 2).join(' · '));
                const subText = metaParts.join(' | ');
                const thumb = charThumbUrl(c.avatar);
                const body = `
                    <img class="char-thumb" src="${esc(thumb)}" alt="" loading="lazy">
                    <div class="char-list-meta">
                        <div class="char-list-name">
                            ${c.isCurrent ? '<span class="lamp-dot is-live" title="当前对话角色"></span>' : ''}
                            <span class="nav-item-label">${esc(c.name)}</span>
                        </div>
                        ${subText ? `<div class="char-list-sub" title="${esc(subText)}">${esc(subText)}</div>` : ''}
                    </div>`;
                if (charSelectMode) {
                    return `
                        <label class="nav-item char-list-item nav-item-check ${checked ? 'active' : ''}" title="${esc(c.name)}">
                            <input type="checkbox" data-char-pick="${esc(c.avatar)}" ${checked ? 'checked' : ''}>
                            ${body}
                        </label>`;
                }
                return `
                    <button type="button" class="nav-item char-list-item ${isCurTab ? 'active' : ''}" data-char-open="${esc(c.avatar)}" title="${esc(c.name)}${c.isCurrent ? '（当前对话）' : ''}">
                        ${body}
                    </button>`;
            })
            .join('');

        for (const chk of $$('[data-char-pick]', listBox)) {
            chk.onchange = () => {
                const av = chk.dataset.charPick;
                if (chk.checked) charSelectedAvatars.add(av);
                else charSelectedAvatars.delete(av);
                chk.closest('.char-list-item')?.classList.toggle('active', chk.checked);
                const vis = filteredSortedCharacters().map((x) => x.avatar);
                if (selAllBtn) {
                    selAllBtn.textContent = vis.length > 0 && vis.every((a) => charSelectedAvatars.has(a)) ? '取消全选' : '全选';
                }
                if (delBtn) {
                    delBtn.disabled = charSelectedAvatars.size === 0;
                    delBtn.innerHTML = `${svg('trash', 12)} 删除 (${charSelectedAvatars.size})`;
                }
            };
        }
        for (const btn of $$('[data-char-open]', listBox)) {
            btn.onclick = run(() => actions.openExistingTab('character', btn.dataset.charOpen));
        }
    };

    const bulkBar = charSelectMode
        ? `<div class="nav-select-bar">
               <button type="button" class="mini-btn" data-char-act="sel-all">全选</button>
               <button type="button" class="mini-btn danger" data-char-act="del-selected" ${charSelectedAvatars.size ? '' : 'disabled'}>${svg('trash', 12)} 删除 (${charSelectedAvatars.size})</button>
           </div>`
        : '';

    col.innerHTML = `
        ${navModeHeaderHtml('characters')}
        <div class="panel-subbar char-nav-tools">
            <span class="muted" style="font-size:11.5px">共 <strong data-char-count>${totalCount}</strong> 张</span>
            <div class="row" style="gap:3px">
                ${iconBtn('import', '导入角色卡文件 (PNG / JSON / YAML)', 'data-char-act="import"', 'sm')}
                ${iconBtn('plus', '新建空白角色卡草稿', 'data-char-act="new"', 'sm')}
                ${iconBtn('refresh', '刷新角色卡列表', 'data-char-act="refresh"', 'sm')}
            </div>
        </div>
        <div class="char-sort-bar">
            <select data-char-sort title="角色卡排序方式">
                <option value="name" ${charSortMode === 'name' ? 'selected' : ''}>字母排序</option>
                <option value="date_added" ${charSortMode === 'date_added' ? 'selected' : ''}>导入时间排序</option>
                <option value="date_last_chat" ${charSortMode === 'date_last_chat' ? 'selected' : ''}>最近游玩排序</option>
            </select>
            <button type="button" class="mini-btn" data-char-sort-dir title="切换升序 / 降序">${charSortDir === 'asc' ? '升序 ↑' : '降序 ↓'}</button>
        </div>
        <div class="char-search-wrap nav-search-row">
            <input type="search" data-char-search placeholder="搜索角色名 / 标签 / 世界书…" value="${esc(charSearch)}">
            <button type="button" class="nav-sel-toggle ${charSelectMode ? 'active' : ''}" data-char-act="toggle-select" title="${charSelectMode ? '退出选择模式' : '批量选择与删除角色卡'}">${charSelectMode ? '取消' : '选择'}</button>
        </div>
        ${bulkBar}
        <div class="panel-scroll">
            <div class="nav-list char-nav-list" data-char-list-box></div>
        </div>
    `;

    bindNavModeSwitcher(col);
    drawList();

    const sortSel = $('[data-char-sort]', col);
    if (sortSel) {
        sortSel.onchange = () => {
            charSortMode = sortSel.value;
            // 字母默认升序，时间类默认降序（最新在前），用户仍可随时翻转
            charSortDir = charSortMode === 'name' ? 'asc' : 'desc';
            const dirBtn = $('[data-char-sort-dir]', col);
            if (dirBtn) dirBtn.textContent = charSortDir === 'asc' ? '升序 ↑' : '降序 ↓';
            drawList();
        };
    }
    const dirBtn = $('[data-char-sort-dir]', col);
    if (dirBtn) {
        dirBtn.onclick = () => {
            charSortDir = charSortDir === 'asc' ? 'desc' : 'asc';
            dirBtn.textContent = charSortDir === 'asc' ? '升序 ↑' : '降序 ↓';
            drawList();
        };
    }
    const sInp = $('[data-char-search]', col);
    if (sInp) {
        let comp = false;
        sInp.addEventListener('compositionstart', () => (comp = true));
        sInp.addEventListener('compositionend', () => {
            comp = false;
            charSearch = sInp.value;
            drawList();
        });
        sInp.addEventListener('input', () => {
            if (!comp) {
                charSearch = sInp.value;
                drawList();
            }
        });
    }

    for (const b of $$('[data-char-act]', col)) {
        b.onclick = run(async () => {
            const act = b.dataset.charAct;
            if (act === 'toggle-select') {
                charSelectMode = !charSelectMode;
                if (!charSelectMode) charSelectedAvatars.clear();
                renderNavPanel();
                return;
            }
            if (act === 'sel-all') {
                const vis = filteredSortedCharacters().map((c) => c.avatar);
                const allSel = vis.length > 0 && vis.every((a) => charSelectedAvatars.has(a));
                if (allSel) {
                    for (const a of vis) charSelectedAvatars.delete(a);
                } else {
                    for (const a of vis) charSelectedAvatars.add(a);
                }
                drawList();
                return;
            }
            if (act === 'del-selected') {
                const ok = await actions.batchDeleteCharacters([...charSelectedAvatars]);
                if (ok) {
                    charSelectedAvatars.clear();
                    charSelectMode = false;
                    renderAll();
                }
                return;
            }
            if (act === 'import') {
                await actions.importCharacterFile(null, false);
                return;
            }
            if (act === 'new') {
                await actions.createNewDocumentTab('character');
                return;
            }
            if (act === 'refresh') {
                await ensureCharacterCatalog(true);
                notify('角色卡列表已刷新');
            }
        });
    }
}

function renderNavPanel() {
    if (state.compare.enabled) return;
    const col = $('#pww-col-a');
    if (!col) return;
    const tab = activeTab();
    const d = activeDraft();
    if (navPaneMode === 'chats') {
        chatCtrl.renderNav(col, navModeHeaderHtml('chats'), bindNavModeSwitcher);
        return;
    }
    if (navPaneMode === 'characters') {
        renderCharacterNavPanel(col, d);
        return;
    }

    const v = tabView(tab);
    const isCharActive = Boolean(d && isCharacterKind(d.kind));
    const all = d && !isCharActive ? entries(d) : [];

    const presets = runtime.lists?.presets || [];
    const worlds = runtime.lists?.worldbooks || [];
    const curKind = !tab || isCharacterKind(tab.kind) ? 'preset' : tab.kind;
    const isDb = isDatabaseKind(curKind);

    let filterSection = '';
    if (d && !isCharActive) {
        const filters = [
            ['all', '全部'],
            ['enabled', '已启用'],
            ['disabled', '已关闭'],
            ['selected', `已选(${d.selected.length})`],
            ...(d.kind === 'preset'
                ? [
                      ['ordered', '顺序链'],
                      ['injected', '自动注入'],
                  ]
                : d.kind === 'worldbook'
                  ? [
                        ['constant', '绿灯'],
                        ['selective', '蓝灯'],
                        ['vectorized', '向量'],
                    ]
                  : []),
        ];
        filterSection = `
            <div class="nav-section">
                <div class="nav-section-head"><span>状态筛选</span><span>${all.length}</span></div>
                <div class="filter-chips">
                    ${filters
                        .map(
                            ([k, l]) =>
                                `<button type="button" class="chip ${v.status === k ? 'active' : ''}" data-nav-filter="${k}">${l}</button>`,
                        )
                        .join('')}
                </div>
            </div>
        `;
    }

    let groupSection = '';
    if (d && !isDb && !isCharActive) {
        const groups =
            d.kind === 'worldbook'
                ? folderMeta(d.raw).folders
                : d.raw.extensions?.presetWorldbookWorkbench?.folders || [];
        const groupCounts = new Map();
        for (const e of all) {
            if (e.group) groupCounts.set(e.group, (groupCounts.get(e.group) || 0) + 1);
        }
        groupSection = `
            <div class="nav-section">
                <div class="nav-section-head">
                    <span>分组目录</span>
                    ${iconBtn('plus', '新建分组', 'data-nav-act="new-folder"', 'sm')}
                </div>
                <div class="nav-list">
                    <button type="button" class="nav-item ${!v.folder ? 'active' : ''}" data-nav-folder="">
                        <span class="nav-item-label">全部分组</span><span class="nav-badge">${all.length}</span>
                    </button>
                    ${groups
                        .map(
                            (g) => `
                        <button type="button" class="nav-item ${v.folder === g.id ? 'active' : ''}" data-nav-folder="${esc(g.id)}">
                            <span class="nav-item-label">${esc(g.name)}</span>
                            <span class="nav-badge">${groupCounts.get(g.id) || 0}</span>
                        </button>`,
                        )
                        .join('')}
                </div>
            </div>
        `;
    } else if (d && isPromptKind(d.kind)) {
        groupSection = `
            <div class="nav-section">
                <div class="nav-section-head"><span>提示词分组</span></div>
                <div class="nav-list">
                    <button type="button" class="nav-item ${!v.group ? 'active' : ''}" data-nav-group="">
                        <span class="nav-item-label">全部分组</span><span class="nav-badge">${all.length}</span>
                    </button>
                    ${Object.keys(d.raw.groups)
                        .map(
                            (k) => `
                        <button type="button" class="nav-item ${v.group === k ? 'active' : ''}" data-nav-group="${esc(k)}">
                            <span class="nav-item-label">${esc(prompts.groupLabel(k))}</span>
                            <span class="nav-badge">${d.raw.groups[k].length}</span>
                        </button>`,
                        )
                        .join('')}
                </div>
            </div>
        `;
    }

    // 预设库列表（去掉 · 预设库后缀，支持选择/取消与批量删除）
    const dbCat = isDb ? dbCatalogCache.get(curKind) || { items: [], activeName: '', matchedActive: false } : null;
    const dbItems = dbCat?.items || [];
    const showUnmatchedLiveRow = Boolean(isDb && !dbCat?.matchedActive);
    const curPresetName = runtime.lists?.currentPreset || '';

    const selectableNames = isDb
        ? dbItems.map((i) => i.name)
        : curKind === 'worldbook'
          ? worlds
          : presets;
    // 清理已经不在列表中的选中项
    for (const n of [...navSelectedNames]) if (!selectableNames.includes(n)) navSelectedNames.delete(n);

    const listTitle = isDb ? KIND_LABEL[curKind] : curKind === 'worldbook' ? '世界书' : '预设';
    const rawLibEntries = isDb
        ? dbItems.map((item) => ({ name: item.name, isActive: Boolean(item.isActive) }))
        : selectableNames.map((name) => ({ name, isActive: curKind === 'preset' && name === curPresetName }));

    const getVisibleLibEntries = () => {
        const q = navLibSearch.trim().toLowerCase();
        let arr = q ? rawLibEntries.filter((x) => x.name.toLowerCase().includes(q)) : [...rawLibEntries];
        if (navLibSortMode === 'name') {
            const mult = navLibSortDir === 'desc' ? -1 : 1;
            arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) * mult);
        } else if (navLibSortDir === 'desc') {
            arr.reverse();
        }
        return arr;
    };

    const initialVis = getVisibleLibEntries();
    const initialAllSel = initialVis.length > 0 && initialVis.every((x) => navSelectedNames.has(x.name));
    const selectBulkBar = navSelectMode
        ? `<div class="nav-select-bar">
               <button type="button" class="mini-btn" data-nav-act="sel-all">${initialAllSel ? '取消全选' : '全选'}</button>
               <button type="button" class="mini-btn danger" data-nav-act="del-selected" ${navSelectedNames.size ? '' : 'disabled'}>${svg('trash', 12)} 删除 (${navSelectedNames.size})</button>
           </div>`
        : '';

    const renderLibItem = (name, isActiveLive) => {
        const checked = navSelectedNames.has(name);
        if (navSelectMode) {
            return `
                <label class="nav-item nav-item-check ${checked ? 'active' : ''}" title="${esc(name)}">
                    <input type="checkbox" data-nav-pick="${esc(name)}" ${checked ? 'checked' : ''}>
                    ${isActiveLive ? '<span class="lamp-dot is-live" title="当前实际生效"></span>' : ''}
                    <span class="nav-item-label">${esc(name)}</span>
                </label>`;
        }
        return `
            <button type="button" class="nav-item ${d?.sourceName === name ? 'active' : ''}" data-nav-open-kind="${esc(curKind)}" data-nav-open-name="${esc(name)}" title="${esc(name)}${isActiveLive ? '（当前实际生效）' : ''}">
                ${isActiveLive ? '<span class="lamp-dot is-live" title="当前实际生效"></span>' : ''}
                <span class="nav-item-label">${esc(name)}</span>
            </button>`;
    };

    const drawLibListHtml = () => {
        const vis = getVisibleLibEntries();
        return (
            (showUnmatchedLiveRow && !navSelectMode && !navLibSearch.trim()
                ? `<button type="button" class="nav-item ${d?.fromLive && !d?.sourceName ? 'active' : ''}" data-nav-live="${esc(curKind)}" title="当前数据库实际生效配置（尚未保存到预设库）">
                       <span class="lamp-dot is-live"></span>
                       <span class="nav-item-label">当前实际生效</span>
                   </button>`
                : '') +
            (vis.length
                ? vis.map((item) => renderLibItem(item.name, item.isActive)).join('')
                : `<span class="muted" style="padding:4px 6px">${rawLibEntries.length ? '无匹配项' : isDb ? '暂无命名项' : '列表为空'}</span>`)
        );
    };

    const countText = navLibSearch.trim()
        ? `${initialVis.length}/${rawLibEntries.length}`
        : String(rawLibEntries.length);

    col.innerHTML = `
        ${navModeHeaderHtml('library')}
        <div class="panel-subbar char-nav-tools">
            <span class="muted" style="font-size:11.5px">${esc(listTitle)} 共 <strong data-lib-count>${countText}</strong> 项</span>
            <div class="row" style="gap:3px">
                ${iconBtn('import', `导入${listTitle}文件到新标签`, 'data-nav-act="import-lib"', 'sm')}
                ${iconBtn('plus', `新建空白/默认${listTitle}`, 'data-nav-act="new-lib"', 'sm')}
                ${iconBtn('refresh', '刷新列表', 'data-nav-act="refresh-lib"', 'sm')}
            </div>
        </div>
        <div class="char-sort-bar">
            <select data-nav-lib-sort title="排序方式">
                <option value="default" ${navLibSortMode === 'default' ? 'selected' : ''}>默认顺序</option>
                <option value="name" ${navLibSortMode === 'name' ? 'selected' : ''}>字母排序</option>
            </select>
            <button type="button" class="mini-btn" data-nav-lib-dir title="切换升序 / 降序">${navLibSortDir === 'asc' ? '升序 ↑' : '降序 ↓'}</button>
        </div>
        <div class="char-search-wrap nav-search-row">
            <input type="search" data-nav-lib-search placeholder="搜索${esc(listTitle)}…" value="${esc(navLibSearch)}">
            <button type="button" class="nav-sel-toggle ${navSelectMode ? 'active' : ''}" data-nav-act="toggle-select" title="${navSelectMode ? '退出多选模式' : '批量选择并删除'}">${navSelectMode ? '取消' : '选择'}</button>
        </div>
        ${selectBulkBar}
        <div class="panel-scroll">
            <div class="nav-section">
                <div class="nav-list" data-nav-lib-list>
                    ${drawLibListHtml()}
                </div>
            </div>
            ${filterSection}
            ${groupSection}
        </div>
    `;

    bindNavModeSwitcher(col);

    for (const b of $$('[data-nav-filter]', col)) {
        b.onclick = () => {
            if (!tab) return;
            tabView(tab).status = b.dataset.navFilter;
            persistMeta();
            renderNavPanel();
            renderSingleListPanel();
        };
    }
    for (const b of $$('[data-nav-folder]', col)) {
        b.onclick = () => {
            if (!tab) return;
            tabView(tab).folder = b.dataset.navFolder;
            persistMeta();
            renderNavPanel();
            renderSingleListPanel();
        };
    }
    for (const b of $$('[data-nav-group]', col)) {
        b.onclick = () => {
            if (!tab) return;
            tabView(tab).group = b.dataset.navGroup;
            persistMeta();
            renderNavPanel();
            renderSingleListPanel();
        };
    }
    const wireLibListEvents = () => {
        const libBox = $('[data-nav-lib-list]', col);
        if (!libBox) return;
        for (const chk of $$('[data-nav-pick]', libBox)) {
            chk.onchange = () => {
                const name = chk.dataset.navPick;
                if (chk.checked) navSelectedNames.add(name);
                else navSelectedNames.delete(name);
                renderNavPanel();
            };
        }
        for (const b of $$('[data-nav-open-name]', libBox)) {
            b.onclick = run(() => actions.openExistingTab(b.dataset.navOpenKind, b.dataset.navOpenName));
        }
        for (const b of $$('[data-nav-live]', libBox)) {
            b.onclick = run(() => actions.loadCurrentPromptTab(b.dataset.navLive));
        }
    };
    wireLibListEvents();

    const redrawLibList = () => {
        const libBox = $('[data-nav-lib-list]', col);
        if (!libBox) return;
        const vis = getVisibleLibEntries();
        const cnt = $('[data-lib-count]', col);
        if (cnt) {
            cnt.textContent = navLibSearch.trim() ? `${vis.length}/${rawLibEntries.length}` : String(rawLibEntries.length);
        }
        const selAllBtn = $('[data-nav-act="sel-all"]', col);
        if (selAllBtn) {
            const allSel = vis.length > 0 && vis.every((x) => navSelectedNames.has(x.name));
            selAllBtn.textContent = allSel ? '取消全选' : '全选';
        }
        libBox.innerHTML = drawLibListHtml();
        wireLibListEvents();
    };
    const libSortSel = $('[data-nav-lib-sort]', col);
    if (libSortSel) {
        libSortSel.onchange = () => {
            navLibSortMode = libSortSel.value;
            redrawLibList();
        };
    }
    const libDirBtn = $('[data-nav-lib-dir]', col);
    if (libDirBtn) {
        libDirBtn.onclick = () => {
            navLibSortDir = navLibSortDir === 'asc' ? 'desc' : 'asc';
            libDirBtn.textContent = navLibSortDir === 'asc' ? '升序 ↑' : '降序 ↓';
            redrawLibList();
        };
    }
    const libSearchInp = $('[data-nav-lib-search]', col);
    if (libSearchInp) {
        let comp = false;
        libSearchInp.addEventListener('compositionstart', () => (comp = true));
        libSearchInp.addEventListener('compositionend', () => {
            comp = false;
            navLibSearch = libSearchInp.value;
            redrawLibList();
        });
        libSearchInp.addEventListener('input', () => {
            if (!comp) {
                navLibSearch = libSearchInp.value;
                redrawLibList();
            }
        });
    }
    for (const b of $$('[data-nav-act]', col)) {
        b.onclick = run(async () => {
            const act = b.dataset.navAct;
            if (act === 'new-folder') return actions.editFoldersDialog(d);
            if (act === 'import-lib') return actions.importDocumentTab(curKind);
            if (act === 'new-lib') return actions.createNewDocumentTab(curKind);
            if (act === 'toggle-select') {
                navSelectMode = !navSelectMode;
                if (!navSelectMode) navSelectedNames.clear();
                renderNavPanel();
                return;
            }
            if (act === 'sel-all') {
                const visNames = getVisibleLibEntries().map((x) => x.name);
                const allSel = visNames.length > 0 && visNames.every((n) => navSelectedNames.has(n));
                if (allSel) {
                    for (const n of visNames) navSelectedNames.delete(n);
                } else {
                    for (const n of visNames) navSelectedNames.add(n);
                }
                renderNavPanel();
                return;
            }
            if (act === 'del-selected') {
                const ok = await actions.batchDeleteLibrary(curKind, [...navSelectedNames]);
                if (ok) {
                    navSelectedNames.clear();
                    navSelectMode = false;
                    if (isDb) {
                        const r = await dbCall('list', { kind: curKind });
                        dbCatalogCache.set(curKind, r || { items: [], activeName: '', matchedActive: false });
                    }
                    renderAll();
                }
                return;
            }
            if (act === 'refresh-lib') {
                if (isDb) {
                    const r = await dbCall('list', { kind: curKind });
                    dbCatalogCache.set(curKind, r || { items: [], activeName: '', matchedActive: false });
                } else {
                    runtime.lists = await rpc('documents.list', { refresh: true });
                }
                renderNavPanel();
                renderHeaderTabs();
                notify('列表已刷新');
            }
        });
    }
}

function buildCardLookup(d) {
    const selectedSet = new Set(d.selected || []);
    let activeUidSet = null;
    if (d.kind === 'worldbook' && runtime.activeEntries?.length) {
        activeUidSet = new Set();
        for (const a of runtime.activeEntries) {
            if (!a.world || a.world === d.name) activeUidSet.add(a.uid);
        }
    }
    return { selectedSet, activeUidSet };
}

function cardHtml(d, e, { isActive, isSearchFocus, query, pairStatus, sideTag = '', lookup = null }) {
    const isDb = isDatabaseKind(d.kind);
    const isChar = isCharacterKind(d.kind);
    const canToggle = isChar ? false : isDb ? Boolean(e.toggleable) : canToggleEntry(e);
    const canDrag = isChar ? Boolean(e.isAltGreeting) : true;
    const roleBarCls =
        e.role === 'user' || e.role === 'USER'
            ? 'role-user'
            : e.role === 'assistant' || e.role === 'ASSISTANT'
              ? 'role-assistant'
              : Number(e.raw.injection_position) === 1
                ? 'role-inject'
                : '';
    const isSelected = lookup ? lookup.selectedSet.has(e.id) : d.selected.includes(e.id);
    const isActivated = lookup
        ? Boolean(lookup.activeUidSet?.has(e.id))
        : d.kind === 'worldbook' &&
          runtime.activeEntries?.some((a) => a.uid === e.id && (!a.world || a.world === d.name));
    const badges = [];
    let wbLampHtml = '';
    if (d.kind === 'preset') {
        if (Number(e.raw.injection_position) === 1) {
            badges.push(`<span class="badge">D:${e.raw.injection_depth ?? 4}</span>`);
            badges.push(`<span class="badge">O:${e.raw.injection_order ?? 100}</span>`);
        }
        if (e.marker) badges.push('<span class="badge">占位</span>');
    } else if (d.kind === 'worldbook') {
        wbLampHtml = worldStrategyBtnHtml(e.strategy, `data-card-wb-lamp="${esc(e.id)}"`);
        badges.push(`<span class="badge">O:${e.raw.order ?? 100}</span>`);
    } else if (isChar) {
        if (e.isAltGreeting) badges.push('<span class="badge">备选</span>');
        badges.push(`<span class="badge">${(e.content || '').length} 字</span>`);
    } else if (isPromptKind(d.kind)) {
        badges.push(`<span class="badge">${esc(e.groupLabel)}</span>`);
    }
    if (pairStatus && pairStatus !== 'same') {
        const map = {
            content: ['正文不同', 'badge-diff-content'],
            settings: ['设置不同', 'badge-diff-settings'],
            added: ['新增', 'badge-diff-added'],
            removed: ['独有', 'badge-diff-removed'],
        };
        const [txt, cls] = map[pairStatus] || [];
        if (txt) badges.push(`<span class="badge ${cls}">${txt}</span>`);
    }
    const titleHtml = query ? highlightHtml(e.name, query) : esc(e.name);
    const snippet = e.content ? e.content.replace(/\s+/g, ' ').slice(0, 60) : '';
    const snippetHtml = query && snippet ? highlightHtml(snippet, query) : esc(snippet);

    return `
        <article class="prompt-card ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''} ${!e.enabled ? 'is-disabled' : ''} ${isSearchFocus ? 'is-search-focus' : ''} ${isActivated ? 'is-activated' : ''}"
                 data-entry-id="${esc(e.id)}" data-side-tag="${esc(sideTag)}" draggable="${canDrag ? 'true' : 'false'}">
            ${
                canDrag
                    ? `<button type="button" class="card-grip" data-grip="${esc(e.id)}" title="拖动排序或跨栏复制">${svg('grip', 13)}</button>`
                    : '<span class="card-grip-placeholder"></span>'
            }
            ${
                isChar
                    ? '<span></span>'
                    : `<label class="card-check"><input type="checkbox" data-check="${esc(e.id)}" ${isSelected ? 'checked' : ''}></label>`
            }
            <span class="role-bar ${roleBarCls}"></span>
            <div class="card-main" data-open-entry="${esc(e.id)}">
                <div class="card-title-row">
                    ${wbLampHtml}
                    <span class="card-title" title="${esc(e.name)}">${titleHtml}</span>
                </div>
                <div class="card-sub-row">
                    ${badges.join('')}
                    ${snippetHtml ? `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px">${snippetHtml}</span>` : ''}
                </div>
            </div>
            ${
                canToggle
                    ? `<label class="mini-switch" title="启用/禁用"><input type="checkbox" data-toggle="${esc(e.id)}" ${e.enabled ? 'checked' : ''}><span></span></label>`
                    : '<span></span>'
            }
            ${iconBtn('more', '更多操作', `data-card-more="${esc(e.id)}"`, 'sm')}
        </article>
    `;
}

function getWindowLimit(tabId, key, list, focusIds = []) {
    let win = listWindowState.get(tabId);
    if (!win || win.key !== key) {
        win = { key, limit: LIST_WINDOW_INIT };
        listWindowState.set(tabId, win);
    }
    for (const fid of focusIds) {
        if (!fid) continue;
        const pos = list.findIndex((e) => e.id === fid);
        if (pos >= win.limit) win.limit = Math.min(list.length, pos + 30);
    }
    return win;
}

function buildWindowedListHtml(tab, d, list, v, focusedHitId) {
    const lookup = buildCardLookup(d);
    if (d.kind === 'preset' && v.status !== 'ordered' && v.status !== 'injected') {
        const seq = list.filter((e) => Number(e.raw.injection_position || 0) !== 1);
        const inj = list.filter((e) => Number(e.raw.injection_position) === 1);
        return {
            html: `
            <section class="chain-lane">
                <header class="lane-heading">
                    <span class="lane-icon">${svg('chain', 14)}</span>
                    <div class="lane-meta"><h3>顺序流程</h3><p>按列表顺序进入上下文</p></div>
                    <span class="lane-count">${seq.length}</span>
                    ${iconBtn('plus', '新建顺序提示词', 'data-doc-act="add-seq"', 'sm')}
                </header>
                <div class="entry-list">
                    ${seq.map((e) => cardHtml(d, e, { isActive: tab.activeEntryId === e.id, isSearchFocus: focusedHitId === e.id, query: v.search, lookup })).join('') || '<p class="muted" style="padding:8px">顺序链为空</p>'}
                </div>
            </section>
            <div class="chain-divider"><span>CONTEXT INJECTION</span></div>
            <section class="chain-lane">
                <header class="lane-heading is-inject">
                    <span class="lane-icon">${svg('inject', 14)}</span>
                    <div class="lane-meta"><h3>自动注入</h3><p>Depth / Order 决定插入位置</p></div>
                    <span class="lane-count">${inj.length}</span>
                    ${iconBtn('plus', '新建自动注入提示词', 'data-doc-act="add-inj"', 'sm')}
                </header>
                <div class="entry-list">
                    ${inj.map((e) => cardHtml(d, e, { isActive: tab.activeEntryId === e.id, isSearchFocus: focusedHitId === e.id, query: v.search, lookup })).join('') || '<p class="muted" style="padding:8px">没有自动注入项</p>'}
                </div>
            </section>`,
            hasMore: false,
            renderedCount: list.length,
        };
    }

    const winKey = `${v.status}|${v.folder}|${v.group}|${v.searchMode}|${v.sort}|${v.search}|${list.length}`;
    const win = getWindowLimit(tab.id, winKey, list, [tab.activeEntryId, focusedHitId]);
    const slice = list.length > LIST_WINDOW_INIT ? list.slice(0, win.limit) : list;
    const hasMore = slice.length < list.length;
    const moreBar = hasMore
        ? `<div class="list-window-more" data-window-more>
               <span class="muted">已显示 ${slice.length} / ${list.length} 条</span>
               <div class="row" style="gap:6px">
                   <button type="button" data-load-more>继续加载 ${Math.min(LIST_WINDOW_STEP, list.length - slice.length)} 条</button>
                   <button type="button" data-load-all>显示全部</button>
               </div>
           </div>`
        : '';
    return {
        html:
            `<div class="entry-list" data-window-list>${
                slice
                    .map((e) => cardHtml(d, e, { isActive: tab.activeEntryId === e.id, isSearchFocus: focusedHitId === e.id, query: v.search, lookup }))
                    .join('') || '<p class="muted" style="padding:14px;text-align:center">没有符合条件的条目</p>'
            }</div>` + moreBar,
        hasMore,
        renderedCount: slice.length,
        win,
    };
}

function attachWindowScrollLoader(col, tab, d, list, v, focusedHitId, win) {
    const scrollBox = $('[data-list-scroll]', col);
    if (!scrollBox || !win) return;
    let rendered = Math.min(win.limit, list.length);

    const appendChunk = (targetLimit) => {
        const listEl = $('[data-window-list]', scrollBox);
        const moreEl = $('[data-window-more]', scrollBox);
        if (!listEl || rendered >= list.length) return;
        const nextEnd = Math.min(list.length, targetLimit);
        const fragHtml = list
            .slice(rendered, nextEnd)
            .map((e) => cardHtml(d, e, { isActive: tab.activeEntryId === e.id, isSearchFocus: focusedHitId === e.id, query: v.search }))
            .join('');
        listEl.insertAdjacentHTML('beforeend', fragHtml);
        rendered = nextEnd;
        win.limit = rendered;
        if (moreEl) {
            if (rendered >= list.length) moreEl.remove();
            else {
                const span = $('span', moreEl);
                if (span) span.textContent = `已显示 ${rendered} / ${list.length} 条`;
                const btn = $('[data-load-more]', moreEl);
                if (btn) btn.textContent = `继续加载 ${Math.min(LIST_WINDOW_STEP, list.length - rendered)} 条`;
            }
        }
    };

    const loadMoreBtn = $('[data-load-more]', scrollBox);
    if (loadMoreBtn) loadMoreBtn.onclick = () => appendChunk(rendered + LIST_WINDOW_STEP);
    const loadAllBtn = $('[data-load-all]', scrollBox);
    if (loadAllBtn) loadAllBtn.onclick = () => appendChunk(list.length);

    if (rendered < list.length) {
        let ticking = false;
        scrollBox.onscroll = () => {
            if (ticking || rendered >= list.length) return;
            ticking = true;
            requestAnimationFrame(() => {
                ticking = false;
                if (scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 260) {
                    appendChunk(rendered + LIST_WINDOW_STEP);
                }
            });
        };
    } else {
        scrollBox.onscroll = null;
    }
}

function buildCharacterHeroHtml(d) {
    if (!d || !isCharacterKind(d.kind)) return '';
    const data = d.raw?.data || {};
    const primaryWorld = data.extensions?.world || '';
    const auxWorlds = d.charAuxWorlds || [];
    const tags = d.charTags || [];
    const metaBits = [
        data.creator ? '作者：' + data.creator : '',
        data.character_version ? '版本：' + data.character_version : '',
    ].filter(Boolean);
    const thumb = d.avatar ? charThumbUrl(d.avatar, d.avatarVersion) : '';
    const worldCount = (primaryWorld ? 1 : 0) + auxWorlds.length;
    return `
        <section class="char-hero-card">
            <button type="button" class="char-hero-avatar" data-hero-act="edit-avatar" title="${d.avatar ? '点击更换角色卡图片' : '保存角色卡后可更换图片'}" ${d.avatar ? '' : 'disabled'}>
                ${thumb ? `<img src="${esc(thumb)}" alt="${esc(d.name)}">` : svg('character', 26)}
                <span class="char-hero-avatar-mask">${svg('image', 13)} 改图</span>
            </button>
            <div class="char-hero-info">
                <div class="char-hero-top">
                    <strong class="char-hero-name" title="${esc(d.name)}">${esc(d.name)}</strong>
                    ${metaBits.length ? `<span class="muted" style="font-size:11px">${esc(metaBits.join(' · '))}</span>` : ''}
                </div>
                <div class="char-hero-row">
                    <span class="char-hero-label">${svg('worldbook', 12)} 世界书：</span>
                    ${
                        primaryWorld
                            ? `<button type="button" class="chip active" data-hero-act="jump-world" title="点击跳转到绑定世界书「${esc(primaryWorld)}」">${esc(primaryWorld)}${auxWorlds.length ? ` +${auxWorlds.length}` : ''} ${svg('external', 11)}</button>`
                            : auxWorlds.length
                              ? `<button type="button" class="chip active" data-hero-act="jump-world" title="点击跳转到附加世界书">附加 ${auxWorlds.length} 本 ${svg('external', 11)}</button>`
                              : '<span class="muted" style="font-size:11.5px">未绑定</span>'
                    }
                    <button type="button" class="mini-btn" data-hero-act="bind-world" ${d.avatar ? '' : 'disabled'}>${svg('link', 12)} ${worldCount ? '修改绑定' : '绑定世界书'}</button>
                    <button type="button" class="mini-btn" data-hero-act="edit-tags" ${d.avatar ? '' : 'disabled'}>${svg('tag', 12)} 标签 (${tags.length})</button>
                    <button type="button" class="mini-btn" data-hero-act="open-chats" ${d.avatar ? '' : 'disabled'}>${svg('chat', 12)} 聊天记录</button>
                </div>
                ${
                    tags.length
                        ? `<div class="char-hero-tags">${tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</div>`
                        : ''
                }
            </div>
        </section>
    `;
}

function renderSingleListPanel() {
    if (state.compare.enabled) return;
    const col = $('#pww-col-b');
    if (!col) return;
    if (navPaneMode === 'chats') {
        chatCtrl.renderMiddle(col);
        return;
    }
    const tab = activeTab();
    const d = activeDraft();
    if (!tab || !d) {
        col.innerHTML = `
            <div class="panel-head">
                <div class="panel-head-title">${svg('chain', 15)}<h2>工作区</h2></div>
                <div class="panel-head-actions">${iconBtn('plus', '打开/新建文档', 'data-doc-act="open"', 'sm primary')}</div>
            </div>
            <div class="panel-subbar"><span class="muted">支持多标签同时编辑预设、世界书、角色卡、聊天记录与数据库</span></div>
            <div class="panel-scroll" style="display:flex">
                <div class="inspector-empty">
                    ${svg('preset', 34)}
                    <h3 style="margin:4px 0">酒馆工作台 0.7.1</h3>
                    <p>点击顶部 <strong>+</strong> 或左侧「预设库 / 角色卡 / 聊天」开始管理；关闭工作台后台零占用。</p>
                    <div class="row">
                        <button type="button" class="primary" data-doc-act="open">${svg('plus', 14)} 打开预设 / 文档</button>
                        <button type="button" data-doc-act="browse-chars">${svg('character', 14)} 管理角色卡</button>
                        <button type="button" data-doc-act="browse-chats">${svg('chat', 14)} 聊天记录汇总</button>
                    </div>
                </div>
            </div>
        `;
        for (const b of $$('[data-doc-act="open"]', col)) b.onclick = run(() => actions.openNewTabDialog('preset'));
        for (const b of $$('[data-doc-act="browse-chars"]', col)) {
            b.onclick = run(async () => {
                state.navCollapsed = false;
                navPaneMode = 'characters';
                state.mobilePane = 'nav';
                renderAll();
                await ensureCharacterCatalog(false);
            });
        }
        for (const b of $$('[data-doc-act="browse-chats"]', col)) {
            b.onclick = run(() => openAllChatsView());
        }
        return;
    }

    const v = tabView(tab);
    const list = filteredEntries(d, v);
    const hits = collectEntrySearchHits(list, v.search);
    if (hits.length && v.hitCursor >= hits.length) v.hitCursor = 0;
    const focusedHitId = hits.length ? hits[v.hitCursor]?.id : null;
    const isDb = isDatabaseKind(d.kind);
    const isChar = isCharacterKind(d.kind);
    const prevScroll = $('[data-list-scroll]', col)?.scrollTop || 0;

    const built = buildWindowedListHtml(tab, d, list, v, focusedHitId);

    const bulkBar = !isChar && d.selected.length
        ? `<div class="bulk-bar">
              <span>已选 <strong>${d.selected.length}</strong> 条</span>
              <div class="bulk-bar-actions">
                  ${iconBtn('apply', '批量启用', 'data-bulk="on"', 'sm')}
                  ${iconBtn('power', '批量禁用', 'data-bulk="off"', 'sm')}
                  ${iconBtn('copy', '批量复制副本', 'data-bulk="dup"', 'sm')}
                  ${iconBtn('trash', '批量删除', 'data-bulk="del"', 'sm danger')}
                  ${iconBtn('close', '取消选择', 'data-bulk="clear"', 'sm')}
              </div>
          </div>`
        : '';

    const isDirtyNow = dirty(d);
    const isLiveNow = isLiveUnsaved(d);
    const statusBadge = isDirtyNow
        ? '<span class="badge badge-dirty" title="黄灯：已手动修改，尚未保存"><span class="lamp-dot is-dirty"></span>未保存</span>'
        : isLiveNow
          ? '<span class="badge badge-live" title="绿灯：来自酒馆/数据库当前实际配置，尚未保存到工作台预设库"><span class="lamp-dot is-live"></span>当前生效</span>'
          : '<span class="badge">已同步</span>';

    col.innerHTML = `
        <div class="panel-head">
            <div class="panel-head-title">
                ${svg(tabIconName(d.kind), 15)}
                <h2 title="${esc(d.name)}">${esc(d.name)}</h2>
                ${statusBadge}
            </div>
            <div class="panel-head-actions">
                ${iconBtn('save', '保存 (Ctrl+S)', 'data-doc-act="save"', 'sm primary')}
                ${isDb ? iconBtn('play', '应用到数据库 / 当前聊天', 'data-doc-act="apply"', 'sm') : ''}
                ${iconBtn('rename', '重命名', 'data-doc-act="rename"', 'sm')}
                ${iconBtn('saveAs', '另存为副本', 'data-doc-act="save-as"', 'sm')}
                ${iconBtn('import', isChar ? '导入新角色卡 (PNG / JSON / YAML)' : '导入文件到新标签（不覆盖原草稿与同名预设）', 'data-doc-act="import"', 'sm')}
                ${isChar ? iconBtn('upload', '更新角色卡（覆盖当前卡并保留聊天记录）', `data-doc-act="update-card" ${d.avatar ? '' : 'disabled'}`, 'sm') : ''}
                ${iconBtn('export', isChar ? '导出角色卡 (PNG / JSON)' : '导出文件', 'data-doc-act="export"', 'sm')}
                ${iconBtn('stats', 'Token 与字数统计', 'data-doc-act="stats"', 'sm')}
                ${d.kind === 'worldbook' ? iconBtn('link', '世界书绑定管理', 'data-doc-act="bind"', 'sm') : ''}
                ${isChar ? iconBtn('chat', '查看该角色全部聊天记录', `data-doc-act="open-chats" ${d.avatar ? '' : 'disabled'}`, 'sm') : ''}
                ${isChar ? iconBtn('external', '跳转到绑定世界书界面', 'data-doc-act="jump-world"', 'sm') : ''}
                ${iconBtn('trash', d.sourceName ? (isChar ? '删除此角色卡（自动备份）' : '删除此文档（自动备份）') : '移除此草稿标签', 'data-doc-act="delete"', 'sm danger')}
            </div>
        </div>
        <div class="panel-subbar">
            <div class="search-bar">
                ${svg('search', 14)}
                <input type="search" data-list-search placeholder="搜索关键词（Enter 跳转并高亮）…" value="${esc(v.search)}">
                <span class="search-count ${hits.length ? 'has-hits' : ''}" data-hit-count>${
                    v.search.trim() ? (hits.length ? `${v.hitCursor + 1}/${hits.length}` : '0/0') : ''
                }</span>
                ${iconBtn('prev', '上一处命中 (Shift+Enter)', 'data-search-nav="prev"', 'sm')}
                ${iconBtn('next', '下一处命中 (Enter)', 'data-search-nav="next"', 'sm')}
                ${iconBtn(
                    v.searchMode === 'filter' ? 'filter' : 'locate',
                    v.searchMode === 'filter' ? '当前：筛选模式（点此切为定位跳转）' : '当前：定位跳转模式（点此切为筛选）',
                    'data-search-mode',
                    v.searchMode === 'filter' ? 'sm active' : 'sm',
                )}
            </div>
            ${iconBtn('replace', '全局查找替换', 'data-doc-act="replace"', 'sm')}
            ${iconBtn('plus', isChar ? '新增备选开场白' : '新增条目', 'data-doc-act="add-entry"', 'sm')}
            ${isChar ? '' : iconBtn('checkAll', '全选/取消当前列表', 'data-doc-act="select-all"', 'sm')}
        </div>
        <div class="panel-scroll" data-list-scroll>
            ${isChar ? buildCharacterHeroHtml(d) : ''}
            ${bulkBar}
            ${built.html}
            ${isChar ? '' : '<div class="drop-end" data-drop-end>拖放到此处移至末尾</div>'}
        </div>
    `;

    const scrollBox = $('[data-list-scroll]', col);
    if (scrollBox) scrollBox.scrollTop = prevScroll;
    attachWindowScrollLoader(col, tab, d, list, v, focusedHitId, built.win);

    wireSingleListEvents(col, tab, d, list, hits);
}

function jumpToSearchHit(col, tab, d, hits, delta) {
    if (!hits.length) {
        notify('没有找到包含该关键词的条目');
        return;
    }
    const v = tabView(tab);
    v.hitCursor = (v.hitCursor + delta + hits.length) % hits.length;
    const hit = hits[v.hitCursor];
    tab.activeEntryId = hit.id;
    state.mobilePane = 'inspector';
    // 如果命中条目尚未在窗口中渲染，扩展窗口后再跳转
    if (!$(`.prompt-card[data-entry-id="${CSS.escape(hit.id)}"]`, col)) {
        renderSingleListPanelKeepSearch(col, tab, d);
    }
    const countEl = $('[data-hit-count]', col);
    if (countEl) countEl.textContent = `${v.hitCursor + 1}/${hits.length}`;
    for (const card of $$('.prompt-card', col)) {
        const isTarget = card.dataset.entryId === hit.id;
        card.classList.toggle('is-search-focus', isTarget);
        card.classList.toggle('is-active', isTarget);
        if (isTarget) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    renderRightInspector();
}

function wireSingleListEvents(col, tab, d, list, hits) {
    const v = tabView(tab);
    const searchInput = $('[data-list-search]', col);
    let composing = false;
    const applySearch = () => {
        v.search = searchInput.value;
        v.hitCursor = 0;
        const freshList = filteredEntries(d, v);
        const freshHits = collectEntrySearchHits(freshList, v.search);
        if (freshHits.length) tab.activeEntryId = freshHits[0].id;
        renderSingleListPanelKeepSearch(col, tab, d);
        renderRightInspector();
        if (freshHits.length) {
            const targetCard = $(`.prompt-card[data-entry-id="${CSS.escape(freshHits[0].id)}"]`, col);
            targetCard?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    };
    searchInput.addEventListener('compositionstart', () => {
        composing = true;
    });
    searchInput.addEventListener('compositionend', () => {
        composing = false;
        applySearch();
    });
    searchInput.addEventListener('input', () => {
        if (!composing) applySearch();
    });
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const curHits = collectEntrySearchHits(filteredEntries(d, v), v.search);
            jumpToSearchHit(col, tab, d, curHits, e.shiftKey ? -1 : 1);
        }
    });

    for (const b of $$('[data-search-nav]', col)) {
        b.onclick = () => {
            const curHits = collectEntrySearchHits(filteredEntries(d, v), v.search);
            jumpToSearchHit(col, tab, d, curHits, b.dataset.searchNav === 'prev' ? -1 : 1);
        };
    }
    $('[data-search-mode]', col).onclick = () => {
        v.searchMode = v.searchMode === 'filter' ? 'jump' : 'filter';
        persistMeta();
        renderSingleListPanel();
    };

    // 文档头与次栏唯一入口动作
    const docActions = {
        save: () => actions.saveDraft(d, false),
        rename: () => actions.renameDocument(d, tab),
        'save-as': () => actions.saveDraft(d, true),
        import: () => actions.importIntoDraft(d),
        'update-card': () => actions.importCharacterFile(d, true),
        apply: () => actions.applyDatabaseDraft(d),
        export: () => actions.exportDraft(d),
        stats: () => actions.tokenStatsDialog(d),
        bind: () => actions.openBindingsDialog(d),
        'bind-world': () => actions.openCharacterWorldBindingsDialog(d),
        'jump-world': () => actions.jumpToCharacterWorldbook(d),
        'edit-tags': () => actions.openCharacterTagsDialog(d),
        'edit-avatar': () => actions.changeCharacterAvatar(d),
        'open-chats': () => openChatsForCharacter(d.avatar, d.name),
        delete: () => actions.deleteDocument(d, tab),
        replace: () => actions.globalFindReplace(d),
        'select-all': () => {
            const ids = list.map((e) => e.id);
            const allChecked = ids.length && ids.every((id) => d.selected.includes(id));
            d.selected = allChecked ? d.selected.filter((id) => !ids.includes(id)) : [...new Set([...d.selected, ...ids])];
            renderSingleListPanel();
        },
        'add-entry': () => addNewEntryToDraft(d, tab, 0),
        'add-seq': () => addNewEntryToDraft(d, tab, 0),
        'add-inj': () => addNewEntryToDraft(d, tab, 1),
    };
    for (const b of $$('[data-doc-act]', col)) {
        b.onclick = run(() => docActions[b.dataset.docAct]?.(b));
    }

    // 批量条
    for (const b of $$('[data-bulk]', col)) {
        b.onclick = run(() => {
            const act = b.dataset.bulk;
            if (act === 'clear') {
                d.selected = [];
                renderSingleListPanel();
                return;
            }
            if (act === 'on' || act === 'off') {
                commit(d, act === 'on' ? '批量启用' : '批量禁用', () => {
                    for (const id of d.selected) {
                        const item = findEntry(d, id);
                        if (item && (isDatabaseKind(d.kind) ? item.toggleable : canToggleEntry(item))) {
                            setEnabled(d, id, act === 'on');
                        }
                    }
                });
            } else if (act === 'dup') {
                commit(d, '批量复制副本', () => transfer(d, d, d.selected));
            } else if (act === 'del') {
                commit(d, '批量删除', () => removeEntries(d, d.selected));
                d.selected = [];
            }
            persistDraft(tab.id);
            renderHeaderTabs();
            renderSingleListPanel();
            renderRightInspector();
        });
    }

    wireCardDelegation(col, tab, d);
}

function renderSingleListPanelKeepSearch(col, tab, d) {
    const v = tabView(tab);
    const list = filteredEntries(d, v);
    const hits = collectEntrySearchHits(list, v.search);
    if (hits.length && v.hitCursor >= hits.length) v.hitCursor = 0;
    const focusedHitId = hits.length ? hits[v.hitCursor]?.id : null;
    const countEl = $('[data-hit-count]', col);
    if (countEl) {
        countEl.textContent = v.search.trim() ? (hits.length ? `${v.hitCursor + 1}/${hits.length}` : '0/0') : '';
        countEl.classList.toggle('has-hits', hits.length > 0);
    }
    const scrollBox = $('[data-list-scroll]', col);
    if (!scrollBox) return;
    const built = buildWindowedListHtml(tab, d, list, v, focusedHitId);
    const isChar = isCharacterKind(d.kind);
    scrollBox.innerHTML =
        (isChar ? buildCharacterHeroHtml(d) : '') +
        built.html +
        (isChar ? '' : '<div class="drop-end" data-drop-end>拖放到此处移至末尾</div>');
    attachWindowScrollLoader(col, tab, d, list, v, focusedHitId, built.win);
}

function wireCardDelegation(col, tab, d, compareSide = null) {
    const scrollBox = $('[data-list-scroll]', col);
    if (!scrollBox || scrollBox.dataset.wired) return;
    scrollBox.dataset.wired = '1';

    scrollBox.addEventListener('click', (e) => {
        // 角色卡名片头快捷按钮
        const heroAct = e.target.closest('[data-hero-act]');
        if (heroAct && isCharacterKind(d.kind)) {
            e.stopPropagation();
            const act = heroAct.dataset.heroAct;
            if (act === 'edit-avatar') void run(() => actions.changeCharacterAvatar(d))();
            else if (act === 'bind-world') void run(() => actions.openCharacterWorldBindingsDialog(d))();
            else if (act === 'jump-world') void run(() => actions.jumpToCharacterWorldbook(d))();
            else if (act === 'edit-tags') void run(() => actions.openCharacterTagsDialog(d))();
            else if (act === 'open-chats') void run(() => openChatsForCharacter(d.avatar, d.name))();
            return;
        }
        // 单击世界书卡片的蓝/绿/向量图标直接循环切换触发模式
        const wbLamp = e.target.closest('[data-card-wb-lamp]');
        if (wbLamp && d.kind === 'worldbook') {
            e.stopPropagation();
            const id = wbLamp.dataset.cardWbLamp;
            const item = findEntry(d, id);
            if (!item) return;
            const next = nextWorldStrategy(item.strategy);
            commitEntry(d, id, '切换世界书触发灯', (target) => applyWorldStrategy(target.raw, next));
            persistDraft(tab.id);
            renderHeaderTabs();
            if (compareSide) renderCompareColumns();
            else {
                renderSingleListPanel();
                renderRightInspector();
            }
            return;
        }
        const openEl = e.target.closest('[data-open-entry]');
        if (openEl) {
            const id = openEl.dataset.openEntry;
            if (compareSide) {
                selectCompareEntry(compareSide, id);
            } else {
                tab.activeEntryId = id;
                if (state.inspectorTab === 'ai') state.inspectorTab = 'content';
                state.mobilePane = 'inspector';
                for (const c of $$('.prompt-card', scrollBox)) c.classList.toggle('is-active', c.dataset.entryId === id);
                renderRightInspector();
                applyGridLayout();
            }
            return;
        }
        const moreBtn = e.target.closest('[data-card-more]');
        if (moreBtn) {
            const id = moreBtn.dataset.cardMore;
            if (isCharacterKind(d.kind)) {
                const entry = findEntry(d, id);
                const charMenu = [];
                if (entry?.isAltGreeting) {
                    charMenu.push(
                        { icon: 'up', label: '上移一条', action: () => runEntryAction(tab, d, 'up', id) },
                        { icon: 'down', label: '下移一条', action: () => runEntryAction(tab, d, 'down', id) },
                    );
                }
                charMenu.push(
                    { icon: 'copy', label: '复制为备选开场白', action: () => runEntryAction(tab, d, 'copy', id) },
                    {
                        icon: 'arrowRight',
                        label: '复制到其他角色卡',
                        hasSub: true,
                        keepOpen: true,
                        action: (btn) => openCopyToOtherPresetSubMenu(btn, tab, d, id),
                    },
                );
                if (entry?.isAltGreeting) {
                    charMenu.push('-', {
                        icon: 'trash',
                        label: '删除此备选开场白',
                        danger: true,
                        action: () => runEntryAction(tab, d, 'delete', id),
                    });
                }
                showPopMenu(moreBtn, charMenu);
                return;
            }
            showPopMenu(moreBtn, [
                { icon: 'up', label: '上移一条', action: () => runEntryAction(tab, d, 'up', id) },
                { icon: 'down', label: '下移一条', action: () => runEntryAction(tab, d, 'down', id) },
                { icon: 'copy', label: '复制一条副本', action: () => runEntryAction(tab, d, 'copy', id) },
                {
                    icon: 'arrowRight',
                    label: '复制到其他预设',
                    hasSub: true,
                    keepOpen: true,
                    action: (btn) => openCopyToOtherPresetSubMenu(btn, tab, d, id),
                },
                '-',
                { icon: 'trash', label: '删除条目', danger: true, action: () => runEntryAction(tab, d, 'delete', id) },
            ]);
        }
    });

    scrollBox.addEventListener('change', (e) => {
        const chk = e.target.closest('[data-check]');
        if (chk) {
            const id = chk.dataset.check;
            d.selected = chk.checked ? [...new Set([...d.selected, id])] : d.selected.filter((x) => x !== id);
            const card = chk.closest('.prompt-card');
            card?.classList.toggle('is-selected', chk.checked);
            if (!compareSide) renderSingleListPanel();
            return;
        }
        const tog = e.target.closest('[data-toggle]');
        if (tog) {
            const id = tog.dataset.toggle;
            try {
                if (d.kind === 'worldbook') {
                    commitEntry(d, id, tog.checked ? '启用条目' : '禁用条目', (item) => {
                        item.raw.disable = !tog.checked;
                    });
                } else {
                    commit(d, tog.checked ? '启用条目' : '禁用条目', () => setEnabled(d, id, tog.checked));
                }
                persistDraft(tab.id);
                tog.closest('.prompt-card')?.classList.toggle('is-disabled', !tog.checked);
                renderHeaderTabs();
                renderRightInspector();
            } catch (err) {
                tog.checked = !tog.checked;
                notify(err.message, true);
            }
        }
    });

    // 拖拽排序与跨栏复制
    scrollBox.addEventListener('dragstart', (e) => {
        const card = e.target.closest('.prompt-card');
        if (!card || card.getAttribute('draggable') === 'false') {
            e.preventDefault();
            return;
        }
        const id = card.dataset.entryId;
        const ids = d.selected.includes(id) ? d.selected : [id];
        e.dataTransfer.setData(
            'application/x-pww-drag',
            JSON.stringify({ tabId: tab.id, kind: d.kind, ids }),
        );
        e.dataTransfer.effectAllowed = 'copyMove';
    });
    scrollBox.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes('application/x-pww-drag')) return;
        const target = e.target.closest('.prompt-card, [data-drop-end]');
        if (!target) return;
        e.preventDefault();
        for (const el of $$('.drop-target', scrollBox)) el.classList.remove('drop-target');
        target.classList.add('drop-target');
    });
    scrollBox.addEventListener('dragleave', (e) => {
        const target = e.target.closest('.prompt-card, [data-drop-end]');
        if (target) target.classList.remove('drop-target');
    });
    scrollBox.addEventListener(
        'drop',
        run((e) => {
            const target = e.target.closest('.prompt-card, [data-drop-end]');
            if (!target) return;
            e.preventDefault();
            target.classList.remove('drop-target');
            const raw = e.dataTransfer.getData('application/x-pww-drag');
            if (!raw) return;
            const payload = JSON.parse(raw);
            const fromDraft = draftFor(payload.tabId);
            if (!fromDraft) return;
            if (fromDraft.kind !== d.kind) throw Error('只能在相同文档类型之间拖拽复制');
            const beforeId = target.dataset.entryId || null;
            if (payload.tabId === tab.id) {
                commit(d, '拖动排序', () => moveEntries(d, payload.ids, beforeId));
            } else {
                commit(d, '跨栏复制', () => transfer(fromDraft, d, payload.ids, beforeId));
                notify(`已复制 ${payload.ids.length} 条到「${d.name}」`);
            }
            persistDraft(tab.id);
            renderAll();
        }),
    );
}

async function addNewEntryToDraft(d, tab, injectionPosition = 0) {
    let newId;
    if (isPromptKind(d.kind)) {
        const groupKeys = Object.keys(d.raw.groups);
        const group = tabView(tab).group || groupKeys[0];
        commit(d, '新增消息段', () => {
            newId = prompts.insert(d, undefined, null, group);
        });
    } else {
        const item = makeEntry(d.kind);
        if (d.kind === 'preset') item.injection_position = injectionPosition;
        commit(d, '新增条目', () => {
            newId = addEntry(d, item, null, true);
        });
    }
    tab.activeEntryId = newId;
    persistDraft(tab.id);
    renderAll();
}

function runEntryAction(tab, d, act, id) {
    const all = entries(d);
    const idx = all.findIndex((e) => e.id === id);
    if (idx < 0) return;
    if (isCharacterKind(d.kind) && (act === 'up' || act === 'down')) {
        const alts = all.filter((e) => e.isAltGreeting);
        const aIdx = alts.findIndex((e) => e.id === id);
        if (aIdx < 0) return;
        if (act === 'up' && aIdx > 0) {
            commit(d, '上移备选开场白', () => moveEntries(d, [id], alts[aIdx - 1].id));
        } else if (act === 'down' && aIdx < alts.length - 1) {
            commit(d, '下移备选开场白', () => moveEntries(d, [id], alts[aIdx + 2]?.id || null));
        }
    } else if (act === 'up' && idx > 0) {
        commit(d, '上移条目', () => moveEntries(d, [id], all[idx - 1].id));
    } else if (act === 'down' && idx < all.length - 1) {
        commit(d, '下移条目', () => moveEntries(d, [id], all[idx + 2]?.id || null));
    } else if (act === 'copy') {
        commit(d, '复制条目', () => transfer(d, d, [id], all[idx + 1]?.id || null));
    } else if (act === 'delete') {
        commit(d, '删除条目', () => removeEntries(d, [id]));
        if (tab.activeEntryId === id) tab.activeEntryId = entries(d)[Math.max(0, idx - 1)]?.id || null;
    }
    persistDraft(tab.id);
    renderAll();
}

// 方式 1 三栏对比模式：左栏文档 A | 中栏文档 B | 右栏常驻差异对比（新增高亮 + 删除线划掉）
function renderCompareColumns() {
    if (!state.compare.enabled) return;
    const colA = $('#pww-col-a');
    const colB = $('#pww-col-b');
    const leftTab = tabById(state.compare.leftTabId);
    const rightTab = tabById(state.compare.rightTabId);
    const leftDraft = leftTab ? draftFor(leftTab.id) : null;
    const rightDraft = rightTab ? draftFor(rightTab.id) : null;
    const sameKind = leftDraft && rightDraft && leftDraft.kind === rightDraft.kind;
    const idx = sameKind ? pairIndex(leftDraft, rightDraft) : { pairs: [], leftMap: new Map(), rightMap: new Map() };

    renderCompareSide(colA, 'left', leftTab, leftDraft, idx.leftMap);
    renderCompareSide(colB, 'right', rightTab, rightDraft, idx.rightMap);
    renderRightInspector();
}

function renderCompareSide(col, side, tab, d, pMap) {
    const isLeft = side === 'left';
    const label = isLeft ? '对比 A' : '对比 B';
    const searchVal = isLeft ? state.compare.leftSearch : state.compare.rightSearch;
    const tabOptions = state.tabs
        .filter((t) => !isCharacterKind(t.kind))
        .map(
            (t) =>
                `<option value="${esc(t.id)}" ${tab?.id === t.id ? 'selected' : ''}>${esc(KIND_LABEL[t.kind] + ' · ' + t.name)}</option>`,
        )
        .join('');

    const all = d ? entries(d) : [];
    const q = normalizeQuery(searchVal);
    let list = all;
    if (state.compare.filter === 'diff') {
        list = list.filter((e) => {
            const st = pMap.get(e.id)?.status;
            return st && st !== 'same';
        });
    } else if (state.compare.filter === 'content') {
        list = list.filter((e) => pMap.get(e.id)?.status === 'content');
    } else if (state.compare.filter === 'unique') {
        list = list.filter((e) => ['added', 'removed'].includes(pMap.get(e.id)?.status));
    }
    const hits = collectEntrySearchHits(list, searchVal);
    const selectedId = isLeft ? state.compare.selectedLeftId : state.compare.selectedRightId;

    const cmpWinKey = `cmp:${side}:${tab?.id || ''}:${state.compare.filter}:${searchVal}:${list.length}`;
    const cmpWin = getWindowLimit('cmp-' + side, cmpWinKey, list, [selectedId]);
    const cmpSlice = list.length > LIST_WINDOW_INIT ? list.slice(0, cmpWin.limit) : list;
    const cmpHasMore = cmpSlice.length < list.length;

    col.innerHTML = `
        <div class="panel-head">
            <div class="panel-head-title" style="gap:5px">
                <span class="badge">${label}</span>
                <select data-cmp-pick="${side}" style="flex:1;min-width:80px;padding:3px 6px;font-size:12px">
                    <option value="">选择已打开标签…</option>
                    ${tabOptions}
                </select>
            </div>
            <div class="panel-head-actions">
                ${!isLeft ? iconBtn('swap', '互换 A / B 两侧', 'data-cmp-swap', 'sm') : ''}
                ${!isLeft ? iconBtn('diffAll', '全本批量比对与合并', 'data-cmp-all', 'sm') : ''}
                ${d ? iconBtn('save', '保存此侧文档', 'data-cmp-save', 'sm primary') : ''}
            </div>
        </div>
        <div class="panel-subbar">
            <div class="search-bar">
                ${svg('search', 13)}
                <input type="search" data-cmp-search="${side}" placeholder="搜索 ${label}…" value="${esc(searchVal)}">
                <span class="search-count ${hits.length ? 'has-hits' : ''}">${q ? hits.length + '条' : ''}</span>
            </div>
            ${
                isLeft
                    ? `<select data-cmp-filter style="padding:3px 5px;font-size:11.5px">
                          <option value="all" ${state.compare.filter === 'all' ? 'selected' : ''}>全部</option>
                          <option value="diff" ${state.compare.filter === 'diff' ? 'selected' : ''}>仅差异</option>
                          <option value="content" ${state.compare.filter === 'content' ? 'selected' : ''}>正文不同</option>
                          <option value="unique" ${state.compare.filter === 'unique' ? 'selected' : ''}>单侧独有</option>
                       </select>`
                    : ''
            }
        </div>
        <div class="panel-scroll" data-list-scroll>
            <div class="entry-list" data-window-list>
                ${
                    d
                        ? cmpSlice
                              .map((e) =>
                                  cardHtml(d, e, {
                                      isActive: selectedId === e.id,
                                      isSearchFocus: Boolean(q && hits.some((h) => h.id === e.id)),
                                      query: searchVal,
                                      pairStatus: pMap.get(e.id)?.status,
                                      sideTag: side,
                                  }),
                              )
                              .join('') || '<p class="muted" style="padding:12px;text-align:center">没有符合筛选条件的条目</p>'
                        : '<p class="muted" style="padding:16px;text-align:center">请从顶部打开或选择两份文档进行对比</p>'
                }
            </div>
            ${
                cmpHasMore
                    ? `<div class="list-window-more" data-window-more><span class="muted">已显示 ${cmpSlice.length} / ${list.length} 条</span><button type="button" data-load-more>继续加载</button></div>`
                    : ''
            }
            ${d ? '<div class="drop-end" data-drop-end>拖放到此处跨栏复制</div>' : ''}
        </div>
    `;

    if (d && cmpHasMore) {
        const scrollBox = $('[data-list-scroll]', col);
        let rendered = cmpSlice.length;
        const appendCmp = () => {
            const listEl = $('[data-window-list]', scrollBox);
            if (!listEl || rendered >= list.length) return;
            const nextEnd = Math.min(list.length, rendered + LIST_WINDOW_STEP);
            listEl.insertAdjacentHTML(
                'beforeend',
                list
                    .slice(rendered, nextEnd)
                    .map((e) =>
                        cardHtml(d, e, {
                            isActive: selectedId === e.id,
                            isSearchFocus: Boolean(q && hits.some((h) => h.id === e.id)),
                            query: searchVal,
                            pairStatus: pMap.get(e.id)?.status,
                            sideTag: side,
                        }),
                    )
                    .join(''),
            );
            rendered = nextEnd;
            cmpWin.limit = rendered;
            const moreEl = $('[data-window-more]', scrollBox);
            if (moreEl) {
                if (rendered >= list.length) moreEl.remove();
                else $('span', moreEl).textContent = `已显示 ${rendered} / ${list.length} 条`;
            }
        };
        const btn = $('[data-load-more]', scrollBox);
        if (btn) btn.onclick = appendCmp;
        scrollBox.onscroll = () => {
            if (rendered < list.length && scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 240) {
                appendCmp();
            }
        };
    }

    $('[data-cmp-pick]', col).onchange = run(async (ev) => {
        const val = ev.target.value || null;
        if (isLeft) state.compare.leftTabId = val;
        else state.compare.rightTabId = val;
        if (val) await ensureDraftLoaded(val);
        state.compare.selectedLeftId = null;
        state.compare.selectedRightId = null;
        persistMeta();
        renderAll();
    });
    const swapBtn = $('[data-cmp-swap]', col);
    if (swapBtn) {
        swapBtn.onclick = () => {
            [state.compare.leftTabId, state.compare.rightTabId] = [state.compare.rightTabId, state.compare.leftTabId];
            [state.compare.selectedLeftId, state.compare.selectedRightId] = [
                state.compare.selectedRightId,
                state.compare.selectedLeftId,
            ];
            persistMeta();
            renderAll();
        };
    }
    const allBtn = $('[data-cmp-all]', col);
    if (allBtn) {
        allBtn.onclick = run(() =>
            actions.compareAllDialog(draftFor(state.compare.leftTabId), draftFor(state.compare.rightTabId)),
        );
    }
    const saveBtn = $('[data-cmp-save]', col);
    if (saveBtn && d) saveBtn.onclick = run(() => actions.saveDraft(d, false));

    const filterSel = $('[data-cmp-filter]', col);
    if (filterSel) {
        filterSel.onchange = () => {
            state.compare.filter = filterSel.value;
            renderCompareColumns();
        };
    }
    const sInp = $('[data-cmp-search]', col);
    let comp = false;
    const onS = () => {
        if (isLeft) state.compare.leftSearch = sInp.value;
        else state.compare.rightSearch = sInp.value;
        const freshHits = collectEntrySearchHits(all, sInp.value);
        if (freshHits.length) selectCompareEntry(side, freshHits[0].id);
        else renderCompareColumns();
    };
    sInp.addEventListener('compositionstart', () => (comp = true));
    sInp.addEventListener('compositionend', () => {
        comp = false;
        onS();
    });
    sInp.addEventListener('input', () => {
        if (!comp) onS();
    });

    if (tab && d) wireCardDelegation(col, tab, d, side);
}

function selectCompareEntry(side, id, manual = false) {
    const leftDraft = draftFor(state.compare.leftTabId);
    const rightDraft = draftFor(state.compare.rightTabId);
    const sameKind = leftDraft && rightDraft && leftDraft.kind === rightDraft.kind;
    if (manual) {
        if (side === 'left') state.compare.selectedLeftId = id || null;
        else state.compare.selectedRightId = id || null;
    } else if (sameKind) {
        const idx = pairIndex(leftDraft, rightDraft);
        const pair = side === 'left' ? idx.leftMap.get(id) : idx.rightMap.get(id);
        if (side === 'left') {
            state.compare.selectedLeftId = id;
            // 若能自动配对则自动联动对侧；若为单侧独有且对侧无选择则清空，否则保留用户已选的对侧条目以便直接双条目对比
            if (pair?.right?.id) state.compare.selectedRightId = pair.right.id;
        } else {
            state.compare.selectedRightId = id;
            if (pair?.left?.id) state.compare.selectedLeftId = pair.left.id;
        }
    } else if (side === 'left') {
        state.compare.selectedLeftId = id;
    } else {
        state.compare.selectedRightId = id;
    }
    // 局部高亮两端卡片并滚动对齐配对项
    for (const c of $$('#pww-col-a .prompt-card')) {
        const hit = c.dataset.entryId === state.compare.selectedLeftId;
        c.classList.toggle('is-active', hit);
        if (hit && side === 'right' && !manual) c.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    for (const c of $$('#pww-col-b .prompt-card')) {
        const hit = c.dataset.entryId === state.compare.selectedRightId;
        c.classList.toggle('is-active', hit);
        if (hit && side === 'left' && !manual) c.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    state.mobilePane = 'inspector';
    applyGridLayout();
    renderRightInspector();
}

function renderRightInspector() {
    const col = $('#pww-col-c');
    if (!col) return;
    if (!state.compare.enabled && navPaneMode === 'chats') {
        chatCtrl.renderRight(col);
        return;
    }
    if (state.compare.enabled) {
        const leftDraft = draftFor(state.compare.leftTabId);
        const rightDraft = draftFor(state.compare.rightTabId);
        const leftEntry = leftDraft && state.compare.selectedLeftId ? findEntry(leftDraft, state.compare.selectedLeftId) : null;
        const rightEntry = rightDraft && state.compare.selectedRightId ? findEntry(rightDraft, state.compare.selectedRightId) : null;
        let pair = null;
        if (leftEntry || rightEntry) {
            let status = 'manual';
            if (leftDraft && rightDraft && leftDraft.kind === rightDraft.kind) {
                const idx = pairIndex(leftDraft, rightDraft);
                const autoPair = leftEntry ? idx.leftMap.get(leftEntry.id) : rightEntry ? idx.rightMap.get(rightEntry.id) : null;
                if (autoPair && autoPair.left?.id === leftEntry?.id && autoPair.right?.id === rightEntry?.id) {
                    status = autoPair.status;
                } else if (leftEntry && rightEntry) {
                    status = leftEntry.content !== rightEntry.content ? 'content' : 'same';
                } else {
                    status = leftEntry ? 'removed' : 'added';
                }
            }
            pair = { left: leftEntry, right: rightEntry, status };
        }
        const query = state.compare.leftSearch || state.compare.rightSearch || '';
        renderCompareInspector(col, {
            leftDraft,
            rightDraft,
            pair,
            compareState: state.compare,
            query,
            activeHit: query ? 0 : -1,
            actions: {
                setCompareMode(m) {
                    state.compare.mode = m;
                    renderRightInspector();
                },
                pickCompareEntry(side, id) {
                    selectCompareEntry(side, id, true);
                },
                mergeCompare(act, l, r) {
                    if (act === 'ltr-content' && l && r) {
                        commit(rightDraft, '对比覆盖正文', () => overwriteEntry(leftDraft, rightDraft, l.id, r.id, 'content'));
                        persistDraft(state.compare.rightTabId);
                    } else if (act === 'rtl-content' && l && r) {
                        commit(leftDraft, '对比覆盖正文', () => overwriteEntry(rightDraft, leftDraft, r.id, l.id, 'content'));
                        persistDraft(state.compare.leftTabId);
                    } else if (act === 'ltr-all' && l && r) {
                        commit(rightDraft, '对比覆盖整条', () => overwriteEntry(leftDraft, rightDraft, l.id, r.id, 'all'));
                        persistDraft(state.compare.rightTabId);
                    } else if (act === 'rtl-all' && l && r) {
                        commit(leftDraft, '对比覆盖整条', () => overwriteEntry(rightDraft, leftDraft, r.id, l.id, 'all'));
                        persistDraft(state.compare.leftTabId);
                    } else if (act === 'ltr-copy' && l) {
                        commit(rightDraft, '对比复制到右侧', () => transfer(leftDraft, rightDraft, [l.id]));
                        persistDraft(state.compare.rightTabId);
                    } else if (act === 'rtl-copy' && r) {
                        commit(leftDraft, '对比复制到左侧', () => transfer(rightDraft, leftDraft, [r.id]));
                        persistDraft(state.compare.leftTabId);
                    }
                    notify('对比合并已写入草稿');
                    renderAll();
                },
                saveCompareInline(l, r, leftVal, rightVal) {
                    if (l && !l.marker && typeof leftVal === 'string' && leftVal !== l.content) {
                        commit(leftDraft, '对比编辑正文', () => {
                            findEntry(leftDraft, l.id).raw.content = leftVal;
                        });
                        persistDraft(state.compare.leftTabId);
                    }
                    if (r && !r.marker && typeof rightVal === 'string' && rightVal !== r.content) {
                        commit(rightDraft, '对比编辑正文', () => {
                            findEntry(rightDraft, r.id).raw.content = rightVal;
                        });
                        persistDraft(state.compare.rightTabId);
                    }
                    notify('两侧修改已写入草稿');
                    renderAll();
                },
            },
        });
        return;
    }

    const tab = activeTab();
    const d = activeDraft();
    const v = tabView(tab);
    renderInspector(col, {
        draft: d,
        entryId: tab?.activeEntryId,
        tab: state.inspectorTab,
        query: v.search,
        activeHit: v.search.trim() ? 0 : -1,
        env,
        actions: {
            setInspectorTab(t) {
                state.inspectorTab = t;
                persistMeta();
                renderHeaderTabs();
                renderRightInspector();
            },
            entryAction(act, id) {
                runEntryAction(tab, d, act, id);
            },
            runDocAction(act) {
                if (act === 'doc-meta') return actions.openDocMetaJsonDialog(d);
                if (act === 'bind-world') return actions.openCharacterWorldBindingsDialog(d);
                if (act === 'jump-world') return actions.jumpToCharacterWorldbook(d);
                if (act === 'edit-tags') return actions.openCharacterTagsDialog(d);
                if (act === 'edit-avatar') return actions.changeCharacterAvatar(d);
                if (act === 'update-card') return actions.importCharacterFile(d, true);
            },
            mutateEntry(id, label, mutator, rerenderInspector = false) {
                if (!d || !tab) return;
                const changed = commitEntry(d, id, label, mutator);
                if (!changed) return;
                persistDraft(tab.id);
                // 局部更新顶部标签黄灯 + 中栏标题状态胶囊 + 对应列表卡片，绝不销毁右侧正在输入的文本框！
                renderHeaderTabs();
                renderFooter();
                const headBadge = $('#pww-col-b .panel-head-title .badge');
                if (headBadge) {
                    const isDirtyNow = dirty(d), isLiveNow = isLiveUnsaved(d);
                    headBadge.className = 'badge' + (isDirtyNow ? ' badge-dirty' : isLiveNow ? ' badge-live' : '');
                    headBadge.innerHTML = isDirtyNow
                        ? '<span class="lamp-dot is-dirty"></span>未保存'
                        : isLiveNow
                          ? '<span class="lamp-dot is-live"></span>酒馆当前'
                          : '已同步';
                }
                const updated = findEntry(d, id);
                const card = $(`#pww-col-b .prompt-card[data-entry-id="${CSS.escape(id)}"]`);
                if (card && updated) {
                    const titleEl = $('.card-title', card);
                    if (titleEl) titleEl.textContent = updated.name;
                    card.classList.toggle('is-disabled', !updated.enabled);
                    const sw = $('[data-toggle]', card);
                    if (sw) sw.checked = Boolean(updated.enabled);
                }
                if (rerenderInspector) {
                    renderSingleListPanel();
                    renderRightInspector();
                }
            },
        },
    });
}

function renderFooter() {
    const f = $('#pww-footer');
    if (!f) return;
    const d = activeDraft();
    const dbStatus = dbCaps?.available ? '数据库直连已就绪' : '数据库待连接';
    f.innerHTML = `
        <div class="footer-left">
            <span><span class="status-dot ${dbCaps?.available ? '' : 'warn'}"></span> ${esc(dbStatus)}</span>
            <span>已打开 ${state.tabs.length} 个标签</span>
            ${d ? `<span>当前：${esc(KIND_LABEL[d.kind])} · ${entries(d).length} 条</span>` : ''}
        </div>
        <div class="footer-right">
            <span>酒馆工作台 0.7.1 · 🟢当前生效 🟡已改未存</span>
            <span>Ctrl+S 保存 · Esc 关闭</span>
        </div>
    `;
}

function renderMainArea() {
    applyGridLayout();
    if (state.compare.enabled) {
        renderCompareColumns();
    } else {
        renderNavPanel();
        renderSingleListPanel();
        renderRightInspector();
    }
}

function renderAll() {
    renderHeaderTabs();
    renderBanner();
    renderMainArea();
    renderFooter();
}

// 启动与工作区迁移（0.5.0 起顶栏默认空白，仅保留用户手动打开/未保存的标签）
async function migrateLegacyWorkspaceIfNeeded() {
    const meta = await storeGet(META_STORAGE_KEY);
    if (meta && Array.isArray(meta.tabs)) {
        const isV5 = Number(meta.schemaVersion || 0) >= 5;
        state.tabs = meta.tabs
            .filter((t) => isV5 || !t.liveKey || t.dirty)
            .map((t) => ({
                ...t,
                name: String(t.name || '').replace(/^当前\s*·\s*/, ''),
            }));
        state.activeTabId = state.tabs.some((t) => t.id === meta.activeTabId)
            ? meta.activeTabId
            : state.tabs[0]?.id || null;
        if (meta.compare) {
            state.compare = { ...state.compare, ...meta.compare };
            if (!state.tabs.some((t) => t.id === state.compare.leftTabId)) state.compare.leftTabId = null;
            if (!state.tabs.some((t) => t.id === state.compare.rightTabId)) state.compare.rightTabId = null;
            if (!state.tabs.length) state.compare.enabled = false;
        }
        if (meta.inspectorTab) state.inspectorTab = meta.inspectorTab;
        if (typeof meta.navCollapsed === 'boolean') state.navCollapsed = meta.navCollapsed;
        if (Array.isArray(meta.receipts)) state.receipts = meta.receipts;
        if (!isV5) persistMeta();
        return;
    }
    // 兼容迁移 0.3.1 的旧草稿（仅提取当前文档，丢弃臃肿历史栈以彻底提速）
    const legacy = await storeGet('workspace');
    if (legacy?.documents) {
        const docs = [];
        for (const k of ['preset', 'worldbook']) {
            for (const d of legacy.documents[k] || []) if (d?.raw) docs.push(d);
        }
        if (legacy.database?.documents) {
            for (const arr of Object.values(legacy.database.documents)) {
                for (const d of arr || []) if (d?.raw) docs.push(d);
            }
        }
        for (const d of docs.slice(0, 8)) {
            const clean = hydrateDraft(dehydrateDraft(d));
            const id = uuid();
            draftCache.set(id, clean);
            state.tabs.push({
                id,
                kind: clean.kind,
                name: clean.name,
                sourceName: clean.sourceName || null,
                fromLive: Boolean(clean.fromLive),
                dirty: dirty(clean),
                activeEntryId: entries(clean)[0]?.id || null,
                view: defaultView(),
            });
            await storePut('tab-draft:' + id, dehydrateDraft(clean));
        }
        state.activeTabId = state.tabs[0]?.id || null;
        persistMeta();
    }
}

// 全局快捷键与宿主消息
document.addEventListener('keydown', (e) => {
    if ($('dialog[open]')) return;
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 's') {
        e.preventDefault();
        if (navPaneMode === 'chats' && !state.compare.enabled) {
            run(() => chatCtrl.saveActiveChat())();
        } else {
            run(() => actions.saveDraft(activeDraft(), false))();
        }
    } else if (!editing && (e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y')) {
        e.preventDefault();
        const isRedo = key === 'y' || e.shiftKey;
        if (navPaneMode === 'chats' && !state.compare.enabled) {
            if (isRedo) chatCtrl.redo();
            else chatCtrl.undo();
            return;
        }
        const d = activeDraft();
        if (d && undo(d, isRedo ? 1 : -1)) {
            persistDraft(activeTab().id);
            renderAll();
        }
    } else if (e.key === 'Escape') {
        if (activePopMenu) closePopMenu();
        else void closeWorkbench();
    }
});

onHost('opened', async () => {
    try {
        runtime = await rpc('init', { fast: true });
        config = runtime.config || {};
        applyTheme(runtime.theme);
        if (state.activeTabId) await ensureDraftLoaded(state.activeTabId);
        renderAll();
        if (navPaneMode === 'characters' || isCharacterKind(activeTab()?.kind)) {
            void ensureCharacterCatalog(true);
        } else if (navPaneMode === 'chats') {
            void chatCtrl.ensureCatalog(true);
        }
        dbCall('capabilities')
            .then((c) => {
                dbCaps = c;
                renderFooter();
            })
            .catch(() => {});
    } catch (err) {
        notify(err.message, true);
    }
});
onHost('theme', (t) => applyTheme(t));
onHost('activation', (val) => {
    runtime.activeEntries = val || [];
    if (!state.compare.enabled && activeDraft()?.kind === 'worldbook') renderSingleListPanel();
});

// 极速启动流程：并行读取宿主快速初始化 + 分片元信息（不强扫 42MB 世界书目录）
try {
    const [initRes] = await Promise.all([rpc('init', { fast: true }), migrateLegacyWorkspaceIfNeeded()]);
    runtime = initRes;
    config = runtime.config || {};
    applyTheme(runtime.theme);
    mountShell();

    const toLoad = new Set();
    if (state.compare.enabled) {
        if (state.compare.leftTabId) toLoad.add(state.compare.leftTabId);
        if (state.compare.rightTabId) toLoad.add(state.compare.rightTabId);
    } else if (state.activeTabId) {
        toLoad.add(state.activeTabId);
        if (isCharacterKind(activeTab()?.kind)) navPaneMode = 'characters';
    }
    await Promise.all([...toLoad].map((id) => ensureDraftLoaded(id)));
    renderAll();
    if (navPaneMode === 'characters') void ensureCharacterCatalog(false);

    // 后台非阻塞查询数据库能力
    dbCall('capabilities')
        .then((c) => {
            dbCaps = c;
            renderNavPanel();
            renderFooter();
            const cur = activeTab();
            if (cur && isDatabaseKind(cur.kind)) prefetchDbCatalog(cur.kind);
        })
        .catch(() => {});
} catch (error) {
    $('#app').innerHTML = `<div class="boot"><h2>工作台无法连接</h2><p>${esc(error.message)}</p><p>请从酒馆扩展菜单打开，不要直接访问 UI 文件。</p></div>`;
}
