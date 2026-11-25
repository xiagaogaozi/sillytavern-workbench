// 所有酒馆读写集中于此；UI 无权执行任意宿主代码。
import { clone, equal, assertDocument, uuid } from './core.js';
import { createDatabaseHost } from './database-host.js';
import { createCharacterHost } from './character-host.js';
import { createChatHost } from './chat-host.js';
const CONFIG_FILE = 'preset-worldbook-workbench-settings-v1.json';
const CONFIG_URL = '/user/files/' + CONFIG_FILE;
let durableConfig = null,
    configRevision = null,
    configQueue = Promise.resolve(),
    cachedModules = null,
    dbHost = null,
    charHost = null,
    chatHost = null;
const KEY = 'presetWorldbookWorkbench',
    TITLE = '酒馆工作台';
const BASE = new URL('../', import.meta.url),
    themes = [
        '--SmartThemeBodyColor',
        '--SmartThemeEmColor',
        '--SmartThemeBorderColor',
        '--SmartThemeBlurTintColor',
        '--SmartThemeChatTintColor',
        '--SmartThemeUserMesBlurTintColor',
        '--SmartThemeBotMesBlurTintColor',
        '--SmartThemeQuoteColor',
        '--SmartThemeShadowColor',
        '--SmartThemeUnderlineColor',
        '--mainFontSize',
        '--mainFontFamily',
        '--monoFontFamily',
    ];
let frame,
    overlay,
    token,
    cleanFetch,
    activeGeneration,
    saveQueue = Promise.resolve(),
    activeEntries = [];
const ctx = () => window.SillyTavern.getContext();
const send = (event, value) =>
    frame?.contentWindow?.postMessage({ pww: true, token, event, value }, location.origin);
