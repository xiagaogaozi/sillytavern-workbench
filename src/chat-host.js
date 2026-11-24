// SillyTavern 聊天记录宿主适配器：基于原生 /api/chats/* 与 /api/characters/chats 端点实现全角色汇总、读写、导入导出、重命名与批量删除。
import { parseSizeBytes, parseTxtToJsonl } from './chat-model.js';

export function createChatHost({ ctx, post, cleanFetchGetter, modules }) {
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
            throw Error('酒馆聊天请求失败 ' + response.status + '：' + (await response.text()).slice(0, 400));
        }
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('application/json')) return response.json();
        return response.text();
    }

    function characterLookup() {
        const c = ctx();
        const byAvatar = new Map();
        for (const ch of c.characters || []) {
            if (ch?.avatar) byAvatar.set(ch.avatar, ch);
        }
        const curChar = c.characters?.[c.characterId];
        const currentAvatar = curChar?.avatar || '';
        const currentChatId = typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : '';
        return { byAvatar, currentAvatar, currentChatId };
    }

    function normalizeChatMeta(raw, lookup, fallbackAvatar = '') {
        const avatar = raw.avatar || fallbackAvatar || '';
        const ch = avatar ? lookup.byAvatar.get(avatar) : null;
        const fileName = String(raw.file_name || (raw.file_id ? raw.file_id + '.jsonl' : ''));
        const fileId = String(raw.file_id || fileName.replace(/\.jsonl$/i, ''));
        const charName = ch?.name || ch?.data?.name || (avatar ? avatar.replace(/\.png$/i, '') : '未分类');
        const isCurrent = Boolean(
            avatar &&
                lookup.currentAvatar &&
                avatar === lookup.currentAvatar &&
                lookup.currentChatId &&
                (lookup.currentChatId === fileId || lookup.currentChatId === fileName),
        );
        return {
            key: `${avatar}::${fileName}`,
            avatar,
            charName,
            file_id: fileId,
            file_name: fileName,
            file_size: String(raw.file_size || '0 B'),
            file_size_bytes: parseSizeBytes(raw.file_size),
            chat_items: Number(raw.chat_items || 0),
            last_mes: raw.last_mes || '',
            mes: String(raw.mes || ''),
            is_group: Boolean(raw.group),
            group: raw.group || '',
            isCurrent,
        };
    }

    async function ensureCharactersLoaded() {
        const c = ctx();
        if (!Array.isArray(c.characters) || !c.characters.length) {
            const { script } = await modules();
            if (typeof script?.getCharacters === 'function') {
                try {
                    await script.getCharacters();
                } catch {}
            }
        }
    }

    async function listAll() {
        await ensureCharactersLoaded();
        const res = await post('/api/chats/recent', { max: 10000, pinned: [] });
        const lookup = characterLookup();
        const items = (Array.isArray(res) ? res : [])
            .filter((x) => x && x.file_name && !x.group && x.avatar)
            .map((x) => normalizeChatMeta(x, lookup));
        const characters = (ctx().characters || [])
            .filter((ch) => ch?.avatar)
            .map((ch) => ({
                avatar: ch.avatar,
                name: String(ch.name || ch.data?.name || ch.avatar.replace(/\.png$/i, '')),
            }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
        return {
            items,
            characters,
            currentAvatar: lookup.currentAvatar,
            currentChatId: lookup.currentChatId,
        };
    }

    async function listByCharacter({ avatar }) {
        if (!avatar) throw Error('缺少角色卡标识');
        await ensureCharactersLoaded();
        const res = await post('/api/characters/chats', { avatar_url: avatar });
        const lookup = characterLookup();
        const arr = Array.isArray(res) ? res : [];
        const items = arr.filter((x) => x && x.file_name).map((x) => normalizeChatMeta(x, lookup, avatar));
        return { avatar, items };
    }

    async function read({ avatar, fileId, charName }) {
        if (!avatar || !fileId) throw Error('缺少聊天记录标识');
        const cleanId = String(fileId).replace(/\.jsonl$/i, '');
        const lookup = characterLookup();
        const ch = lookup.byAvatar.get(avatar);
        const resolvedName = charName || ch?.name || avatar.replace(/\.png$/i, '');
        const res = await post('/api/chats/get', {
            ch_name: resolvedName,
            file_name: cleanId,
            avatar_url: avatar,
        });
        const arr = Array.isArray(res) ? res : [];
        let header = null;
        let messages = [];
        if (arr.length && arr[0] && (arr[0].chat_metadata !== undefined || arr[0].user_name !== undefined || arr[0].character_name !== undefined) && arr[0].mes === undefined) {
            header = arr[0];
            messages = arr.slice(1);
        } else {
            header = {
                user_name: ctx().name1 || 'User',
                character_name: resolvedName,
                chat_metadata: {},
            };
            messages = arr;
        }
        return {
            avatar,
            charName: resolvedName,
            fileId: cleanId,
            fileName: `${cleanId}.jsonl`,
            header,
            messages,
            totalFloors: messages.length,
        };
    }

    async function save({ avatar, charName, fileId, header, messages }) {
        if (!avatar || !fileId) throw Error('缺少聊天记录标识');
        if (!Array.isArray(messages)) throw Error('聊天消息数组无效');
        const cleanId = String(fileId).replace(/\.jsonl$/i, '');
        const lookup = characterLookup();
        const ch = lookup.byAvatar.get(avatar);
        const resolvedName = charName || ch?.name || avatar.replace(/\.png$/i, '');
        const chatHeader =
            header && typeof header === 'object'
                ? header
                : { user_name: ctx().name1 || 'User', character_name: resolvedName, chat_metadata: {} };
        const payload = [chatHeader, ...messages];
        // 酒馆 /api/chats/save 内部 trySaveChat 会自动落盘备份到 backups 目录
        await post('/api/chats/save', {
            ch_name: resolvedName,
            file_name: cleanId,
            avatar_url: avatar,
            chat: payload,
            force: true,
        });
        const isCurrent =
            avatar === lookup.currentAvatar &&
            (lookup.currentChatId === cleanId || lookup.currentChatId === `${cleanId}.jsonl`);
        return { ok: true, avatar, fileId: cleanId, totalFloors: messages.length, isCurrent };
    }

    async function rename({ avatar, oldFileName, newName }) {
        if (!avatar || !oldFileName || !newName) throw Error('重命名参数不完整');
        const orig = oldFileName.endsWith('.jsonl') ? oldFileName : `${oldFileName}.jsonl`;
        const cleanNew = String(newName).trim().replace(/\.jsonl$/i, '');
        if (!cleanNew) throw Error('新名称不能为空');
        const renamed = `${cleanNew}.jsonl`;
        const res = await post('/api/chats/rename', {
            is_group: false,
            avatar_url: avatar,
            original_file: orig,
            renamed_file: renamed,
        });
        const finalId = res?.sanitizedFileName || cleanNew;
        return { ok: true, avatar, oldFileName: orig, fileId: finalId, fileName: `${finalId}.jsonl` };
    }

    async function remove({ items }) {
        const list = Array.isArray(items) ? items : [];
        if (!list.length) throw Error('没有要删除的聊天记录');
        const deleted = [];
        for (const it of list) {
            if (!it?.avatar || !it?.fileName) continue;
            const chatfile = it.fileName.endsWith('.jsonl') ? it.fileName : `${it.fileName}.jsonl`;
            await post('/api/chats/delete', {
                avatar_url: it.avatar,
                chatfile,
            });
            deleted.push({ avatar: it.avatar, fileName: chatfile });
        }
        return { deleted };
    }

    async function importChat({ avatar, charName, fileName, fileType, text }) {
        if (!avatar) throw Error('请先选择目标角色卡');
        if (!text || !String(text).trim()) throw Error('导入文件内容为空');
        const lookup = characterLookup();
        const ch = lookup.byAvatar.get(avatar);
        const resolvedCharName = charName || ch?.name || avatar.replace(/\.png$/i, '');
        const userName = ctx().name1 || 'User';

        let uploadType = String(fileType || 'jsonl').toLowerCase();
        let uploadText = String(text);
        let uploadFileName = fileName || `import.${uploadType}`;
        if (uploadType === 'txt') {
            uploadText = parseTxtToJsonl(uploadText, { charName: resolvedCharName, userName });
            uploadType = 'jsonl';
            uploadFileName = uploadFileName.replace(/\.txt$/i, '') + '.jsonl';
        }
        if (!['jsonl', 'json'].includes(uploadType)) {
            throw Error('仅支持导入 .jsonl、.json 或 .txt 聊天记录文件');
        }

        const fd = new FormData();
        fd.append('avatar', new Blob([uploadText], { type: 'text/plain;charset=utf-8' }), uploadFileName);
        fd.append('file_type', uploadType);
        fd.append('avatar_url', avatar);
        fd.append('character_name', resolvedCharName);
        fd.append('user_name', userName);
        const res = await postForm('/api/chats/import', fd);
        if (!res || res.error || !res.res) {
            throw Error('酒馆未能识别该聊天记录格式，请确认文件内容有效');
        }
        const importedFiles = Array.isArray(res.fileNames) ? res.fileNames : [];
        return { ok: true, avatar, charName: resolvedCharName, fileNames: importedFiles };
    }

    return {
        listAll,
        listByCharacter,
        read,
        save,
        rename,
        delete: remove,
        import: importChat,
    };
}
