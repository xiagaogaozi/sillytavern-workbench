// 数据库方案 A 宿主适配器：零魔改 shujuku，优先调用原生公开 API，缺口项直写酒馆 extensionSettings / 聊天第0楼。
import { clone, equal, fingerprint, uuid } from './core.js';
import { decodeTemplateDocument, isPromptKind, PROMPT_KINDS } from './database-model.js';
import { SHUJUKU_DEFAULTS } from './shujuku-defaults.js';

const DEFAULT_PRESET_NAME = {
    plot: '默认剧情推进',
    tableTemplate: '默认表格模板',
    contentReplace: '默认正文替换',
    promptFill: '默认填表提示词',
    promptContinuation: '默认智能续写',
    promptSimulation: '默认格林推演',
    promptKeyword: '默认向量检索关键词',
    promptSummary: '默认远记忆总结',
    promptAssistant: '默认模板助手',
    promptAgent: '默认世界书Agent',
};
const DELETED_DEFAULTS_KEY = 'pww_deleted_defaults_v1';

const NS = 'shujuku_v120__userscript_settings_v1';
const META_KEY = 'shujuku_v120_globalMeta_v1';
const TEMPLATE_PRESETS_KEY = 'shujuku_v120_templatePresets_v1';
const CONT_FIELD = '_qrf_continuation';
const SIM_FIELD = '_qrf_world_simulation';
const AGENT_WB_COMMENT = 'TavernDB-ACU-AgentWorldbookConfig';
const SENSITIVE_KEY_RE = /^(?:apiKey|api_key|authorization|password|accessToken|secret|embeddingApiKey|rerankApiKey)$/i;

const FEATURE_KEYS = [
    'autoUpdateEnabled',
    'silentModeEnabled',
    'desktopPetEnabled',
    'deskPetJokesEnabled',
    'deskPetShowRealWork',
    'continuationPageEnabled',
    'worldSimulationPageEnabled',
    'externalImportPageEnabled',
];

const SCOPES = {
    plot: ['chat', 'global'],
    tableTemplate: ['chat', 'global'],
    contentReplace: ['global'],
    promptFill: ['global'],
    promptContinuation: ['chat'],
    promptSimulation: ['chat'],
    promptKeyword: ['global'],
    promptSummary: ['global'],
    promptAssistant: ['global'],
    promptAgent: ['defaults', 'worldbook'],
};

const CONTINUATION_GROUPS = [
    'outline',
    'main',
    'arcArchitect',
    'maintainer',
    'mainlinePlanner',
    'beatPlanner',
    'finalReviewer',
    'webResearcher',
    'instructionComposer',
];
const SIMULATION_GROUPS = [
    'world-director',
    'undercurrent-analyst',
    'dramatis-keeper',
    'causality-reviewer',
    'guidance-composer',
    'lore-researcher',
];
const CONT_API_ROLES = [
    'main',
    'outline',
    'arcArchitect',
    'maintainer',
    'mainlinePlanner',
    'beatPlanner',
    'finalReviewer',
    'webResearcher',
    'instructionComposer',
];

const previewTokens = new Map();

function stripSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(stripSensitive);
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE_KEY_RE.test(k)) continue;
        out[k] = stripSensitive(v);
    }
    return out;
}

function parseJsonSafe(raw, fallback) {
    if (raw === null || raw === undefined) return clone(fallback);
    if (typeof raw === 'object') return clone(raw);
    try {
        return JSON.parse(raw);
    } catch {
        return clone(fallback);
    }
}