async function post(url, data, signal) {
    const response = await cleanFetch(url, {
        method: 'POST',
        headers: { ...ctx().getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal,
    });
    if (!response.ok)
        throw Error('酒馆请求失败 ' + response.status + '：' + (await response.text()).slice(0, 500));
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
async function modules() {
    if (cachedModules) return cachedModules;
    const [presets, world, script] = await Promise.all([
        import('/scripts/preset-manager.js'),
        import('/scripts/world-info.js'),
        import('/script.js'),
    ]);
    cachedModules = { manager: presets.getPresetManager('openai'), world, script };
    return cachedModules;
}
function defaultConfig() {
    return { version: 1, templates: {}, channels: [], theme: {}, togglePresets: {}, backups: [] };
}
function config() {
    return clone(durableConfig || ctx().extensionSettings[KEY] || defaultConfig());
}
function encodeJson(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value, null, 4));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
}
async function readConfigRecord() {
    const relative = CONFIG_URL.slice(1);
    const existing = await post('/api/files/verify', { urls: [relative] });
    if (!existing?.[relative]) return null;
    const response = await cleanFetch(CONFIG_URL, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw Error('工作台独立配置读取失败：' + response.status);
    const record = await response.json();
    if (record.schema !== 'pww-settings' || record.version !== 1 || record.config?.version !== 1)
        throw Error('工作台独立配置格式不受支持，未覆盖原件');
    return record;
}
async function loadConfig() {
    const record = await readConfigRecord();
    durableConfig = clone(record?.config || ctx().extensionSettings[KEY] || defaultConfig());
    configRevision = record?.revision || null;
    ctx().extensionSettings[KEY] = clone(durableConfig);
    return config();
}
function configWithoutBackups(value) {
    const next = clone(value);
    delete next.backups;
    return next;
}
function persistConfig(next, { backupOnly = false } = {}) {
    const run = configQueue.then(async () => {
        const latest = await readConfigRecord();
        const base = latest?.config || config();
        if (
            !backupOnly &&
            latest &&
            latest.revision !== configRevision &&
            !equal(configWithoutBackups(base), configWithoutBackups(config()))
        )
            throw Error('其他页面已经更新工作台设置；请先导出当前编辑，再关闭并重新打开工作台以载入新设置');
        const combined = backupOnly ? clone(base) : clone(next);
        const backups = [...(base.backups || []), ...(backupOnly ? next.backups || [] : [])];
        combined.backups = [...new Map(backups.map((item) => [item.id, item])).values()].sort((a, b) =>
            String(b.at).localeCompare(String(a.at)),
        );
        const record = {
            schema: 'pww-settings',
            version: 1,
            revision: uuid(),
            updatedAt: new Date().toISOString(),
            config: combined,
        };
        await post('/api/files/upload', { name: CONFIG_FILE, data: encodeJson(record) });
        const verified = await readConfigRecord();
        if (verified?.revision !== record.revision || !equal(verified.config, combined))
            throw Error('工作台配置保存后读回不一致，请重新打开核对；未确认保存成功');
        durableConfig = clone(combined);
        configRevision = record.revision;
        ctx().extensionSettings[KEY] = clone(combined);
        // 原生命名空间保留镜像；不触发全量settings写回，旧页面无法抹掉独立配置文件。
        return config();
    });
    configQueue = run.catch(() => {});
    return run;
}
function presetAt(manager, name) {
    const { presets, preset_names: names } = manager.getPresetList();
    const i = Array.isArray(names) ? names.indexOf(name) : names?.[name];
    return i === undefined || i < 0 ? null : clone(presets[Number(i)]);
}
async function diskPreset(name) {
    const result = await post('/api/settings/get', {});
    const i = result.openai_setting_names.indexOf(name);
    if (i < 0) throw Error('预设不存在：' + name);
    const raw = result.openai_settings[i];
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
function ensureName(name) {
    if (
        typeof name !== 'string' ||
        !name.trim() ||
        name !== name.trim() ||
        /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
        /[. ]$/.test(name)
    )
        throw Error('请输入合法且非空的文件名称');
    return name;
}
async function backup(kind, name, raw) {
    const text = JSON.stringify(raw, null, 4),
        bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    const result = await post('/api/files/upload', {
        name: 'pww-backup-' + uuid() + '.json',
        data: btoa(binary),
    });
    const next = config();
    next.backups ||= [];
    const item = { id: uuid(), kind, name, path: result.path, at: new Date().toISOString() };
    next.backups.unshift(item);
    await persistConfig(next, { backupOnly: true });
    return item;
}
// Fetch authoritative filenames through the iframe's native fetch, not a cached parent settings hook.
async function refreshWorldNames(world) {
    const items = await post('/api/worldinfo/list', {});
    if (!Array.isArray(items) || items.some(item => typeof item.file_id !== 'string')) throw Error('世界书文件列表格式无效，未继续读写');
    const names = items.map(item => item.file_id);
    if (Array.isArray(world.world_names) && !equal(world.world_names, names)) {
        const editor = document.querySelector('#world_editor_select');
        const selectedName = editor?.selectedOptions?.[0]?.textContent || '';
        world.world_names.splice(0, world.world_names.length, ...names);
        for (const [selector, selected] of [['#world_info', new Set(world.selected_world_info)], ['#world_editor_select', new Set([selectedName])]]) {
            const select = document.querySelector(selector);
            if (!select) continue;
            for (const option of [...select.options]) if (option.value !== '') option.remove();
            names.forEach((name, i) => select.add(new Option(name, String(i), false, selected.has(name))));
        }
    }
    return names;
}

async function readDocument({ kind, name, fresh = false }) {
    const { manager, world } = await modules();
    if (kind === 'preset') {
        const raw = fresh ? await diskPreset(name) : presetAt(manager, name);
        if (!raw) throw Error('预设不存在');
        return assertDocument(kind, raw);
    }
    if (!fresh) {
        const cached = world.worldInfoCache?.get?.(name);
        if (cached && typeof cached === 'object' && cached.entries) {
            return assertDocument('worldbook', cached);
        }
    }
    const raw = await post('/api/worldinfo/get', { name });
    if (!raw || typeof raw !== 'object' || !raw.entries) throw Error('世界书不存在：' + name);
    assertDocument('worldbook', raw);
    try {
        world.worldInfoCache?.set?.(name, clone(raw));
    } catch {}
    return raw;
}
async function saveDocument({ kind, name, raw, base, create = false }) {
    ensureName(name);
    assertDocument(kind, raw);
    const { manager, world } = await modules();
    if (create) {
        const { preset_names: pNames } = manager.getPresetList();
        const names =
            kind === 'preset'
                ? Array.isArray(pNames)
                    ? pNames
                    : Object.keys(pNames || {})
                : await refreshWorldNames(world);
        if (!Array.isArray(names)) throw Error('无法核实现有名称，未执行另存为');
        if (names.includes(name)) throw Error('名称已存在，请另取名称');
    }
    if (!create) {
        if (!base) throw Error('缺少原件快照，必须另存为');
        const current = await readDocument({ kind, name, fresh: kind !== 'preset' });
        if (!equal(current, base)) throw Error('原文件已经被其他编辑器修改；草稿保留，请重新载入或另存为');
        await backup(kind, name, current);
    }
    if (kind === 'preset') {
        const selected = manager.getSelectedPresetName();
        await manager.savePreset(name, clone(raw), { skipUpdate: selected !== name });
        const { presets, preset_names: presetNames } = manager.getPresetList();
        if (selected !== name) {
            let i = Array.isArray(presetNames) ? presetNames.indexOf(name) : presetNames[name];
            if (i === undefined || i < 0) {
                i = presets.length;
                presets.push(clone(raw));
                if (Array.isArray(presetNames)) presetNames.push(name);
                else presetNames[name] = i;
                const select = document.querySelector('#settings_preset_openai');
                if (select && ![...select.options].some((o) => o.textContent === name))
                    select.add(new Option(name, String(i)));
            } else presets[Number(i)] = clone(raw);
        }
        const verify = presetAt(manager, name);
        if (!verify) throw Error('保存后未在酒馆预设列表中找到目标预设，草稿已保留');
        return { name, raw: verify };
    }
    const cache = world.worldInfoCache.get(name);
    if (!create && cache && !equal(cache, base))
        throw Error('原生世界书编辑器中有未同步修改，请先完成或撤销其编辑');
    await post('/api/worldinfo/edit', { name, data: raw });
    const verify = await post('/api/worldinfo/get', { name });
    if (!equal(verify, raw)) throw Error('保存后读回不一致，草稿已保留');
    world.worldInfoCache.set(name, clone(verify));
    if (create) await refreshWorldNames(world);
    if (document.querySelector('#world_editor_select')?.selectedOptions?.[0]?.textContent === name)
        await world.showWorldEditor(name);
    return { name, raw: verify };
}
async function listDocuments({ refreshWorlds = false } = {}) {
    const { manager, world } = await modules();
    const { preset_names: names } = manager.getPresetList();
    const c = ctx(),
        character = c.characters?.[c.characterId];
    const avatar = character?.avatar?.replace(/\.[^.]+$/, '');
    const worldbooks =
        refreshWorlds || !Array.isArray(world.world_names) || !world.world_names.length
            ? await refreshWorldNames(world)
            : [...world.world_names];
    return {
        presets: Array.isArray(names) ? [...names] : Object.keys(names || {}),
        worldbooks,
        currentPreset: manager.getSelectedPresetName(),
        mainWorld: character?.data?.extensions?.world || '',
        auxiliary: Array.isArray(world.world_info?.charLore?.find((e) => e.name === avatar)?.extraBooks)
            ? [...world.world_info.charLore.find((e) => e.name === avatar).extraBooks]
            : [],
        global: Array.isArray(world.selected_world_info) ? [...world.selected_world_info] : [],
        chatWorld: c.chatMetadata?.world_info || '',
        characterName: character?.name || '',
    };
}
function syncGlobalSelection(world, names) {
    world.selected_world_info.splice(0, world.selected_world_info.length, ...names);
    const select = document.querySelector('#world_info');
    if (select) {
        for (const option of select.options)
            option.selected = names.includes(world.world_names[Number(option.value)]);
        window.jQuery?.(select).trigger('change.select2');
    }
    ctx().saveSettingsDebounced();
}
async function bind({ name, target, remove = false }) {
    const { world } = await modules(),
        c = ctx();
    if (target === 'global') {
        const next = world.selected_world_info.filter((x) => x !== name);
        if (!remove) next.push(name);
        syncGlobalSelection(world, next);
    } else if (target === 'chat') {
        if (remove && c.chatMetadata?.world_info !== name) return listDocuments();
        if (!c.getCurrentChatId?.()) throw Error('请先打开聊天');
        c.chatMetadata.world_info = remove ? '' : name;
        await c.saveMetadata();
    } else {
        const character = c.characters?.[c.characterId];
        if (!character) throw Error('请先选择角色');
        if (target === 'primary') {
            if (remove && character.data?.extensions?.world !== name) return listDocuments();
            const value = remove ? '' : name;
            await post('/api/characters/merge-attributes', {
                avatar: character.avatar,
                data: { extensions: { world: value } },
            });
            character.data ||= {};
            character.data.extensions ||= {};
            character.data.extensions.world = value;
            const el = document.querySelector('#character_world');
            if (el) el.value = value;
        } else if (target === 'auxiliary') {
            if (!remove) await world.charUpdateAddAuxWorld(character.avatar, name);
            else {
                const key = character.avatar.replace(/\.[^.]+$/, '');
                const books = world.world_info?.charLore?.find((e) => e.name === key)?.extraBooks || [];
                world.charSetAuxWorlds(
                    key,
                    books.filter((n) => n !== name),
                );
            }
        } else throw Error('未知绑定目标');
    }
    c.eventSource.emit(c.eventTypes.WORLDINFO_SETTINGS_UPDATED);
    return listDocuments();
}
async function deleteBookAndCurrentBindings(world, name, lists) {
    await world.deleteWorldInfo(name);
    await refreshWorldNames(world);
    if (world.world_names.includes(name)) throw Error('删除未完成，原书仍然保留');
    if (lists.chatWorld === name) await bind({ name, target: 'chat', remove: true });
    if (lists.auxiliary.includes(name)) await bind({ name, target: 'auxiliary', remove: true });
    if (lists.mainWorld === name) await bind({ name, target: 'primary', remove: true });
    if (lists.global.includes(name)) await bind({ name, target: 'global', remove: true });
}
function requestBody(channel, messages, options = {}) {
    const c = ctx(),
        o = c.chatCompletionSettings;
    if (!channel && (c.mainApi !== 'openai' || !o)) throw Error('主API需为聊天补全连接；也可配置独立渠道');
    const source = channel?.source || o.chat_completion_source;
    // 仅从主 API 读取连接/鉴权信息，不继承酒馆当前选择预设的提示词后处理、自定义请求体或采样参数
    const body = {
        chat_completion_source: source,
        model: channel?.model || c.getChatCompletionModel(),
        messages,
        stream: options.stream ?? true,
        temperature: Number(options.temperature ?? channel?.temperature ?? 0.4),
        max_tokens: Number(options.maxTokens ?? channel?.maxTokens ?? 6000),
        claude_use_sysprompt: true,
        use_makersuite_sysprompt: true,
        ...(channel?.postProcessing ? { custom_prompt_post_processing: channel.postProcessing } : {}),
    };
    if (channel) {
        if (source === 'custom') {
            let url;
            try {
                url = new URL(channel.url);
            } catch {
                throw Error('请填写完整的自定义API地址');
            }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
                throw Error('API地址必须是无内嵌凭据的http/https地址');
            body.custom_url = channel.url;
        }
        if (channel.authMode === 'none') {
            if (source !== 'custom') throw Error('无密钥模式仅适用于自定义兼容API');
            body.secret_id = 'pww-no-auth';
            body.custom_include_headers = "Authorization: ''";
        } else {
            if (!channel.secretId) throw Error('独立渠道尚未选择密钥引用；不会隐式发送主API密钥');
            body.secret_id = channel.secretId;
        }
    } else {
        if (source === 'custom')
            for (const k of ['custom_url', 'custom_include_headers'])
                if (o[k]) body[k] = o[k];
        if (
            o.reverse_proxy &&
            ['claude', 'openai', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai'].includes(source)
        ) {
            body.reverse_proxy = o.reverse_proxy;
            body.proxy_password = o.proxy_password;
        }
        for (const k of [
            'vertexai_auth_mode',
            'vertexai_region',
            'vertexai_express_project_id',
            'azure_base_url',
            'azure_deployment_name',
            'azure_api_version',
        ])
            if (o[k] !== undefined) body[k] = o[k];
    }
    return c.ChatCompletionService?.createRequestData?.(body) || body;
}
function responseText(json) {
    return (
        json?.choices?.[0]?.delta?.content ??
        json?.choices?.[0]?.message?.content ??
        json?.delta?.text ??
        json?.content_block?.text ??
        json?.candidates?.[0]?.content?.parts
            ?.filter((p) => !p.thought)
            .map((p) => p.text || '')
            .join('') ??
        (Array.isArray(json?.content)
            ? json.content
                  .filter((x) => x.type === 'text')
                  .map((x) => x.text)
                  .join('')
            : typeof json?.content === 'string'
              ? json.content
              : json?.completion || '')
    );
}
async function generate({ channelId, messages, options = {}, jobId }) {
    if (activeGeneration) throw Error('已有生成任务正在运行，请先停止或等待完成');
    const channel = channelId ? config().channels?.find((c) => c.id === channelId) : null;
    if (channelId && !channel) throw Error('渠道不存在');
    const controller = new AbortController();
    activeGeneration = controller;
    try {
        const body = requestBody(channel, messages, options);
        if (body.custom_include_body || body.custom_exclude_body) {
            const { yaml } = await import('/lib.js');
            const protectedFields = new Set([
                'messages',
                'prompt',
                'tools',
                'tool_choice',
                'functions',
                'function_call',
            ]);
            if (body.custom_include_body) {
                const extra = yaml.parse(body.custom_include_body);
                if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
                    for (const k of Object.keys(extra)) if (protectedFields.has(k)) delete extra[k];
                    body.custom_include_body = yaml.stringify(extra);
                }
            }
            if (body.custom_exclude_body) {
                const omit = yaml.parse(body.custom_exclude_body);
                if (Array.isArray(omit))
                    body.custom_exclude_body = yaml.stringify(omit.filter((k) => !protectedFields.has(k)));
            }
        }
        const response = await cleanFetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { ...ctx().getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok)
            throw Error(
                '模型请求失败 HTTP ' +
                    response.status +
                    '：' +
                    (await response.text()).slice(0, 1200).replace(/(sk-|Bearer\s+)[\w-]+/gi, '[已隐藏]'),
            );
        const type = response.headers.get('content-type') || '';
        let output = '';
        if (!body.stream || type.includes('application/json')) {
            const json = await response.json();
            if (json.error)
                throw Error('模型返回错误：' + (json.error.message || JSON.stringify(json.error)));
            output = responseText(json);
            send('ai.stream', { jobId, text: output });
        } else {
            const reader = response.body.getReader(),
                decoder = new TextDecoder();
            let buffer = '';
            const consume = (line) => {
                const data = line.trim().replace(/^data:\s*/, '');
                if (!data || data === '[DONE]' || !data.startsWith('{')) return;
                let j;
                try {
                    j = JSON.parse(data);
                } catch {
                    return;
                }
                if (j.error) throw Error(j.error.message || '模型流错误');
                const delta = responseText(j);
                if (typeof delta === 'string') {
                    output += delta;
                    send('ai.stream', { jobId, text: output });
                }
            };
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop();
                for (const l of lines) consume(l);
            }
            if (buffer.trim()) consume(buffer);
        }
        if (!output.trim()) throw Error('模型没有返回文本');
        return { text: output, source: body.chat_completion_source, model: body.model };
    } finally {
        activeGeneration = null;
    }
}
async function secretsList(source = 'custom') {
    const { SECRET_KEYS } = await import('/scripts/secrets.js');
    const key =
        SECRET_KEYS[source.toUpperCase()] ||
        { makersuite: 'api_key_makersuite', claude: 'api_key_claude', custom: 'api_key_custom' }[source] ||
        'api_key_' + source;
    const all = await post('/api/secrets/view', {});
    return { key, items: (all[key] || []).map((e) => ({ id: e.id, label: e.label, active: e.active })) };
}
const actions = {
    async 'database.call'({ method, args = {} }) {
        if (!dbHost) dbHost = createDatabaseHost({ ctx, post, modules, encodeJson });
        return await dbHost.call(method, args);
    },
    async 'character.call'({ method, args = {} }) {
        if (!charHost) {
            charHost = createCharacterHost({
                ctx,
                post,
                cleanFetchGetter: () => cleanFetch,
                modules,
                backup,
            });
        }
        if (!Object.hasOwn(charHost, method)) throw Error('不允许的角色卡操作：' + method);
        return await charHost[method](args || {});
    },
    async 'chat.call'({ method, args = {} }) {
        if (!chatHost) {
            chatHost = createChatHost({
                ctx,
                post,
                cleanFetchGetter: () => cleanFetch,
                modules,
            });
        }
        if (!Object.hasOwn(chatHost, method)) throw Error('不允许的聊天记录操作：' + method);
        return await chatHost[method](args || {});
    },
    'host.reload'() {
        setTimeout(() => window.location.reload(), 60);
        return true;
    },
    async init({ fast = false } = {}) {
        if (!durableConfig || !fast) await loadConfig();
        const c = ctx();
        return {
            config: config(),
            lists: await listDocuments({ refreshWorlds: false }),
            connection: {
                source: c.chatCompletionSettings?.chat_completion_source,
                model: c.getChatCompletionModel?.(),
                usable: c.mainApi === 'openai',
            },
            spreset: !!window.SPresetEditorBridge,
            activeEntries,
            theme: readTheme(),
        };
    },
    async 'documents.list'({ refresh } = {}) {
        return listDocuments({ refreshWorlds: Boolean(refresh) });
    },
    'documents.read': readDocument,
    async 'documents.currentPreset'() {
        const openai = await import('/scripts/openai.js');
        if (typeof openai.getChatCompletionPreset !== 'function')
            throw Error('当前酒馆没有可用的完整预设快照接口');
        return assertDocument('preset', openai.getChatCompletionPreset());
    },
    'documents.save'(args) {
        const run = saveQueue.then(() => saveDocument(args));
        saveQueue = run.catch(() => {});
        return run;
    },
    async 'preset.rename'({ oldName, name }) {
        ensureName(name);
        const { manager } = await modules();
        const { preset_names: pNames } = manager.getPresetList();
        const names = Array.isArray(pNames) ? pNames : Object.keys(pNames || {});
        if (oldName === name) return listDocuments({ refreshWorlds: false });
        if (names.includes(name)) throw Error('目标预设名称已存在');
        const raw = presetAt(manager, oldName);
        if (!raw) throw Error('原预设不存在：' + oldName);
        await backup('preset', oldName, raw);
        const isCurrent = manager.getSelectedPresetName() === oldName;
        await manager.savePreset(name, clone(raw), { skipUpdate: !isCurrent });
        await manager.deletePreset(oldName);
        return listDocuments({ refreshWorlds: false });
    },
    async 'preset.delete'({ name }) {
        ensureName(name);
        const { manager } = await modules();
        const raw = presetAt(manager, name);
        if (!raw) throw Error('预设不存在：' + name);
        await backup('preset', name, raw);
        await manager.deletePreset(name);
        return listDocuments({ refreshWorlds: false });
    },
    'world.bind': bind,
    async 'world.globalSet'({ names }) {
        const { world } = await modules();
        if (!Array.isArray(names) || names.some((n) => !world.world_names.includes(n)))
            throw Error('全局书目包含不存在的世界书');
        syncGlobalSelection(world, [...new Set(names)]);
        ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_SETTINGS_UPDATED);
        return listDocuments();
    },
    async 'world.rename'({ oldName, name }) {
        ensureName(name);
        const lists = await listDocuments();
        if (lists.worldbooks.includes(name)) throw Error('新名称已存在');
        const raw = await readDocument({ kind: 'worldbook', name: oldName, fresh: true });
        await backup('worldbook', oldName, raw);
        await saveDocument({ kind: 'worldbook', name, raw, create: true });
        const { world } = await modules();
        await deleteBookAndCurrentBindings(world, oldName, lists);
        if (lists.mainWorld === oldName) await bind({ name, target: 'primary' });
        if (lists.auxiliary.includes(oldName)) await bind({ name, target: 'auxiliary' });
        if (lists.chatWorld === oldName) await bind({ name, target: 'chat' });
        if (lists.global.includes(oldName)) await bind({ name, target: 'global' });
        return listDocuments();
    },
    async 'world.delete'({ name, expected }) {
        ensureName(name);
        const { world } = await modules();
        const current = await readDocument({ kind: 'worldbook', name, fresh: true });
        if (expected && !equal(current, expected)) throw Error('世界书已改变，不能撤销删除');
        await backup('worldbook', name, current);
        await deleteBookAndCurrentBindings(world, name, await listDocuments());
        return listDocuments();
    },
    'config.save'({ value }) {
        if (!value || value.version !== 1) throw Error('设置格式不支持');
        const current = config();
        const next = clone(value);
        next.channels = (next.channels || []).map((channel) =>
            Object.fromEntries(
                [
                    'id',
                    'name',
                    'source',
                    'model',
                    'url',
                    'secretId',
                    'authMode',
                    'temperature',
                    'maxTokens',
                    'postProcessing',
                ]
                    .filter((k) => channel[k] !== undefined)
                    .map((k) => [k, channel[k]]),
            ),
        );
        return persistConfig({ ...next, backups: current.backups || [] });
    },
    async 'backup.read'({ id }) {
        const item = config().backups?.find((x) => x.id === id);
        if (!item) throw Error('备份不存在');
        const url = new URL(item.path, location.origin + '/');
        if (
            url.origin !== location.origin ||
            !/^\/user\/files\/pww-backup-[a-z0-9-]{10,100}\.json$/i.test(url.pathname)
        )
            throw Error('备份路径不属于本工作台');
        const r = await cleanFetch(url);
        if (!r.ok) throw Error('读取备份失败');
        return { ...item, raw: await r.json() };
    },
    'ai.generate': generate,
    'ai.stop'() {
        activeGeneration?.abort();
        return true;
    },
    async 'ai.models'({ channelId, draftChannel }) {
        const channel =
            draftChannel || (channelId ? config().channels?.find((c) => c.id === channelId) : null);
        const body = requestBody(channel, []);
        delete body.messages;
        delete body.stream;
        const result = await post('/api/backends/chat-completions/status', body);
        const data = result.data || result.models || [];
        return data.map((x) => (typeof x === 'string' ? x : x.id || x.name)).filter(Boolean);
    },
    async 'ai.secrets'({ source }) {
        return secretsList(source);
    },
    async 'ai.addSecret'({ source, value, label }) {
        if (
            activeGeneration ||
            (ctx().streamingProcessor &&
                !ctx().streamingProcessor.isFinished &&
                !ctx().streamingProcessor.isStopped) ||
            ctx().isSendPress
        )
            throw Error('请在没有生成任务时添加密钥');
        if (!value?.trim()) throw Error('密钥不能为空');
        const list = await secretsList(source),
            active = list.items.find((e) => e.active);
        const result = await post('/api/secrets/write', { key: list.key, value, label });
        if (active) {
            await post('/api/secrets/rotate', { key: list.key, id: active.id });
            const verified = await secretsList(source);
            if (!verified.items.some((s) => s.id === active.id && s.active))
                throw Error('密钥已创建，但原活动密钥未确认恢复，请在酒馆密钥管理中核对');
        }
        const { readSecretState } = await import('/scripts/secrets.js');
        await readSecretState();
        return result;
    },
    async 'context.read'({ character, chat, limit = 8 }) {
        const c = ctx(),
            result = {};
        if (character) {
            const v = c.characters?.[c.characterId];
            if (v)
                result.character = {
                    name: v.name,
                    description: v.description,
                    personality: v.personality,
                    scenario: v.scenario,
                };
        }
        if (chat)
            result.chat = (c.chat || [])
                .slice(-Math.max(1, Math.min(100, limit)))
                .map((x) => ({ role: x.is_user ? 'user' : 'assistant', name: x.name, content: x.mes }));
        return result;
    },
    async tokens({ text }) {
        return ctx().getTokenCountAsync ? ctx().getTokenCountAsync(text) : Math.ceil(text.length / 3);
    },
    'special.preview'({ data }) {
        if (!window.SPresetMessageInjection?.previewMessageInjectionData)
            throw Error('请先启用 SPreset 的结构化消息运行组件');
        return window.SPresetMessageInjection.previewMessageInjectionData(data);
    },
    'special.validateTool'({ code }) {
        if (!window.SPresetToolBinding?.validateToolCode)
            throw Error('请先启用 SPreset；此操作会执行工具定义代码进行验证');
        return window.SPresetToolBinding.validateToolCode(code);
    },
    close() {
        setTimeout(() => destroyWorkbench(), 0);
        return true;
    },
};
function destroyWorkbench() {
    try {
        activeGeneration?.abort();
    } catch {}
    activeGeneration = null;
    window.removeEventListener('resize', sizeWindow);
    window.visualViewport?.removeEventListener('resize', sizeWindow);
    if (frame) {
        try {
            frame.src = 'about:blank';
        } catch {}
    }
    overlay?.remove();
    frame = null;
    overlay = null;
    token = null;
    cleanFetch = null;
}
function readTheme() {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(themes.map((k) => [k, style.getPropertyValue(k).trim()]));
}
function sizeWindow() {
    if (!overlay) return;
    const v = window.visualViewport;
    overlay.style.setProperty('height', (v?.height || window.innerHeight) + 'px', 'important');
    overlay.style.setProperty('width', (v?.width || window.innerWidth) + 'px', 'important');
    overlay.style.top = (v?.offsetTop || 0) + 'px';
    overlay.style.left = (v?.offsetLeft || 0) + 'px';
}
function openWorkbench() {
    if (overlay) {
        overlay.style.display = 'block';
        sizeWindow();
        send('theme', readTheme());
        send('opened', true);
        return;
    }
    token = uuid();
    overlay = document.createElement('div');
    overlay.id = 'pww-host-overlay';
    Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147482000',
        background: 'rgba(0,0,0,.5)',
    });
    frame = document.createElement('iframe');
    frame.title = TITLE;
    frame.src = new URL('ui.html', BASE).href + '#' + token;
    Object.assign(frame.style, {
        width: '100%',
        height: '100%',
        border: '0',
        display: 'block',
        colorScheme: 'light dark',
    });
    overlay.append(frame);
    document.body.append(overlay);
    sizeWindow();
    window.addEventListener('resize', sizeWindow);
    window.visualViewport?.addEventListener('resize', sizeWindow);
    frame.addEventListener('load', () => {
        cleanFetch = frame.contentWindow.fetch.bind(frame.contentWindow);
        send('theme', readTheme());
    });
}
export function startWorkbench() {
    if (document.getElementById('pww-open')) return;
    const button = document.createElement('div');
    button.id = 'pww-open';
    button.className = 'list-group-item flex-container flexGap5';
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    button.innerHTML = '<i class="fa-solid fa-book-open" aria-hidden="true"></i><span>' + TITLE + '</span>';
    button.addEventListener('click', openWorkbench);
    button.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') openWorkbench();
    });
    (
        document.getElementById('extensionsMenu') ||
        document.getElementById('extensions_settings') ||
        document.body
    ).append(button);
    window.addEventListener('message', async (event) => {
        const m = event.data;
        if (
            !frame ||
            event.source !== frame.contentWindow ||
            event.origin !== location.origin ||
            m?.pww !== true ||
            m.token !== token ||
            !Object.hasOwn(actions, m.method)
        )
            return;
        try {
            cleanFetch = frame.contentWindow.fetch.bind(frame.contentWindow);
            const value = await actions[m.method](m.args || {});
            frame?.contentWindow?.postMessage({ pww: true, token, id: m.id, value }, location.origin);
        } catch (error) {
            frame?.contentWindow?.postMessage(
                {
                    pww: true,
                    token,
                    id: m.id,
                    error: error.name === 'AbortError' ? '生成已停止' : String(error.message || error),
                },
                location.origin,
            );
        }
    });
    const c = ctx();
    for (const key of ['GENERATION_STARTED', 'CHAT_CHANGED'])
        if (c.eventTypes[key])
            c.eventSource.on(c.eventTypes[key], () => {
                activeEntries = [];
                send('activation', []);
            });
    if (c.eventTypes.WORLD_INFO_ACTIVATED)
        c.eventSource.on(c.eventTypes.WORLD_INFO_ACTIVATED, (data) => {
            activeEntries = (Array.isArray(data) ? data : data instanceof Set ? [...data] : []).map((e) => ({
                world: e.world || e.worldName || '',
                uid: String(e.uid),
            }));
            send('activation', activeEntries);
        });
    if (c.eventTypes.SETTINGS_UPDATED)
        c.eventSource.on(c.eventTypes.SETTINGS_UPDATED, () => {
            if (frame) send('theme', readTheme());
        });
}
