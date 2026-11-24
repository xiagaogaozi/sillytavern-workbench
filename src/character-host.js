// SillyTavern 角色卡宿主适配器：走酒馆原生官方 API，读写/头像/世界书绑定/标签/导入导出/更新全覆盖。
import { clone, equal, uuid } from './core.js';
import { buildCharacterMergePatch, ensureCharacterShape } from './character-model.js';

function base64ToBlob(base64, mimeType = 'application/octet-stream') {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
}

function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    }
    return btoa(binary);
}

export function createCharacterHost({ ctx, post, cleanFetchGetter, modules, backup }) {
    let cachedTagsMod = null;

    async function loadTagsMod() {
        if (cachedTagsMod) return cachedTagsMod;
        try {
            cachedTagsMod = await import('/scripts/tags.js');
        } catch {
            cachedTagsMod = null;
        }
        return cachedTagsMod;
    }

    async function postForm(url, formData) {
        const headers = { ...ctx().getRequestHeaders() };
        delete headers['Content-Type'];
        const fetchFn = cleanFetchGetter() || fetch;
        const response = await fetchFn(url, {
            method: 'POST',
            headers,
            body: formData,
        });
        if (!response.ok) {
            throw Error('酒馆角色卡请求失败 ' + response.status + '：' + (await response.text()).slice(0, 400));
        }
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('application/json')) return response.json();
        return response.text();
    }

    function getAuxBooksForAvatar(world, avatar) {
        const key = String(avatar || '').replace(/\.[^.]+$/, '');
        const entry = world?.world_info?.charLore?.find((e) => e.name === key);
        return Array.isArray(entry?.extraBooks) ? [...entry.extraBooks] : [];
    }

    function setAuxBooksForAvatar(world, key, books) {
        if (typeof world?.charSetAuxWorlds === 'function') {
            world.charSetAuxWorlds(key, books);
            return;
        }
        if (!world?.world_info) return;
        world.world_info.charLore ||= [];
        const idx = world.world_info.charLore.findIndex((e) => e.name === key);
        if (!books.length) {
            if (idx >= 0) world.world_info.charLore.splice(idx, 1);
        } else if (idx >= 0) {
            world.world_info.charLore[idx].extraBooks = [...books];
        } else {
            world.world_info.charLore.push({ name: key, extraBooks: [...books] });
        }
    }

    function getStTagNamesForAvatar(tagsMod, avatar) {
        if (!tagsMod?.tags || !tagsMod?.tag_map) return [];
        const ids = tagsMod.tag_map[avatar] || [];
        const byId = new Map(tagsMod.tags.map((t) => [t.id, t.name]));
        return ids.map((id) => byId.get(id)).filter(Boolean);
    }

    async function listCharacters({ refresh = false } = {}) {
        const { world, script } = await modules();
        const tagsMod = await loadTagsMod();
        const c = ctx();
        if (refresh || !Array.isArray(c.characters) || !c.characters.length) {
            if (typeof script?.getCharacters === 'function') {
                try {
                    await script.getCharacters();
                } catch {}
            }
        }
        const freshCtx = ctx();
        const currentChar = freshCtx.characters?.[freshCtx.characterId];
        const currentAvatar = currentChar?.avatar || '';
        const items = (freshCtx.characters || [])
            .filter((ch) => ch && ch.avatar)
            .map((ch) => {
                const avatar = ch.avatar;
                const stTags = getStTagNamesForAvatar(tagsMod, avatar);
                const cardTags = Array.isArray(ch.data?.tags) ? ch.data.tags : Array.isArray(ch.tags) ? ch.tags : [];
                return {
                    avatar,
                    name: String(ch.name || ch.data?.name || avatar.replace(/\.png$/i, '')),
                    create_date: ch.create_date || '',
                    date_added: Number(ch.date_added || 0),
                    date_last_chat: Number(ch.date_last_chat || 0),
                    fav: Boolean(ch.fav === true || ch.fav === 'true' || ch.data?.extensions?.fav),
                    world: ch.data?.extensions?.world || '',
                    auxiliary: getAuxBooksForAvatar(world, avatar),
                    tags: stTags,
                    cardTags,
                    isCurrent: avatar === currentAvatar,
                };
            });
        const allTags = Array.isArray(tagsMod?.tags)
            ? tagsMod.tags.map((t) => ({ id: t.id, name: t.name, color: t.color || '' }))
            : [];
        return { items, allTags, currentAvatar };
    }

    async function readCharacter({ avatar, fresh = false } = {}) {
        if (!avatar) throw Error('缺少角色卡标识');
        const { world } = await modules();
        const tagsMod = await loadTagsMod();
        const c = ctx();
        const memChar = !fresh ? c.characters?.find((ch) => ch && ch.avatar === avatar) : null;
        let raw = null;
        if (memChar && !memChar.shallow && memChar.data && typeof memChar.data === 'object') {
            raw = clone(memChar);
        } else {
            raw = await post('/api/characters/get', { avatar_url: avatar });
        }
        if (!raw || typeof raw !== 'object') throw Error('角色卡不存在或读取失败：' + avatar);
        // 剥离冗余大体积 json_data（酒馆原生保存时本就会移除该字段），减少跨 iframe 传输与内存占用
        delete raw.json_data;
        ensureCharacterShape(raw);
        return {
            avatar,
            name: String(raw.data?.name || raw.name || avatar.replace(/\.png$/i, '')),
            raw,
            tags: getStTagNamesForAvatar(tagsMod, avatar),
            auxiliary: getAuxBooksForAvatar(world, avatar),
            allTags: Array.isArray(tagsMod?.tags) ? tagsMod.tags.map((t) => ({ id: t.id, name: t.name })) : [],
        };
    }

    async function refreshCharacterInHost(avatar, fullRefresh = false) {
        const { script } = await modules();
        try {
            if (fullRefresh || typeof script?.getOneCharacter !== 'function') {
                await script?.getCharacters?.();
            } else {
                await script.getOneCharacter(avatar);
            }
        } catch {}
    }

    async function saveCharacter({ avatar, raw, base }) {
        if (!avatar) throw Error('缺少角色卡标识');
        const current = await post('/api/characters/get', { avatar_url: avatar });
        if (base && current && !equal(buildCharacterMergePatch(current), buildCharacterMergePatch(base))) {
            throw Error('原角色卡已被酒馆其他面板修改；草稿已保留，请先重新载入或另存为副本');
        }
        await backup('character', avatar, current);
        const patch = buildCharacterMergePatch(raw);
        await post('/api/characters/merge-attributes', { avatar, ...patch });
        await refreshCharacterInHost(avatar, false);
        const verify = await readCharacter({ avatar, fresh: true });
        return verify;
    }

    async function saveAsCharacter({ sourceAvatar, name, raw }) {
        const cleanName = String(name || '').trim();
        if (!cleanName) throw Error('请输入新角色卡名称');
        let targetAvatar = '';
        if (sourceAvatar) {
            const dup = await post('/api/characters/duplicate', { avatar_url: sourceAvatar });
            if (!dup?.path) throw Error('复制角色卡副本失败');
            targetAvatar = dup.path;
            const renamed = await post('/api/characters/rename', {
                avatar_url: targetAvatar,
                new_name: cleanName,
            });
            if (renamed?.avatar) targetAvatar = renamed.avatar;
        } else {
            const fd = new FormData();
            fd.append('ch_name', cleanName);
            fd.append('description', String(raw?.data?.description || ''));
            fd.append('first_mes', String(raw?.data?.first_mes || ''));
            const created = await postForm('/api/characters/create', fd);
            targetAvatar = typeof created === 'string' ? created.trim() : created?.avatar || '';
            if (!targetAvatar) throw Error('新建角色卡失败');
        }
        const nextRaw = clone(raw);
        ensureCharacterShape(nextRaw);
        nextRaw.name = cleanName;
        nextRaw.data.name = cleanName;
        const patch = buildCharacterMergePatch(nextRaw);
        await post('/api/characters/merge-attributes', { avatar: targetAvatar, ...patch });
        await refreshCharacterInHost(targetAvatar, true);
        const verify = await readCharacter({ avatar: targetAvatar });
        const list = await listCharacters({ refresh: false });
        return { ...verify, list };
    }

    async function renameCharacter({ avatar, newName }) {
        const cleanName = String(newName || '').trim();
        if (!avatar || !cleanName) throw Error('请输入新的角色卡名称');
        const current = await post('/api/characters/get', { avatar_url: avatar });
        await backup('character', avatar, current);
        const res = await post('/api/characters/rename', { avatar_url: avatar, new_name: cleanName });
        const newAvatar = res?.avatar;
        if (!newAvatar) throw Error('角色卡重命名失败');

        // 同步迁移酒馆标签与附加世界书绑定键，避免重命名后丢标签/丢附加书
        const tagsMod = await loadTagsMod();
        try {
            if (typeof tagsMod?.renameTagKey === 'function') {
                tagsMod.renameTagKey(avatar, newAvatar);
            } else if (tagsMod?.tag_map?.[avatar]) {
                tagsMod.tag_map[newAvatar] = tagsMod.tag_map[avatar];
                delete tagsMod.tag_map[avatar];
            }
            ctx().saveSettingsDebounced?.();
        } catch {}

        const { world } = await modules();
        try {
            const oldKey = avatar.replace(/\.[^.]+$/, '');
            const newKey = newAvatar.replace(/\.[^.]+$/, '');
            const aux = getAuxBooksForAvatar(world, avatar);
            if (aux.length) {
                setAuxBooksForAvatar(world, newKey, aux);
                setAuxBooksForAvatar(world, oldKey, []);
            }
        } catch {}

        await refreshCharacterInHost(newAvatar, true);
        const verify = await readCharacter({ avatar: newAvatar });
        const list = await listCharacters({ refresh: false });
        return { ...verify, oldAvatar: avatar, list };
    }

    async function deleteCharacters({ avatars, deleteChats = false }) {
        const targets = [...new Set((Array.isArray(avatars) ? avatars : [avatars]).filter(Boolean))];
        if (!targets.length) throw Error('没有要删除的角色卡');
        const tagsMod = await loadTagsMod();
        const deleted = [];
        for (const avatar of targets) {
            try {
                const current = await post('/api/characters/get', { avatar_url: avatar });
                if (current) await backup('character', avatar, current);
            } catch {}
            await post('/api/characters/delete', { avatar_url: avatar, delete_chats: Boolean(deleteChats) });
            if (tagsMod?.tag_map && Object.prototype.hasOwnProperty.call(tagsMod.tag_map, avatar)) {
                delete tagsMod.tag_map[avatar];
            }
            deleted.push(avatar);
        }
        ctx().saveSettingsDebounced?.();
        await refreshCharacterInHost('', true);
        const list = await listCharacters({ refresh: false });
        return { deleted, list };
    }

    async function importCharacter({ fileName, fileType, dataBase64, preservedName = '' }) {
        if (!dataBase64 || !fileType) throw Error('缺少角色卡导入文件');
        if (preservedName) {
            try {
                const current = await post('/api/characters/get', { avatar_url: preservedName });
                if (current) await backup('character', preservedName, current);
            } catch {}
        }
        const fd = new FormData();
        const blob = base64ToBlob(dataBase64);
        fd.append('avatar', blob, fileName || `character.${fileType}`);
        fd.append('file_type', String(fileType).toLowerCase());
        if (preservedName) fd.append('preserved_name', preservedName);
        const res = await postForm('/api/characters/import', fd);
        if (!res || res.error || !res.file_name) throw Error('导入或更新角色卡失败，请确认文件格式有效');
        const avatar = res.file_name.endsWith('.png') ? res.file_name : `${res.file_name}.png`;
        await refreshCharacterInHost(avatar, true);
        const verify = await readCharacter({ avatar });
        const list = await listCharacters({ refresh: false });
        return { ...verify, list, avatarVersion: Date.now() };
    }

    async function exportCharacter({ avatar, format = 'png' }) {
        if (!avatar) throw Error('缺少角色卡标识');
        const fetchFn = cleanFetchGetter() || fetch;
        const response = await fetchFn('/api/characters/export', {
            method: 'POST',
            headers: { ...ctx().getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: avatar, format }),
        });
        if (!response.ok) throw Error('导出角色卡失败 ' + response.status);
        const baseName = avatar.replace(/\.png$/i, '');
        if (format === 'json') {
            return { format: 'json', fileName: `${baseName}.json`, text: await response.text() };
        }
        const buf = await response.arrayBuffer();
        return { format: 'png', fileName: `${baseName}.png`, dataBase64: arrayBufferToBase64(buf) };
    }

    async function editAvatar({ avatar, fileName, mimeType, dataBase64 }) {
        if (!avatar || !dataBase64) throw Error('缺少图片数据');
        try {
            const current = await post('/api/characters/get', { avatar_url: avatar });
            if (current) await backup('character', avatar, current);
        } catch {}
        const fd = new FormData();
        fd.append('avatar', base64ToBlob(dataBase64, mimeType || 'image/png'), fileName || 'avatar.png');
        fd.append('avatar_url', avatar);
        await postForm('/api/characters/edit-avatar', fd);
        await refreshCharacterInHost(avatar, false);
        return { avatar, avatarVersion: Date.now() };
    }

    async function setWorldBindings({ avatar, primaryWorld = '', auxiliaryWorlds = [] }) {
        if (!avatar) throw Error('缺少角色卡标识');
        const { world } = await modules();
        const cleanPrimary = String(primaryWorld || '');
        const cleanAux = [...new Set((auxiliaryWorlds || []).filter(Boolean))];
        await post('/api/characters/merge-attributes', {
            avatar,
            data: { extensions: { world: cleanPrimary } },
        });
        const key = avatar.replace(/\.[^.]+$/, '');
        setAuxBooksForAvatar(world, key, cleanAux);
        const c = ctx();
        const memChar = c.characters?.find((ch) => ch.avatar === avatar);
        if (memChar) {
            memChar.data ||= {};
            memChar.data.extensions ||= {};
            memChar.data.extensions.world = cleanPrimary;
            if (c.characters?.[c.characterId]?.avatar === avatar && typeof document !== 'undefined') {
                const el = document.querySelector('#character_world');
                if (el) el.value = cleanPrimary;
            }
        }
        c.eventSource?.emit?.(c.eventTypes?.WORLDINFO_SETTINGS_UPDATED);
        c.saveSettingsDebounced?.();
        const list = await listCharacters({ refresh: false });
        return { avatar, primaryWorld: cleanPrimary, auxiliaryWorlds: cleanAux, list };
    }

    async function setTags({ avatar, tagNames = [], syncCardTags = true }) {
        if (!avatar) throw Error('缺少角色卡标识');
        const cleanNames = [...new Set((tagNames || []).map((s) => String(s || '').trim()).filter(Boolean))];
        const tagsMod = await loadTagsMod();
        if (tagsMod?.tags && tagsMod?.tag_map) {
            const ids = [];
            for (const name of cleanNames) {
                let tag = tagsMod.tags.find((t) => String(t.name).toLowerCase() === name.toLowerCase());
                if (!tag) {
                    tag = {
                        id: uuid(),
                        name,
                        color: '',
                        color2: '',
                        folder_type: 1,
                        filter_state: 0,
                        bogus_folder: false,
                    };
                    tagsMod.tags.push(tag);
                }
                ids.push(tag.id);
            }
            tagsMod.tag_map[avatar] = ids;
            tagsMod.printTagFilters?.();
            ctx().saveSettingsDebounced?.();
        }
        if (syncCardTags) {
            await post('/api/characters/merge-attributes', {
                avatar,
                tags: cleanNames,
                data: { tags: cleanNames },
            });
            await refreshCharacterInHost(avatar, false);
        }
        const list = await listCharacters({ refresh: false });
        return { avatar, tags: cleanNames, list };
    }

    return {
        list: listCharacters,
        read: readCharacter,
        save: saveCharacter,
        saveAs: saveAsCharacter,
        rename: renameCharacter,
        delete: deleteCharacters,
        import: importCharacter,
        export: exportCharacter,
        editAvatar,
        setWorldBindings,
        setTags,
    };
}