function safeCall(fn, fallback = null) {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

function profileSlot(code) {
    const clean = String(code || '').trim();
    return clean ? clean : '__default__';
}

function profileSettingsKey(code) {
    return `shujuku_v120_profile_v1__${profileSlot(code)}__settings`;
}

function profileTemplateKey(code) {
    return `shujuku_v120_profile_v1__${profileSlot(code)}__template`;
}

function defaultSegments(role = 'SYSTEM', content = '') {
    return [{ role, content, deletable: true }];
}

function defaultContinuationSettings(groups = {}) {
    const agentPrompts = {};
    for (const key of CONTINUATION_GROUPS) {
        if (key === 'outline') continue;
        agentPrompts[key] = Array.isArray(groups[key]) && groups[key].length
            ? clone(groups[key])
            : [{ role: 'system', content: '', deletable: true, enabled: true, pinned: false }];
    }
    const agentApiPresets = {};
    for (const r of CONT_API_ROLES) agentApiPresets[r] = { mode: 'inherit', presetName: '' };
    return {
        stageSize: 'standard',
        customTurnMin: null,
        customTurnMax: null,
        storyArcVolumePlan: 'medium',
        customStoryArcVolumeCount: null,
        outlinePreview: false,
        autoNextStage: true,
        maxAutomaticStages: 6,
        loopTags: '',
        loopDelaySeconds: 5,
        totalDurationMinutes: 0,
        retryDelaySeconds: 3,
        generationRetryLimit: 3,
        internalAiRetryLimit: 3,
        minGenerationTokens: 1000,
        maxConsecutivePressureTurns: 8,
        storyWindowFloors: 20,
        agentHistoryTokenBudget: 120000,
        storyTailFloors: 2,
        agentReadTokenBudget: '20%',
        agentReadFallbackTokens: 6000,
        finalReview: { enabled: false, readTokenBudget: '20%', maxExtraReads: 6 },
        workflow: { reviseLimit: 3 },
        webResearch: {
            enabled: false,
            sources: { moegirl: true, wikipediaZh: true, wikipediaEn: false, baidu: true },
            searchProvider: 'duckduckgo',
            searxngBaseUrl: '',
            maxToolRounds: 8,
            maxPages: 8,
            pageCharLimit: 4000,
            blockedDomains: '',
        },
        contextExtractRules: [],
        contextExcludeRules: [],
        agentRunBudget: {
            maxIterations: 4,
            maxDelegations: 3,
            maxSameAgent: 2,
            maxConcurrent: 3,
            maxReads: 4,
            maxExtraReads: 3,
        },
        apiPresetMode: 'current',
        fixedApiPresetName: '',
        promptCacheEnabled: false,
        agentApiPresets,
        outlinePrompt: Array.isArray(groups.outline) && groups.outline.length
            ? clone(groups.outline)
            : [{ role: 'system', content: '', deletable: true, enabled: true, pinned: false }],
        agentPrompts,
        promptForceDefaultVersion: 'continuation-content-safety-v53',
    };
}

function defaultSimulationSettings(groups = {}) {
    const agentPrompts = {};
    for (const key of SIMULATION_GROUPS) {
        agentPrompts[key] = Array.isArray(groups[key]) && groups[key].length
            ? clone(groups[key])
            : [{ role: 'system', content: '', deletable: true, enabled: true, pinned: false }];
    }
    return {
        autoTriggerEnabled: true,
        agentHistoryTokenBudget: 120000,
        agentReadTokenBudget: '20%',
        agentReadFallbackTokens: 6000,
        agentRunBudget: {
            maxIterations: 4,
            maxDelegations: 6,
            maxSameAgent: 4,
            maxConcurrent: 5,
            maxReads: 24,
            maxExtraReads: 1,
        },
        webResearch: {
            enabled: false,
            sources: { moegirl: true, wikipediaZh: true, wikipediaEn: false },
            searchProvider: 'duckduckgo',
            searxngBaseUrl: '',
            pageCharLimit: 4000,
            blockedDomains: '',
        },
        apiPresetMode: 'current',
        fixedApiPresetName: '',
        agentApiPresets: {},
        agentPrompts,
        promptForceDefaultVersion: 'world-simulation-content-safety-v38',
        dynamics: {
            rumorTTLDays: 30,
            maxClockAdvanceDays: 14,
            collisionEnforcement: 'strict',
            missedSweepEnabled: true,
        },
        workflow: { chroniclerHotThreshold: 32 },
        projection: {
            template:
                '<div hidden class="qrf-world-simulation-projection" style="display:none">\n<与此同时>\n$WORLD_SIGNALS\n</与此同时>\n</div>',
        },
    };
}

function emptySimulationLedger() {
    return {
        schemaVersion: 6,
        revision: 0,
        clock: { day: 1, slot: '', storyTime: '', precision: 'unknown', evidenceRefs: [] },
        dimensions: [],
        seeds: [],
        actors: [],
        chronicle: [],
        guidance: { signals: [], excludedFacts: [], evidenceRefs: [] },
        rumors: [],
        player: { location: null, locationUpdatedAtDay: 1, regionVisits: [], contact: 'open', evidenceRefs: [] },
        chronicleOverview: [],
        materialCompletion: {
            state: 'legacy_unknown',
            expectedModules: [],
            modules: {},
            sourceRunId: '',
            updatedAt: 0,
        },
        pendingFixes: [],
    };
}

export function createDatabaseHost({ ctx, post, modules, encodeJson }) {
    const api = () => window.AutoCardUpdaterAPI || null;

    function getNamespace(create = false) {
        const es = ctx()?.extensionSettings;
        if (!es) throw Error('无法访问酒馆 extensionSettings');
        if (!es.__userscripts) {
            if (!create) return null;
            es.__userscripts = {};
        }
        if (!es.__userscripts[NS]) {
            if (!create) return null;
            es.__userscripts[NS] = {};
        }
        return es.__userscripts[NS];
    }

    function readGlobalMeta() {
        const ns = getNamespace(false);
        return parseJsonSafe(ns?.[META_KEY], {
            version: 1,
            activeIsolationCode: '',
            isolationCodeList: [],
            vectorMemoryConfigGlobal: {},
        });
    }

    function writeGlobalMeta(meta) {
        const ns = getNamespace(true);
        ns[META_KEY] = JSON.stringify(meta);
        ns.__acuSettingsWrittenAt = Date.now();
    }

    function activeIsolationCode() {
        return String(readGlobalMeta().activeIsolationCode || '');
    }

    function currentProfileKey() {
        return profileSettingsKey(activeIsolationCode());
    }

    function readProfileSettings() {
        const ns = getNamespace(false);
        return parseJsonSafe(ns?.[currentProfileKey()], {});
    }

    function writeProfileSettings(settingsObj) {
        const ns = getNamespace(true);
        ns[currentProfileKey()] = JSON.stringify(settingsObj);
        ns.__acuSettingsWrittenAt = Date.now();
    }

    function readTemplatePresets() {
        const ns = getNamespace(false);
        const raw = parseJsonSafe(ns?.[TEMPLATE_PRESETS_KEY], { version: 1, presets: {} });
        if (!raw.presets || typeof raw.presets !== 'object') raw.presets = {};
        return raw;
    }

    function writeTemplatePresets(store) {
        const ns = getNamespace(true);
        ns[TEMPLATE_PRESETS_KEY] = JSON.stringify(store);
        ns.__acuSettingsWrittenAt = Date.now();
    }

    function libraryKey() {
        return 'pww_prompt_library_v1::' + currentProfileKey();
    }

    function readPromptLibrary() {
        const ns = getNamespace(false);
        const parsed = parseJsonSafe(ns?.[libraryKey()], { version: 1, items: {}, bindings: [] });
        if (!parsed.items || typeof parsed.items !== 'object') parsed.items = {};
        if (!Array.isArray(parsed.bindings)) parsed.bindings = [];
        return parsed;
    }

    function writePromptLibrary(lib) {
        const ns = getNamespace(true);
        ns[libraryKey()] = JSON.stringify(lib);
        ns.__acuSettingsWrittenAt = Date.now();
    }

    async function persistSettingsNow() {
        const c = ctx();
        if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
        try {
            const mod = await import('/script.js');
            if (typeof mod.saveSettings === 'function') await mod.saveSettings();
        } catch {
            // saveSettingsDebounced 已排入队列
        }
    }

    async function persistChatNow() {
        const c = ctx();
        if (typeof c.saveChat === 'function') {
            await c.saveChat();
            return;
        }
        const mod = await import('/script.js');
        if (typeof mod.saveChat === 'function') await mod.saveChat();
    }

    async function createDbBackup(label, payload) {
        try {
            const name = 'pww-db-backup-' + uuid() + '.json';
            const res = await post('/api/files/upload', {
                name,
                data: encodeJson({ label, at: new Date().toISOString(), data: stripSensitive(payload) }),
            });
            return { path: res?.path || '/user/files/' + name };
        } catch (e) {
            throw Error('写入修改前备份失败，操作已取消：' + (e.message || e));
        }
    }

    function currentScope() {
        const c = ctx();
        const chatId = c?.getCurrentChatId?.() || '';
        const char = c?.characters?.[c.characterId];
        return {
            isolationCode: activeIsolationCode(),
            profileKey: currentProfileKey(),
            library: libraryKey(),
            chatId: String(chatId || ''),
            characterName: char?.name || '',
            hasChat: Boolean(chatId && Array.isArray(c?.chat) && c.chat.length > 0),
        };
    }

    function readFeatureFlags() {
        const a = api();
        if (a?.features?.getAll) {
            try {
                return a.features.getAll();
            } catch {}
        }
        const prof = readProfileSettings();
        const meta = readGlobalMeta();
        return {
            autoUpdateEnabled: prof.autoUpdateEnabled !== false,
            silentModeEnabled: Boolean(prof.silentModeEnabled),
            desktopPetEnabled: prof.desktopPetEnabled !== false,
            deskPetJokesEnabled: prof.deskPetJokesEnabled !== false,
            deskPetShowRealWork: Boolean(prof.deskPetShowRealWork),
            continuationPageEnabled: prof.continuationPageEnabled !== false,
            worldSimulationPageEnabled: prof.worldSimulationPageEnabled === true,
            externalImportPageEnabled: prof.externalImportPageEnabled !== false,
            plotEnabled: Boolean(prof.plotSettings?.enabled),
            contentReplaceEnabled: Boolean(prof.contentOptimizationSettings?.enabled),
            vectorMemoryEnabled: Boolean(meta.vectorMemoryConfigGlobal?.enabled),
        };
    }

    async function readAgentWorldbookEntry() {
        const c = ctx();
        const char = c?.characters?.[c.characterId];
        const bookName = char?.data?.extensions?.world || c?.chatMetadata?.world_info || '';
        if (!bookName) return { bookName: '', control: null, bookData: null, entryKey: null };
        try {
            const bookData = await post('/api/worldinfo/get', { name: bookName });
            const entries = bookData?.entries || {};
            const found = Object.entries(entries).find(
                ([, e]) => String(e?.comment || '').trim() === AGENT_WB_COMMENT,
            );
            if (!found) return { bookName, control: null, bookData, entryKey: null };
            const parsed = parseJsonSafe(found[1].content, {});
            return {
                bookName,
                control: parsed?.control || parsed,
                bookData,
                entryKey: found[0],
            };
        } catch {
            return { bookName, control: null, bookData: null, entryKey: null };
        }
    }

    function readDeletedDefaults() {
        const ns = getNamespace(false);
        const arr = parseJsonSafe(ns?.[DELETED_DEFAULTS_KEY], []);
        return new Set(Array.isArray(arr) ? arr : []);
    }

    function markDefaultDeleted(kind) {
        const ns = getNamespace(true);
        const set = readDeletedDefaults();
        set.add(kind);
        ns[DELETED_DEFAULTS_KEY] = JSON.stringify([...set]);
    }

    function builtinDefault(kind) {
        const def = SHUJUKU_DEFAULTS[kind];
        if (!def) throw Error('缺少该类型的内置默认定义：' + kind);
        return clone(def);
    }

    function ensureDefaultPreset(kind) {
        const defName = DEFAULT_PRESET_NAME[kind];
        if (!defName || !SHUJUKU_DEFAULTS[kind]) return;
        if (readDeletedDefaults().has(kind)) return;
        const ns = getNamespace(false);
        if (!ns) return;

        if (isPromptKind(kind)) {
            const lib = readPromptLibrary();
            lib.items[kind] ||= {};
            if (!Object.prototype.hasOwnProperty.call(lib.items[kind], defName)) {
                lib.items[kind][defName] = { raw: builtinDefault(kind), updatedAt: Date.now(), builtinDefault: true };
                writePromptLibrary(lib);
                void persistSettingsNow();
            }
            return;
        }
        if (kind === 'plot') {
            const prof = readProfileSettings();
            prof.plotSettings ||= {};
            prof.plotSettings.promptPresets ||= [];
            if (!prof.plotSettings.promptPresets.some((p) => p.name === defName)) {
                const doc = builtinDefault('plot');
                doc.name = defName;
                prof.plotSettings.promptPresets.push(doc);
                writeProfileSettings(prof);
                void persistSettingsNow();
            }
            return;
        }
        if (kind === 'tableTemplate') {
            const store = readTemplatePresets();
            if (!Object.prototype.hasOwnProperty.call(store.presets, defName)) {
                store.presets[defName] = {
                    templateStr: JSON.stringify(builtinDefault('tableTemplate')),
                    updatedAt: Date.now(),
                };
                writeTemplatePresets(store);
                void persistSettingsNow();
            }
            return;
        }
        if (kind === 'contentReplace') {
            const prof = readProfileSettings();
            prof.contentOptimizationSettings ||= {};
            prof.contentOptimizationSettings.promptPresets ||= [];
            if (!prof.contentOptimizationSettings.promptPresets.some((p) => p.name === defName)) {
                const doc = builtinDefault('contentReplace');
                doc.name = defName;
                prof.contentOptimizationSettings.promptPresets.push(doc);
                writeProfileSettings(prof);
                void persistSettingsNow();
            }
        }
    }

    function defaultPromptBundle(kind) {
        const prof = readProfileSettings();
        const meta = readGlobalMeta();
        const def = builtinDefault(kind);
        if (kind === 'promptFill') {
            return {
                version: 1,
                feature: kind,
                groups: {
                    ordinary: clone(Array.isArray(prof.charCardPrompt) && prof.charCardPrompt.length ? prof.charCardPrompt : def.groups.ordinary),
                    strictJson: clone(Array.isArray(prof.strictJsonCharCardPrompt) && prof.strictJsonCharCardPrompt.length ? prof.strictJsonCharCardPrompt : def.groups.strictJson),
                    strictSql: clone(Array.isArray(prof.strictJsonSqlCharCardPrompt) && prof.strictJsonSqlCharCardPrompt.length ? prof.strictJsonSqlCharCardPrompt : def.groups.strictSql),
                },
            };
        }
        if (kind === 'promptContinuation') {
            const existing =
                safeCall(() => api()?.continuation?.getSettings?.()) ||
                safeCall(() => ctx()?.chat?.[0]?.[CONT_FIELD]?.settings);
            const pending = readPendingChatPrompt('promptContinuation');
            const groups = {};
            groups.outline = clone(
                existing?.outlinePrompt || pending?.groups?.outline || def.groups.outline,
            );
            for (const key of CONTINUATION_GROUPS) {
                if (key === 'outline') continue;
                groups[key] = clone(
                    existing?.agentPrompts?.[key] || pending?.groups?.[key] || def.groups[key],
                );
            }
            return { version: 1, feature: kind, groups };
        }
        if (kind === 'promptSimulation') {
            const existing =
                safeCall(() => api()?.worldSimulation?.getSettings?.()) ||
                safeCall(() => ctx()?.chat?.[0]?.[SIM_FIELD]?.settings);
            const pending = readPendingChatPrompt('promptSimulation');
            const groups = {};
            for (const key of SIMULATION_GROUPS) {
                groups[key] = clone(
                    existing?.agentPrompts?.[key] || pending?.groups?.[key] || def.groups[key],
                );
            }
            return { version: 1, feature: kind, groups };
        }
        if (kind === 'promptKeyword') {
            const v = meta.vectorMemoryConfigGlobal || {};
            return {
                version: 1,
                feature: kind,
                groups: {
                    keyword: clone(Array.isArray(v.keywordPromptGroup) && v.keywordPromptGroup.length ? v.keywordPromptGroup : def.groups.keyword),
                },
            };
        }
        if (kind === 'promptSummary') {
            const v = meta.vectorMemoryConfigGlobal || {};
            return {
                version: 1,
                feature: kind,
                groups: {
                    summary: clone(Array.isArray(v.summaryPromptGroup) && v.summaryPromptGroup.length ? v.summaryPromptGroup : def.groups.summary),
                },
            };
        }
        if (kind === 'promptAssistant') {
            const segs =
                Array.isArray(prof.templateAssistantPromptSegments) && prof.templateAssistantPromptSegments.length
                    ? prof.templateAssistantPromptSegments
                    : def.groups.assistant;
            return {
                version: 1,
                feature: kind,
                groups: { assistant: clone(segs) },
            };
        }
        if (kind === 'promptAgent') {
            const native = safeCall(() => api()?.getAgentPromptTemplates?.());
            const awc = prof.plotSettings?.agentWorldbookControl || {};
            return {
                version: 1,
                feature: kind,
                groups: {
                    decision: clone(
                        native?.agentDecisionPromptSegments ||
                            awc.agentDecisionPromptSegments ||
                            prof.plotSettings?.agentDecisionPromptSegments ||
                            def.groups.decision,
                    ),
                    skillify: clone(
                        native?.agentSkillifyPromptSegments ||
                            awc.agentSkillifyPromptSegments ||
                            prof.plotSettings?.agentSkillifyPromptSegments ||
                            def.groups.skillify,
                    ),
                },
            };
        }
        throw Error('未知提示词功能类型：' + kind);
    }

    function pendingChatKey() {
        return 'pww_pending_chat_prompts_v1::' + currentProfileKey();
    }

    function readPendingChatPrompt(kind) {
        const ns = getNamespace(false);
        const all = parseJsonSafe(ns?.[pendingChatKey()], {});
        return all?.[kind] || null;
    }

    function writePendingChatPrompt(kind, bundle) {
        const ns = getNamespace(true);
        const all = parseJsonSafe(ns[pendingChatKey()], {});
        all[kind] = clone(bundle);
        ns[pendingChatKey()] = JSON.stringify(all);
        ns.__acuSettingsWrittenAt = Date.now();
    }

    async function readCurrentPrompt(kind, target) {
        const chosenTarget = target || SCOPES[kind]?.[0] || 'global';
        const scope = currentScope();
        const prof = readProfileSettings();

        if (kind === 'plot') {
            const ps = prof.plotSettings || {};
            const activeName = safeCall(() => api()?.getCurrentPlotPreset?.()) || ps.lastUsedPresetName || '';
            const defPlot = builtinDefault('plot');
            const raw = {
                name: activeName || '剧情推进',
                plotTasks: clone(Array.isArray(ps.plotTasks) && ps.plotTasks.length ? ps.plotTasks : defPlot.plotTasks),
                finalSystemDirective: ps.finalSystemDirective ?? defPlot.finalSystemDirective ?? '',
            };
            return {
                raw,
                scope,
                target: 'global',
                targetKey: 'global::plot',
                scopeLabel: activeName ? `剧情推进（${activeName}）` : '剧情推进',
                revision: fingerprint(raw),
            };
        }
        if (kind === 'tableTemplate') {
            const ns = getNamespace(false);
            const tplRaw = ns?.[profileTemplateKey(activeIsolationCode())];
            const native = !tplRaw ? safeCall(() => api()?.getTableTemplate?.({ scope: 'global' })) : null;
            const raw = tplRaw
                ? decodeTemplateDocument(tplRaw)
                : native
                  ? decodeTemplateDocument(native)
                  : builtinDefault('tableTemplate');
            const activeName = prof.currentTemplatePresetName || '';
            return {
                raw,
                scope,
                target: 'global',
                targetKey: 'global::tableTemplate',
                scopeLabel: activeName ? `表格模板（${activeName}）` : '表格模板',
                revision: fingerprint(raw),
            };
        }
        if (kind === 'contentReplace') {
            const cos = prof.contentOptimizationSettings || {};
            const defCr = builtinDefault('contentReplace');
            const raw = {
                name: '正文替换',
                promptGroup: clone(Array.isArray(cos.promptGroup) && cos.promptGroup.length ? cos.promptGroup : defCr.promptGroup),
            };
            return {
                raw,
                scope,
                target: 'global',
                targetKey: 'global::contentReplace',
                scopeLabel: '正文替换',
                revision: fingerprint(raw),
            };
        }
        if (kind === 'promptFill') {
            const raw = defaultPromptBundle(kind);
            return {
                raw,
                scope,
                target: 'global',
                targetKey: 'global::' + scope.profileKey,
                scopeLabel: '数据库当前实际配置（填表提示词）',
                revision: fingerprint(raw),
            };
        }
        if (kind === 'promptContinuation') {
            const live =
                safeCall(() => api()?.continuation?.getSettings?.()) ||
                safeCall(() => ctx()?.chat?.[0]?.[CONT_FIELD]?.settings);
            const initialized = Boolean(live);
            const raw = defaultPromptBundle(kind);
            return {
                raw,
                scope,
                target: 'chat',
                targetKey: 'chat::' + (scope.chatId || 'pending'),
                scopeLabel: !scope.hasChat
                    ? '智能续写（未检测到首楼 · 已绕过限制，可自由编辑并暂存待应用）'
                    : initialized
                      ? '当前聊天 · 智能续写'
                      : '当前聊天 · 智能续写（未初始化，应用时自动初始化）',
                initialized,
                revision: fingerprint(raw),
            };
        }
        if (kind === 'promptSimulation') {
            const live =
                safeCall(() => api()?.worldSimulation?.getSettings?.()) ||
                safeCall(() => ctx()?.chat?.[0]?.[SIM_FIELD]?.settings);
            const initialized = Boolean(live);
            const raw = defaultPromptBundle(kind);
            return {
                raw,
                scope,
                target: 'chat',
                targetKey: 'chat::' + (scope.chatId || 'pending'),
                scopeLabel: !scope.hasChat
                    ? '格林推演（未检测到首楼 · 已绕过限制，可自由编辑并暂存待应用）'
                    : initialized
                      ? '当前聊天 · 格林推演'
                      : '当前聊天 · 格林推演（未初始化，应用时自动初始化）',
                initialized,
                revision: fingerprint(raw),
            };
        }
        if (kind === 'promptKeyword' || kind === 'promptSummary') {
            const raw = defaultPromptBundle(kind);
            return {
                raw,
                scope,
                target: 'global',
                targetKey: 'global-vector',
                scopeLabel: '原生全局向量配置',
                revision: fingerprint(raw),
            };
        }
        if (kind === 'promptAssistant') {
            const raw = defaultPromptBundle(kind);
            const isEmptyNative = !Array.isArray(prof.templateAssistantPromptSegments) || !prof.templateAssistantPromptSegments.length;
            return {
                raw,
                scope,
                target: 'global',
                targetKey: 'global::' + scope.profileKey,
                scopeLabel: isEmptyNative ? '模板助手（数据库当前为空，使用内置默认）' : '数据库当前配置（模板助手）',
                revision: fingerprint(raw),
            };
        }
        if (kind === 'promptAgent') {
            if (chosenTarget === 'worldbook') {
                const wb = await readAgentWorldbookEntry();
                const fallback = defaultPromptBundle(kind);
                const raw = {
                    version: 1,
                    feature: kind,
                    groups: {
                        decision: clone(wb.control?.agentDecisionPromptSegments || fallback.groups.decision),
                        skillify: clone(wb.control?.agentSkillifyPromptSegments || fallback.groups.skillify),
                    },
                };
                return {
                    raw,
                    scope,
                    target: 'worldbook',
                    targetKey: 'worldbook::' + (wb.bookName || '未绑定'),
                    scopeLabel: '世界书 Agent · ' + (wb.bookName || '未绑定主世界书'),
                    revision: fingerprint(raw),
                };
            }
            const raw = defaultPromptBundle(kind);
            return {
                raw,
                scope,
                target: 'defaults',
                targetKey: 'defaults::' + scope.profileKey,
                scopeLabel: '世界书 Agent 全局默认',
                revision: fingerprint(raw),
            };
        }
        throw Error('不支持读取该类型的当前提示词：' + kind);
    }

    function validateName(name) {
        const s = String(name || '').trim();
        if (!s || s.length > 160 || ['__proto__', 'constructor', 'prototype'].includes(s))
            throw Error('预设名称无效或为空');
        return s;
    }

    const methods = {
        async capabilities() {
            const ns = getNamespace(false);
            const hasNativeApi = Boolean(api());
            const hasSettingsStore = Boolean(ns);
            const scope = currentScope();
            return {
                available: hasNativeApi || hasSettingsStore,
                version: '0.4.0-direct',
                mode: hasNativeApi ? 'direct+native-api' : 'direct-settings',
                serverStorage: true,
                hasNativeApi,
                hasSettingsStore,
                kinds: Object.keys(SCOPES),
                scopes: SCOPES,
                promptScope: scope,
                scope,
                features: readFeatureFlags(),
                message: hasNativeApi
                    ? '已直连数据库 1.3.x（免管理桥 · 公开 API + 设置直写）'
                    : hasSettingsStore
                      ? '已直连酒馆数据库设置（离线编辑模式，无需启用数据库插件）'
                      : '未检测到数据库设置记录；新建保存将自动创建数据库命名空间',
            };
        },

        async toggleFeature({ key, value }) {
            const bool = Boolean(value);
            const a = api();
            if (FEATURE_KEYS.includes(key) && typeof a?.features?.set === 'function') {
                const all = a.features.set(key, bool);
                return { features: { ...readFeatureFlags(), ...all }, needsReload: false };
            }
            const prof = readProfileSettings();
            if (key === 'plotEnabled') {
                prof.plotSettings ||= {};
                prof.plotSettings.enabled = bool;
                writeProfileSettings(prof);
            } else if (key === 'contentReplaceEnabled') {
                prof.contentOptimizationSettings ||= {};
                prof.contentOptimizationSettings.enabled = bool;
                writeProfileSettings(prof);
            } else if (key === 'vectorMemoryEnabled') {
                const meta = readGlobalMeta();
                meta.vectorMemoryConfigGlobal ||= {};
                meta.vectorMemoryConfigGlobal.enabled = bool;
                writeGlobalMeta(meta);
            } else if (FEATURE_KEYS.includes(key)) {
                prof[key] = bool;
                writeProfileSettings(prof);
            } else {
                throw Error('未知功能开关：' + key);
            }
            await persistSettingsNow();
            return { features: readFeatureFlags(), needsReload: Boolean(a) };
        },

        async list({ kind }) {
            ensureDefaultPreset(kind);
            const scope = currentScope();
            const prof = readProfileSettings();
            if (kind === 'plot') {
                const nativeList = safeCall(() => api()?.getPlotPresets?.());
                const storedList = prof.plotSettings?.promptPresets || [];
                const byName = new Map();
                for (const p of Array.isArray(nativeList) ? nativeList : []) byName.set(p.name, p);
                for (const p of storedList) if (!byName.has(p.name)) byName.set(p.name, p);
                const presets = [...byName.values()];
                const storedActive = prof.plotSettings?.lastUsedPresetName || '';
                const nativeActive = safeCall(() => api()?.getCurrentPlotPreset?.()) || '';
                let activeName =
                    (storedActive && presets.some((p) => p.name === storedActive) ? storedActive : '') ||
                    (nativeActive && presets.some((p) => p.name === nativeActive) ? nativeActive : '');
                if (!activeName || !presets.some((p) => p.name === activeName)) {
                    const liveFp = fingerprint(prof.plotSettings?.plotTasks || []);
                    const hit = presets.find((p) => fingerprint(p.plotTasks || []) === liveFp);
                    activeName = hit ? hit.name : '';
                }
                const bindings = prof.plotPresetBindings || {};
                const items = presets.map((p) => {
                    const inUse = [];
                    if (p.name === activeName) inUse.push('当前活动');
                    for (const [chatKey, boundName] of Object.entries(bindings)) {
                        if (boundName === p.name) inUse.push('聊天绑定：' + chatKey);
                    }
                    return { name: p.name, inUse, isActive: p.name === activeName };
                });
                return { kind, items, scope, activeName, matchedActive: Boolean(activeName) };
            }
            if (kind === 'tableTemplate') {
                const store = readTemplatePresets();
                const nativeNames = safeCall(() => api()?.getTemplatePresetNames?.());
                const names = Array.isArray(nativeNames) && nativeNames.length
                    ? [...new Set([...nativeNames, ...Object.keys(store.presets)])]
                    : Object.keys(store.presets);
                let activeName = prof.currentTemplatePresetName || '';
                if (!activeName || !names.includes(activeName)) {
                    const ns = getNamespace(false);
                    const liveTpl = ns?.[profileTemplateKey(activeIsolationCode())];
                    if (liveTpl) {
                        const liveFp = fingerprint(decodeTemplateDocument(liveTpl));
                        const hit = names.find((n) => {
                            try {
                                return store.presets[n] && fingerprint(decodeTemplateDocument(store.presets[n].templateStr ?? store.presets[n])) === liveFp;
                            } catch {
                                return false;
                            }
                        });
                        activeName = hit || '';
                    } else {
                        activeName = '';
                    }
                }
                const items = names.map((name) => ({
                    name,
                    inUse: name === activeName ? ['当前全局模板'] : [],
                    isActive: name === activeName,
                }));
                return { kind, items, scope, activeName, matchedActive: Boolean(activeName) };
            }
            if (kind === 'contentReplace') {
                const cos = prof.contentOptimizationSettings || {};
                const list = Array.isArray(cos.promptPresets) ? cos.promptPresets : [];
                let activeName = cos.currentPresetName && list.some((p) => p.name === cos.currentPresetName) ? cos.currentPresetName : '';
                if (!activeName) {
                    const livePg = Array.isArray(cos.promptGroup) && cos.promptGroup.length
                        ? cos.promptGroup
                        : builtinDefault('contentReplace').promptGroup;
                    const liveFp = fingerprint(livePg);
                    const hit = list.find((p) => fingerprint(p.promptGroup || []) === liveFp);
                    activeName = hit ? hit.name : '';
                }
                const items = list.map((p) => ({
                    name: p.name,
                    inUse: p.name === activeName ? ['当前使用'] : [],
                    isActive: p.name === activeName,
                }));
                return { kind, items, scope, activeName, matchedActive: Boolean(activeName) };
            }
            if (isPromptKind(kind)) {
                const lib = readPromptLibrary();
                const bucket = lib.items?.[kind] || {};
                const cur = await readCurrentPrompt(kind);
                const liveFp = fingerprint(cur.raw.groups);
                let activeName = '';
                // 1) 优先匹配当前作用域最近一次显式应用的预设绑定（避免同内容预设冲突或 shujuku 规范化字段导致绿灯不切换）
                const matchedBinding = (lib.bindings || []).find(
                    (b) => b.kind === kind && b.targetKey === cur.targetKey && bucket[b.name],
                );
                if (matchedBinding) {
                    const boundItem = bucket[matchedBinding.name];
                    const boundItemFp = boundItem?.raw?.groups ? fingerprint(boundItem.raw.groups) : '';
                    const appliedFp = matchedBinding.raw?.groups ? fingerprint(matchedBinding.raw.groups) : '';
                    if (
                        (boundItemFp && boundItemFp === liveFp) ||
                        (appliedFp && boundItemFp === appliedFp && (!cur.initialized || matchedBinding.appliedAt))
                    ) {
                        activeName = matchedBinding.name;
                    }
                }
                // 2) 若当前配置在外部被改动，回退按精确内容指纹查找匹配项
                if (!activeName) {
                    for (const [name, entry] of Object.entries(bucket)) {
                        if (entry?.raw?.groups && fingerprint(entry.raw.groups) === liveFp) {
                            activeName = name;
                            break;
                        }
                    }
                }
                const items = Object.keys(bucket).map((name) => ({
                    name,
                    inUse: (lib.bindings || [])
                        .filter((b) => b.kind === kind && b.name === name)
                        .map((b) => b.label || b.target),
                    isActive: name === activeName,
                }));
                return { kind, items, scope, activeName, matchedActive: Boolean(activeName) };
            }
            throw Error('不支持的数据库文档类型：' + kind);
        },

        async read({ kind, name }) {
            ensureDefaultPreset(kind);
            const scope = currentScope();
            const prof = readProfileSettings();
            if (kind === 'plot') {
                const native = safeCall(() => api()?.getPlotPresetDetails?.(name));
                const list = prof.plotSettings?.promptPresets || [];
                const found = native || list.find((p) => p.name === name);
                if (!found) throw Error('找不到剧情推进预设：' + name);
                const raw = clone(found);
                return { kind, name, raw, revision: fingerprint(raw), scope, inUse: [] };
            }
            if (kind === 'tableTemplate') {
                const store = readTemplatePresets();
                let raw = null;
                if (store.presets?.[name]) {
                    raw = decodeTemplateDocument(store.presets[name].templateStr ?? store.presets[name]);
                } else if (api()?.getTableTemplate) {
                    const got = safeCall(() => api().getTableTemplate({ scope: 'global', presetName: name }));
                    if (got) raw = decodeTemplateDocument(got);
                }
                if (!raw) throw Error('找不到表格模板预设：' + name);
                return { kind, name, raw, revision: fingerprint(raw), scope, inUse: [] };
            }
            if (kind === 'contentReplace') {
                const cos = prof.contentOptimizationSettings || {};
                const found = (cos.promptPresets || []).find((p) => p.name === name);
                if (!found) throw Error('找不到正文替换预设：' + name);
                const raw = clone(found);
                return { kind, name, raw, revision: fingerprint(raw), scope, inUse: [] };
            }
            if (isPromptKind(kind)) {
                const lib = readPromptLibrary();
                const item = lib.items?.[kind]?.[name];
                if (!item) throw Error('找不到提示词预设：' + name);
                const bindings = (lib.bindings || []).filter((b) => b.kind === kind && b.name === name);
                const raw = clone(item.raw);
                return {
                    kind,
                    name,
                    raw,
                    revision: fingerprint(raw),
                    scope,
                    bindings: bindings.map(({ key, label, target }) => ({ key, label, target })),
                    inUse: bindings.map((b) => b.label || b.target),
                };
            }
            throw Error('不支持的数据库文档类型：' + kind);
        },

        async defaults({ kind }) {
            return builtinDefault(kind);
        },

        async save({ kind, name, raw, create = false }) {
            const cleanName = validateName(name);
            const scope = currentScope();
            const a = api();
            let needsReload = false;

            if (kind === 'plot') {
                const doc = clone(raw);
                doc.name = cleanName;
                const backup = await createDbBackup('plot-save-' + cleanName, readProfileSettings().plotSettings?.promptPresets || []);
                if (typeof a?.importPlotPresetFromData === 'function') {
                    const existing = (a.getPlotPresetNames?.() || []).includes(cleanName);
                    if (create && existing) throw Error('剧情预设名称已存在，请换一个名称');
                    const res = await a.importPlotPresetFromData(doc, { overwrite: !create, switchTo: false });
                    if (!res?.success) throw Error(res?.message || '剧情预设保存失败');
                } else {
                    const prof = readProfileSettings();
                    prof.plotSettings ||= {};
                    prof.plotSettings.promptPresets ||= [];
                    const idx = prof.plotSettings.promptPresets.findIndex((p) => p.name === cleanName);
                    if (create && idx >= 0) throw Error('剧情预设名称已存在，请换一个名称');
                    if (idx >= 0) prof.plotSettings.promptPresets[idx] = doc;
                    else prof.plotSettings.promptPresets.push(doc);
                    writeProfileSettings(prof);
                    await persistSettingsNow();
                    needsReload = Boolean(a);
                }
                return {
                    kind,
                    name: cleanName,
                    raw: doc,
                    revision: fingerprint(doc),
                    scope,
                    storageType: 'tavern',
                    backup,
                    needsReload,
                };
            }

            if (kind === 'tableTemplate') {
                const doc = decodeTemplateDocument(clone(raw));
                const store = readTemplatePresets();
                if (create && Object.prototype.hasOwnProperty.call(store.presets, cleanName))
                    throw Error('表格模板预设名称已存在，请换一个名称');
                const backup = await createDbBackup('template-save-' + cleanName, store.presets[cleanName] || null);
                if (typeof a?.importTemplateFromData === 'function') {
                    const res = await a.importTemplateFromData(doc, { scope: 'global', presetName: cleanName });
                    if (!res?.success) throw Error(res?.message || '表格模板保存失败');
                } else {
                    store.presets[cleanName] = {
                        templateStr: JSON.stringify(doc),
                        updatedAt: Date.now(),
                    };
                    writeTemplatePresets(store);
                    await persistSettingsNow();
                    needsReload = Boolean(a);
                }
                return {
                    kind,
                    name: cleanName,
                    raw: doc,
                    revision: fingerprint(doc),
                    scope,
                    storageType: 'tavern',
                    backup,
                    needsReload,
                };
            }

            if (kind === 'contentReplace') {
                const doc = clone(raw);
                doc.name = cleanName;
                const prof = readProfileSettings();
                prof.contentOptimizationSettings ||= {};
                const backup = await createDbBackup('contentReplace-save-' + cleanName, prof.contentOptimizationSettings);
                if (cleanName === '当前运行正文替换') {
                    prof.contentOptimizationSettings.promptGroup = clone(doc.promptGroup || []);
                } else {
                    prof.contentOptimizationSettings.promptPresets ||= [];
                    const idx = prof.contentOptimizationSettings.promptPresets.findIndex((p) => p.name === cleanName);
                    if (create && idx >= 0) throw Error('正文替换预设名称已存在，请换一个名称');
                    if (idx >= 0) prof.contentOptimizationSettings.promptPresets[idx] = doc;
                    else prof.contentOptimizationSettings.promptPresets.push(doc);
                }
                writeProfileSettings(prof);
                await persistSettingsNow();
                return {
                    kind,
                    name: cleanName,
                    raw: doc,
                    revision: fingerprint(doc),
                    scope,
                    storageType: 'tavern',
                    backup,
                    needsReload: Boolean(a),
                };
            }

            if (isPromptKind(kind)) {
                const lib = readPromptLibrary();
                lib.items[kind] ||= {};
                if (create && Object.prototype.hasOwnProperty.call(lib.items[kind], cleanName))
                    throw Error('提示词预设名称已存在，请换一个名称');
                const doc = clone(raw);
                lib.items[kind][cleanName] = { raw: doc, updatedAt: Date.now() };
                writePromptLibrary(lib);
                await persistSettingsNow();
                return {
                    kind,
                    name: cleanName,
                    raw: doc,
                    revision: fingerprint(doc),
                    scope,
                    storageType: 'tavern',
                    needsReload: false,
                };
            }

            throw Error('不支持保存此数据库文档类型：' + kind);
        },

        async rename({ kind, oldName, name }) {
            const newName = validateName(name);
            const a = api();
            if (kind === 'plot') {
                const prof = readProfileSettings();
                const list = prof.plotSettings?.promptPresets || [];
                if (list.some((p) => p.name === newName)) throw Error('目标名称已存在');
                const item = list.find((p) => p.name === oldName);
                if (!item) throw Error('原预设不存在');
                const backup = await createDbBackup('plot-rename-' + oldName, list);
                item.name = newName;
                if (prof.plotSettings.lastUsedPresetName === oldName) prof.plotSettings.lastUsedPresetName = newName;
                writeProfileSettings(prof);
                await persistSettingsNow();
                return { kind, name: newName, storageType: 'tavern', backup, needsReload: Boolean(a) };
            }
            if (kind === 'tableTemplate') {
                const store = readTemplatePresets();
                if (!store.presets[oldName]) throw Error('原模板不存在');
                if (store.presets[newName]) throw Error('目标名称已存在');
                const backup = await createDbBackup('template-rename-' + oldName, store.presets[oldName]);
                store.presets[newName] = { ...store.presets[oldName], updatedAt: Date.now() };
                delete store.presets[oldName];
                writeTemplatePresets(store);
                await persistSettingsNow();
                return { kind, name: newName, storageType: 'tavern', backup, needsReload: Boolean(a) };
            }
            if (kind === 'contentReplace') {
                const prof = readProfileSettings();
                const list = prof.contentOptimizationSettings?.promptPresets || [];
                if (list.some((p) => p.name === newName)) throw Error('目标名称已存在');
                const item = list.find((p) => p.name === oldName);
                if (!item) throw Error('原预设不存在');
                item.name = newName;
                writeProfileSettings(prof);
                await persistSettingsNow();
                return { kind, name: newName, storageType: 'tavern', needsReload: Boolean(a) };
            }
            if (isPromptKind(kind)) {
                const lib = readPromptLibrary();
                if (!lib.items?.[kind]?.[oldName]) throw Error('原预设不存在');
                if (lib.items[kind][newName]) throw Error('目标名称已存在');
                lib.items[kind][newName] = lib.items[kind][oldName];
                delete lib.items[kind][oldName];
                for (const b of lib.bindings) if (b.kind === kind && b.name === oldName) b.name = newName;
                writePromptLibrary(lib);
                await persistSettingsNow();
                return { kind, name: newName, storageType: 'tavern', needsReload: false };
            }
            throw Error('不支持重命名此类型');
        },

        async delete({ kind, name }) {
            const a = api();
            if (name === DEFAULT_PRESET_NAME[kind]) markDefaultDeleted(kind);
            if (kind === 'plot') {
                const prof = readProfileSettings();
                const list = prof.plotSettings?.promptPresets || [];
                const backup = await createDbBackup('plot-delete-' + name, list);
                prof.plotSettings.promptPresets = list.filter((p) => p.name !== name);
                writeProfileSettings(prof);
                await persistSettingsNow();
                return { kind, name, storageType: 'tavern', backup, needsReload: Boolean(a) };
            }
            if (kind === 'tableTemplate') {
                const store = readTemplatePresets();
                const backup = await createDbBackup('template-delete-' + name, store.presets[name] || null);
                delete store.presets[name];
                writeTemplatePresets(store);
                await persistSettingsNow();
                return { kind, name, storageType: 'tavern', backup, needsReload: Boolean(a) };
            }
            if (kind === 'contentReplace') {
                const prof = readProfileSettings();
                const list = prof.contentOptimizationSettings?.promptPresets || [];
                const backup = await createDbBackup('contentReplace-delete-' + name, list);
                prof.contentOptimizationSettings.promptPresets = list.filter((p) => p.name !== name);
                writeProfileSettings(prof);
                await persistSettingsNow();
                return { kind, name, storageType: 'tavern', backup, needsReload: Boolean(a) };
            }
            if (isPromptKind(kind)) {
                const lib = readPromptLibrary();
                const backup = await createDbBackup('prompt-delete-' + name, lib.items?.[kind]?.[name] || null);
                if (lib.items?.[kind]) delete lib.items[kind][name];
                lib.bindings = (lib.bindings || []).filter((b) => !(b.kind === kind && b.name === name));
                writePromptLibrary(lib);
                await persistSettingsNow();
                return { kind, name, storageType: 'tavern', backup, needsReload: false };
            }
            throw Error('不支持删除此类型');
        },

        async current({ kind, target }) {
            ensureDefaultPreset(kind);
            const cur = await readCurrentPrompt(kind, target);
            const cat = await methods.list({ kind });
            return {
                ...cur,
                activeName: cat.activeName || '',
                matchedActive: Boolean(cat.matchedActive),
            };
        },

        async importPrompt({ kind, raw }) {
            if (!isPromptKind(kind)) return raw;
            if (raw?.version === 1 && raw?.feature === kind && raw?.groups) return raw;
            if (Array.isArray(raw)) {
                const def = defaultPromptBundle(kind);
                const firstKey = Object.keys(def.groups)[0];
                def.groups[firstKey] = clone(raw);
                return def;
            }
            return raw;
        },

        async unlink({ kind, name, binding }) {
            const lib = readPromptLibrary();
            lib.bindings = (lib.bindings || []).filter((b) => {
                if (b.kind !== kind || b.name !== name) return true;
                return binding !== 'all' && b.key !== binding;
            });
            writePromptLibrary(lib);
            await persistSettingsNow();
            return { kind, name, storageType: 'tavern', needsReload: false };
        },

        async readSettings({ kind }) {
            const prof = readProfileSettings();
            const meta = readGlobalMeta();
            const scope = currentScope();
            const apiPresetNames = (prof.apiPresets || []).map((p) => p.name).filter(Boolean);
            let value = {};
            if (kind === 'plot') {
                const ps = prof.plotSettings || {};
                value = {
                    enabled: Boolean(ps.enabled),
                    plotApiPreset: prof.plotApiPreset || '',
                    minLength: ps.minLength ?? 0,
                    contextTurnCount: ps.contextTurnCount ?? 6,
                    extractTags: ps.extractTags || '',
                    extractInjectTags: ps.extractInjectTags || '',
                };
            } else if (kind === 'tableTemplate') {
                value = {
                    autoUpdateEnabled: prof.autoUpdateEnabled !== false,
                    tableApiPreset: prof.tableApiPreset || '',
                    autoUpdateThreshold: prof.autoUpdateThreshold ?? 3,
                    autoUpdateFrequency: prof.autoUpdateFrequency ?? 1,
                    updateBatchSize: prof.updateBatchSize ?? 2,
                    tableFillMinResponseLength: prof.tableFillMinResponseLength ?? 0,
                    standardizedTableFillEnabled: prof.standardizedTableFillEnabled !== false,
                    strictJsonTableFillEnabled: Boolean(prof.strictJsonTableFillEnabled),
                };
            } else if (kind === 'contentReplace') {
                const cos = prof.contentOptimizationSettings || {};
                value = {
                    enabled: Boolean(cos.enabled),
                    apiPreset: cos.apiPreset || '',
                    seamlessMode: Boolean(cos.seamlessMode),
                    autoApply: Boolean(cos.autoApply),
                    showDiff: cos.showDiff !== false,
                    minLength: cos.minLength ?? 0,
                    maxOptimizations: cos.maxOptimizations ?? 1,
                    loopCount: cos.loopCount ?? 1,
                    retryCount: cos.retryCount ?? 2,
                    extractTags: cos.extractTags || '',
                    excludeTags: cos.excludeTags || '',
                };
            } else {
                value = {
                    ...readFeatureFlags(),
                    vectorMemoryEnabled: Boolean(meta.vectorMemoryConfigGlobal?.enabled),
                };
            }
            return {
                kind,
                value,
                apiPresetNames,
                revision: fingerprint(value),
                scope,
            };
        },

        async saveSettings({ kind, value }) {
            const prof = readProfileSettings();
            const backup = await createDbBackup('settings-' + kind, prof);
            const a = api();
            let needsReload = Boolean(a);
            if (kind === 'plot') {
                prof.plotSettings ||= {};
                prof.plotSettings.enabled = Boolean(value.enabled);
                if (value.plotApiPreset !== undefined) prof.plotApiPreset = String(value.plotApiPreset || '');
                if (value.minLength !== undefined) prof.plotSettings.minLength = Number(value.minLength) || 0;
                if (value.contextTurnCount !== undefined)
                    prof.plotSettings.contextTurnCount = Number(value.contextTurnCount) || 6;
                if (value.extractTags !== undefined) prof.plotSettings.extractTags = String(value.extractTags || '');
                if (value.extractInjectTags !== undefined)
                    prof.plotSettings.extractInjectTags = String(value.extractInjectTags || '');
                writeProfileSettings(prof);
            } else if (kind === 'tableTemplate') {
                if (typeof a?.setUpdateConfigParams === 'function') {
                    a.setUpdateConfigParams({
                        autoUpdateThreshold: Number(value.autoUpdateThreshold ?? 3),
                        autoUpdateFrequency: Number(value.autoUpdateFrequency ?? 1),
                        updateBatchSize: Number(value.updateBatchSize ?? 2),
                    });
                }
                if (typeof a?.features?.set === 'function') {
                    a.features.set('autoUpdateEnabled', Boolean(value.autoUpdateEnabled));
                }
                const freshProf = readProfileSettings();
                freshProf.autoUpdateEnabled = Boolean(value.autoUpdateEnabled);
                if (value.tableApiPreset !== undefined) freshProf.tableApiPreset = String(value.tableApiPreset || '');
                freshProf.autoUpdateThreshold = Number(value.autoUpdateThreshold ?? 3);
                freshProf.autoUpdateFrequency = Number(value.autoUpdateFrequency ?? 1);
                freshProf.updateBatchSize = Number(value.updateBatchSize ?? 2);
                freshProf.tableFillMinResponseLength = Number(value.tableFillMinResponseLength ?? 0);
                freshProf.standardizedTableFillEnabled = Boolean(value.standardizedTableFillEnabled);
                freshProf.strictJsonTableFillEnabled = Boolean(value.strictJsonTableFillEnabled);
                writeProfileSettings(freshProf);
            } else if (kind === 'contentReplace') {
                prof.contentOptimizationSettings ||= {};
                Object.assign(prof.contentOptimizationSettings, {
                    enabled: Boolean(value.enabled),
                    apiPreset: String(value.apiPreset || ''),
                    seamlessMode: Boolean(value.seamlessMode),
                    autoApply: Boolean(value.autoApply),
                    showDiff: Boolean(value.showDiff),
                    minLength: Number(value.minLength ?? 0),
                    maxOptimizations: Number(value.maxOptimizations ?? 1),
                    loopCount: Number(value.loopCount ?? 1),
                    retryCount: Number(value.retryCount ?? 2),
                    extractTags: String(value.extractTags || ''),
                    excludeTags: String(value.excludeTags || ''),
                });
                writeProfileSettings(prof);
            }
            await persistSettingsNow();
            const fresh = await methods.readSettings({ kind });
            return { ...fresh, storageType: 'tavern', backup, needsReload };
        },

        async previewApply({ kind, name, applyScope, target }) {
            const chosen = applyScope || target || SCOPES[kind]?.[0] || 'global';
            const token = uuid();
            if (isPromptKind(kind)) {
                const doc = await methods.read({ kind, name });
                const cur = await readCurrentPrompt(kind, chosen);
                let warning = '仅更新提示词，不触发生成、不修改 API 或运行参数。';
                const hasChat = currentScope().hasChat;
                if ((kind === 'promptContinuation' || kind === 'promptSimulation') && !hasChat) {
                    warning =
                        '当前未检测到可用聊天首楼（已绕过首楼不可用限制）；确认后将存入「待应用默认配置」，打开任意有效聊天后再应用即可写入首楼。';
                } else if ((kind === 'promptContinuation' || kind === 'promptSimulation') && !cur.initialized) {
                    warning =
                        '当前聊天尚未初始化该功能资料；确认后将自动按 shujuku 1.3.8 合法结构直接初始化并写入当前聊天第 0 楼（即使该功能当前未启用）。';
                }
                previewTokens.set(token, {
                    kind,
                    name,
                    target: chosen,
                    doc: doc.raw,
                    before: cur.raw,
                    scopeLabel: cur.scopeLabel,
                    targetKey: cur.targetKey,
                    initialized: cur.initialized,
                    hasChat,
                });
                return {
                    token,
                    before: cur.raw,
                    after: doc.raw,
                    scopeLabel: cur.scopeLabel,
                    warning,
                    initialized: cur.initialized,
                };
            }
            const doc = await methods.read({ kind, name });
            previewTokens.set(token, { kind, name, applyScope: chosen, doc: doc.raw });
            return {
                token,
                affectsChat: chosen === 'chat' || kind === 'tableTemplate',
                audit: [],
                confirmationRequired: false,
                warning:
                    kind === 'tableTemplate'
                        ? '将通过数据库原生模板接口切换并执行结构协调（如使用直写路径需刷新酒馆生效）。'
                        : kind === 'plot'
                          ? '将把该剧情预设设为当前活动预设，不会自动触发剧情推进。'
                          : '将写入数据库正文替换运行提示词，仅对后续替换生效，不修改历史消息。',
            };
        },

        async apply({ token, confirmedDestructive = false, enableFeature = false }) {
            const plan = previewTokens.get(token);
            if (!plan) throw Error('应用预览已过期，请重新预览');
            previewTokens.delete(token);
            const a = api();
            let needsReload = false;

            if (plan.kind === 'plot') {
                const backup = await createDbBackup('plot-apply-' + plan.name, readProfileSettings().plotSettings || {});
                let switchedNative = false;
                if (typeof a?.switchPlotPreset === 'function') {
                    switchedNative = Boolean(safeCall(() => a.switchPlotPreset(plan.name)));
                }
                if (!switchedNative || plan.applyScope !== 'chat') {
                    const prof = readProfileSettings();
                    prof.plotSettings ||= {};
                    prof.plotSettings.lastUsedPresetName = plan.name;
                    prof.plotSettings.plotTasks = clone(plan.doc.plotTasks || []);
                    if (plan.doc.finalSystemDirective !== undefined)
                        prof.plotSettings.finalSystemDirective = plan.doc.finalSystemDirective;
                    writeProfileSettings(prof);
                    await persistSettingsNow();
                    needsReload = Boolean(a) && !switchedNative;
                }
                const catalog = await methods.list({ kind: plan.kind });
                return { kind: plan.kind, name: plan.name, storageType: 'tavern', backup, needsReload, catalog };
            }

            if (plan.kind === 'tableTemplate') {
                const backup = await createDbBackup('template-apply-' + plan.name, plan.doc);
                if (typeof a?.switchTemplatePreset === 'function') {
                    const res = await a.switchTemplatePreset(plan.name, {
                        scope: plan.applyScope || 'global',
                        destructiveChangeConfirmed: Boolean(confirmedDestructive),
                    });
                    if (!res?.success) throw Error(res?.message || res?.error || '切换表格模板失败');
                    const prof = readProfileSettings();
                    if (prof.currentTemplatePresetName !== plan.name) {
                        prof.currentTemplatePresetName = plan.name;
                        writeProfileSettings(prof);
                    }
                    const catalog = await methods.list({ kind: plan.kind });
                    return {
                        kind: plan.kind,
                        name: plan.name,
                        storageType: 'tavern',
                        backup,
                        runtimeReady: res.runtimeReady,
                        warning: res.warning,
                        needsReload: false,
                        catalog,
                    };
                }
                const ns = getNamespace(true);
                ns[profileTemplateKey(activeIsolationCode())] = JSON.stringify(plan.doc);
                const prof = readProfileSettings();
                prof.currentTemplatePresetName = plan.name;
                writeProfileSettings(prof);
                await persistSettingsNow();
                const catalog = await methods.list({ kind: plan.kind });
                return { kind: plan.kind, name: plan.name, storageType: 'tavern', backup, needsReload: Boolean(a), catalog };
            }

            if (plan.kind === 'contentReplace') {
                const prof = readProfileSettings();
                const backup = await createDbBackup('contentReplace-apply-' + plan.name, prof.contentOptimizationSettings || {});
                prof.contentOptimizationSettings ||= {};
                prof.contentOptimizationSettings.promptGroup = clone(plan.doc.promptGroup || []);
                prof.contentOptimizationSettings.currentPresetName = plan.name;
                if (enableFeature) prof.contentOptimizationSettings.enabled = true;
                writeProfileSettings(prof);
                await persistSettingsNow();
                const catalog = await methods.list({ kind: plan.kind });
                return { kind: plan.kind, name: plan.name, storageType: 'tavern', backup, needsReload: Boolean(a), catalog };
            }

            if (isPromptKind(plan.kind)) {
                const backup = await createDbBackup('prompt-apply-' + plan.kind + '-' + plan.name, plan.before);
                const g = plan.doc.groups;

                if (plan.kind === 'promptFill') {
                    const prof = readProfileSettings();
                    if (g.ordinary) prof.charCardPrompt = clone(g.ordinary);
                    if (g.strictJson) prof.strictJsonCharCardPrompt = clone(g.strictJson);
                    if (g.strictSql) prof.strictJsonSqlCharCardPrompt = clone(g.strictSql);
                    writeProfileSettings(prof);
                    await persistSettingsNow();
                    needsReload = Boolean(a);
                } else if (plan.kind === 'promptAssistant') {
                    const prof = readProfileSettings();
                    if (g.assistant) prof.templateAssistantPromptSegments = clone(g.assistant);
                    writeProfileSettings(prof);
                    await persistSettingsNow();
                    needsReload = Boolean(a);
                } else if (plan.kind === 'promptKeyword' || plan.kind === 'promptSummary') {
                    const meta = readGlobalMeta();
                    meta.vectorMemoryConfigGlobal ||= {};
                    if (plan.kind === 'promptKeyword' && g.keyword)
                        meta.vectorMemoryConfigGlobal.keywordPromptGroup = clone(g.keyword);
                    if (plan.kind === 'promptSummary' && g.summary)
                        meta.vectorMemoryConfigGlobal.summaryPromptGroup = clone(g.summary);
                    writeGlobalMeta(meta);
                    await persistSettingsNow();
                    needsReload = Boolean(a);
                } else if (plan.kind === 'promptAgent') {
                    if (plan.target === 'worldbook') {
                        const wb = await readAgentWorldbookEntry();
                        if (!wb.bookName || !wb.bookData) throw Error('当前未绑定可写入的主世界书或聊天世界书');
                        const entries = wb.bookData.entries || {};
                        let key = wb.entryKey;
                        if (key === null) {
                            let uid = 0;
                            const used = new Set(Object.values(entries).map((e) => Number(e.uid)));
                            while (used.has(uid)) uid++;
                            key = String(uid);
                            entries[key] = {
                                uid,
                                comment: AGENT_WB_COMMENT,
                                key: [],
                                keysecondary: [],
                                content: JSON.stringify({ control: {} }),
                                disable: true,
                                constant: false,
                                selective: true,
                                order: 0,
                                position: 0,
                            };
                        }
                        const payload = parseJsonSafe(entries[key].content, {});
                        const ctrl = payload.control && typeof payload.control === 'object' ? payload.control : payload;
                        if (g.decision) ctrl.agentDecisionPromptSegments = clone(g.decision);
                        if (g.skillify) ctrl.agentSkillifyPromptSegments = clone(g.skillify);
                        entries[key].content = JSON.stringify(payload);
                        await post('/api/worldinfo/edit', { name: wb.bookName, data: wb.bookData });
                        const { world } = await modules();
                        world.worldInfoCache?.set?.(wb.bookName, clone(wb.bookData));
                    } else if (typeof a?.setAgentPromptTemplates === 'function') {
                        const ok = a.setAgentPromptTemplates({
                            agentDecisionPromptSegments: clone(g.decision || []),
                            agentSkillifyPromptSegments: clone(g.skillify || []),
                        });
                        if (!ok) throw Error('设置世界书 Agent 默认提示词失败');
                    } else {
                        const prof = readProfileSettings();
                        prof.plotSettings ||= {};
                        prof.plotSettings.agentWorldbookControl ||= {};
                        if (g.decision) {
                            prof.plotSettings.agentWorldbookControl.agentDecisionPromptSegments = clone(g.decision);
                            prof.plotSettings.agentDecisionPromptSegments = clone(g.decision);
                        }
                        if (g.skillify) {
                            prof.plotSettings.agentWorldbookControl.agentSkillifyPromptSegments = clone(g.skillify);
                            prof.plotSettings.agentSkillifyPromptSegments = clone(g.skillify);
                        }
                        writeProfileSettings(prof);
                        await persistSettingsNow();
                        needsReload = Boolean(a);
                    }
                } else if (plan.kind === 'promptContinuation') {
                    const c = ctx();
                    const agentPrompts = {};
                    for (const k of CONTINUATION_GROUPS) if (k !== 'outline' && g[k]) agentPrompts[k] = clone(g[k]);
                    writePendingChatPrompt('promptContinuation', plan.doc);
                    if (Array.isArray(c?.chat) && c.chat.length > 0 && c.chat[0]) {
                        let appliedViaNative = false;
                        const hasLive = Boolean(safeCall(() => a?.continuation?.getSettings?.()));
                        if (hasLive && typeof a?.continuation?.updateSettings === 'function') {
                            try {
                                await a.continuation.updateSettings({
                                    outlinePrompt: clone(g.outline),
                                    agentPrompts,
                                });
                                appliedViaNative = true;
                            } catch {
                                // 首楼或运行时受限时自动降级为直接写 chat[0]
                            }
                        }
                        if (!appliedViaNative) {
                            const existing = c.chat[0][CONT_FIELD];
                            const baseSettings = existing?.settings
                                ? clone(existing.settings)
                                : defaultContinuationSettings(g);
                            baseSettings.outlinePrompt = clone(g.outline || baseSettings.outlinePrompt);
                            baseSettings.agentPrompts = { ...baseSettings.agentPrompts, ...agentPrompts };
                            c.chat[0][CONT_FIELD] = {
                                schemaVersion: 1,
                                settings: baseSettings,
                                activeTask: existing?.activeTask ?? null,
                            };
                            await persistChatNow();
                        }
                    }
                    if (enableFeature) await methods.toggleFeature({ key: 'continuationPageEnabled', value: true });
                } else if (plan.kind === 'promptSimulation') {
                    const c = ctx();
                    const agentPrompts = {};
                    for (const k of SIMULATION_GROUPS) if (g[k]) agentPrompts[k] = clone(g[k]);
                    writePendingChatPrompt('promptSimulation', plan.doc);
                    if (Array.isArray(c?.chat) && c.chat.length > 0 && c.chat[0]) {
                        let appliedViaNative = false;
                        const hasLive = Boolean(safeCall(() => a?.worldSimulation?.getSettings?.()));
                        if (hasLive && typeof a?.worldSimulation?.updateSettings === 'function') {
                            try {
                                await a.worldSimulation.updateSettings({ agentPrompts });
                                appliedViaNative = true;
                            } catch {
                                // 降级直接写入 chat[0]
                            }
                        }
                        if (!appliedViaNative) {
                            const existing = c.chat[0][SIM_FIELD];
                            const baseSettings = existing?.settings
                                ? clone(existing.settings)
                                : defaultSimulationSettings(g);
                            baseSettings.agentPrompts = { ...baseSettings.agentPrompts, ...agentPrompts };
                            c.chat[0][SIM_FIELD] = existing
                                ? { ...clone(existing), settings: baseSettings, updatedAt: Date.now() }
                                : {
                                      schemaVersion: 1,
                                      settings: baseSettings,
                                      task: null,
                                      stages: [],
                                      activeStageId: null,
                                      timeline: [],
                                      lastError: null,
                                      ledger: emptySimulationLedger(),
                                      updatedAt: Date.now(),
                                  };
                            await persistChatNow();
                        }
                    }
                    if (enableFeature) await methods.toggleFeature({ key: 'worldSimulationPageEnabled', value: true });
                }

                // 记录使用关联（附带 appliedAt 供 list() 优先精准亮起所选预设的绿灯）
                const lib = readPromptLibrary();
                lib.bindings = (lib.bindings || []).filter(
                    (b) => !(b.kind === plan.kind && b.targetKey === plan.targetKey),
                );
                lib.bindings.push({
                    key: uuid(),
                    kind: plan.kind,
                    name: plan.name,
                    target: plan.target,
                    targetKey: plan.targetKey,
                    label: plan.scopeLabel,
                    raw: clone(plan.doc),
                    appliedAt: Date.now(),
                });
                writePromptLibrary(lib);
                await persistSettingsNow();
                const catalog = await methods.list({ kind: plan.kind });

                return {
                    kind: plan.kind,
                    name: plan.name,
                    storageType: 'tavern',
                    backup,
                    needsReload,
                    catalog,
                };
            }

            throw Error('不支持应用此类型：' + plan.kind);
        },
    };

    return {
        async call(method, args = {}) {
            if (!Object.hasOwn(methods, method)) throw Error('不允许的数据库管理操作：' + method);
            return await methods[method](clone(args));
        },
    };
}
