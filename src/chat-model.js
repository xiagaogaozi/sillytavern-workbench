// 聊天记录纯数据模型：标签自动探测、选择/排除标签双生效筛选、排序分组、分页与 TXT/JSONL 序列化。

export function parseSizeBytes(val) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    const s = String(val || '').trim();
    if (!s) return 0;
    const m = s.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
    if (!m) return 0;
    const num = Number(m[1]);
    if (!Number.isFinite(num)) return 0;
    const unit = (m[2] || 'B').toUpperCase();
    const pow = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 }[unit] ?? 0;
    return Math.round(num * 1024 ** pow);
}

export function parseChatTimeScore(val) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (!val) return 0;
    const num = Number(val);
    if (Number.isFinite(num) && num > 0) return num;
    const s = String(val).trim();
    // 酒馆常见格式：2026-10-31@19h43m41s926ms 或 2026-10-31 @19h 43m 41s
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s/);
    if (m) {
        return Date.UTC(
            Number(m[1]),
            Number(m[2]) - 1,
            Number(m[3]),
            Number(m[4]),
            Number(m[5]),
            Number(m[6]),
        );
    }
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function sortChatItems(items, mode = 'grouped', dir = 'desc') {
    const mult = dir === 'asc' ? 1 : -1;
    return [...(items || [])].sort((a, b) => {
        if (mode === 'grouped') {
            const cn = String(a.charName || a.avatar || '').localeCompare(
                String(b.charName || b.avatar || ''),
                'zh-CN',
                { numeric: true },
            );
            if (cn !== 0) return cn;
            return parseChatTimeScore(b.last_mes) - parseChatTimeScore(a.last_mes);
        }
        if (mode === 'last_mes') {
            const diff = parseChatTimeScore(a.last_mes) - parseChatTimeScore(b.last_mes);
            if (diff !== 0) return diff * mult;
        } else if (mode === 'chat_items') {
            const diff = Number(a.chat_items || 0) - Number(b.chat_items || 0);
            if (diff !== 0) return diff * mult;
        } else if (mode === 'file_size') {
            const diff = parseSizeBytes(a.file_size_bytes ?? a.file_size) - parseSizeBytes(b.file_size_bytes ?? b.file_size);
            if (diff !== 0) return diff * mult;
        } else if (mode === 'name') {
            const cmp = String(a.file_id || a.file_name || '').localeCompare(
                String(b.file_id || b.file_name || ''),
                'zh-CN',
                { numeric: true },
            );
            if (cmp !== 0) return cmp * mult;
        }
        return (parseChatTimeScore(a.last_mes) - parseChatTimeScore(b.last_mes)) * mult;
    });
}

export function groupChatItemsByCharacter(items) {
    const groups = new Map();
    for (const item of items || []) {
        const key = item.avatar || '__other__';
        if (!groups.has(key)) {
            groups.set(key, {
                avatar: item.avatar || '',
                charName: item.charName || (item.avatar ? item.avatar.replace(/\.png$/i, '') : '未分类 / 群聊'),
                items: [],
            });
        }
        groups.get(key).items.push(item);
    }
    const result = [...groups.values()];
    result.sort((a, b) => a.charName.localeCompare(b.charName, 'zh-CN', { numeric: true }));
    for (const g of result) {
        g.items.sort((a, b) => parseChatTimeScore(b.last_mes) - parseChatTimeScore(a.last_mes));
    }
    return result;
}

export function normalizeTagName(raw) {
    return String(raw || '')
        .trim()
        .replace(/^<\s*\/?/, '')
        .replace(/\/?\s*>$/, '')
        .trim();
}

export function normalizeTagList(input) {
    const list = Array.isArray(input) ? input : String(input || '').split(/[,，\n\s]+/);
    const out = [];
    const seen = new Set();
    for (const item of list) {
        const clean = normalizeTagName(item);
        if (!clean) continue;
        const lower = clean.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        out.push(clean);
    }
    return out;
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 自动扫描所有楼层中出现的成对 XML/HTML 标签（支持中文、英文、数字、下划线、连字符）并按出现频次降序统计
const TAG_PAIR_RE = /<([\p{L}_][\p{L}\p{N}_:-]{0,40})(?:\s[^<>]*)?>[\s\S]*?<\/\1>/gu;

export function detectChatTags(messages) {
    const counts = new Map(); // lower -> { tag, count, msgCount }
    for (const msg of messages || []) {
        const text = String(msg?.mes || '');
        if (!text || !text.includes('<')) continue;
        const seenInMsg = new Set();
        let m;
        TAG_PAIR_RE.lastIndex = 0;
        while ((m = TAG_PAIR_RE.exec(text)) !== null) {
            const rawTag = m[1];
            const lower = rawTag.toLowerCase();
            let rec = counts.get(lower);
            if (!rec) {
                rec = { tag: rawTag, count: 0, msgCount: 0 };
                counts.set(lower, rec);
            }
            rec.count++;
            if (!seenInMsg.has(lower)) {
                seenInMsg.add(lower);
                rec.msgCount++;
            }
            // 扫描标签内部可能嵌套的子标签
            const inner = m[0].slice(m[0].indexOf('>') + 1, m[0].lastIndexOf('</'));
            if (inner && inner.includes('<')) {
                scanNestedTags(inner, counts, seenInMsg);
            }
        }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
}

function scanNestedTags(text, counts, seenInMsg) {
    const nestedRe = new RegExp(TAG_PAIR_RE.source, 'gu');
    let m;
    while ((m = nestedRe.exec(text)) !== null) {
        const rawTag = m[1];
        const lower = rawTag.toLowerCase();
        let rec = counts.get(lower);
        if (!rec) {
            rec = { tag: rawTag, count: 0, msgCount: 0 };
            counts.set(lower, rec);
        }
        rec.count++;
        if (!seenInMsg.has(lower)) {
            seenInMsg.add(lower);
            rec.msgCount++;
        }
        const inner = m[0].slice(m[0].indexOf('>') + 1, m[0].lastIndexOf('</'));
        if (inner && inner.includes('<')) {
            scanNestedTags(inner, counts, seenInMsg);
        }
    }
}

function removePairedTag(text, tagName) {
    const escaped = escapeRegex(tagName);
    const re = new RegExp(`<${escaped}(?:\\s[^<>]*)?>[\\s\\S]*?<\\/${escaped}>`, 'gi');
    let out = text;
    let guard = 0;
    while (guard++ < 12) {
        const next = out.replace(re, '');
        if (next === out) break;
        out = next;
    }
    // 清理可能残留的孤立自闭合或单边标签
    const soloRe = new RegExp(`<\\/?${escaped}(?:\\s[^<>]*)?\\/?>`, 'gi');
    return out.replace(soloRe, '');
}

function extractPairedTagBlocks(text, includeTags, stripOuterTags) {
    const alts = includeTags.map(escapeRegex).join('|');
    if (!alts) return { matched: false, text };
    const re = new RegExp(`<(${alts})(?:\\s[^<>]*)?>([\\s\\S]*?)<\\/\\1>`, 'gi');
    const chunks = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        const piece = stripOuterTags ? m[2] : m[0];
        if (piece.trim()) chunks.push(piece.trim());
    }
    return { matched: chunks.length > 0, text: chunks.join('\n\n') };
}

function cleanupBlankLines(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 选择标签 + 排除标签同时生效的消息筛选函数：
 * 1) 若设置了选择标签（includeTags）：优先提取匹配选择标签的内容块；
 *    若某条消息不含任何选择标签：当 keepUserPlain=true 且是用户楼层（或 keepPlainWhenNoTag=true 且全文不含任何标签）时保留原文，否则置空。
 * 2) 若设置了排除标签（excludeTags）：在步骤 1 的结果上移除所有排除标签块（含嵌套在内的排除标签）。
 */
export function filterMessageByTags(text, options = {}) {
    const raw = String(text ?? '');
    const includeTags = normalizeTagList(options.includeTags);
    const excludeTags = normalizeTagList(options.excludeTags);
    const stripOuterTags = options.stripOuterTags !== false;
    const isUser = Boolean(options.isUser);
    const keepUserMessages = options.keepUserMessages !== false;

    let out = raw;
    if (includeTags.length) {
        const extracted = extractPairedTagBlocks(out, includeTags, stripOuterTags);
        if (extracted.matched) {
            out = extracted.text;
        } else if (isUser && keepUserMessages) {
            out = raw;
        } else {
            out = '';
        }
    }
    if (excludeTags.length && out) {
        for (const tag of excludeTags) {
            out = removePairedTag(out, tag);
        }
    }
    return includeTags.length || excludeTags.length ? cleanupBlankLines(out) : raw;
}

export function computeEffectiveFloors(messages, filterOpts = {}, manualEdits = new Map()) {
    const hideEmpty = Boolean(filterOpts.hideEmpty);
    const skipSystem = Boolean(filterOpts.skipSystem);
    const filterBySearch = filterOpts.filterBySearch !== false;
    const query = String(filterOpts.search || '').trim().toLowerCase();
    const result = [];
    for (let i = 0; i < (messages || []).length; i++) {
        const msg = messages[i];
        if (!msg) continue;
        if (skipSystem && msg.is_system) continue;
        const rawText = String(msg.mes ?? '');
        const filteredText = filterMessageByTags(rawText, { ...filterOpts, isUser: Boolean(msg.is_user) });
        const hasManual = manualEdits instanceof Map && manualEdits.has(i);
        const text = hasManual ? String(manualEdits.get(i)) : filteredText;
        if (hideEmpty && !text.trim()) continue;
        if (query && filterBySearch) {
            const hay = `${msg.name || ''}\n${text}`.toLowerCase();
            if (!hay.includes(query)) continue;
        }
        result.push({
            floorIndex: i, // 0-based 楼层号（第 0 楼通常为开场白）
            floorNo: i + 1, // 1-based 展示楼层号
            name: String(msg.name || (msg.is_user ? 'User' : 'Character')),
            isUser: Boolean(msg.is_user),
            isSystem: Boolean(msg.is_system),
            sendDate: String(msg.send_date || ''),
            rawText,
            filteredText,
            text,
            isEdited: hasManual,
            changedByFilter: filteredText !== rawText,
        });
    }
    return result;
}

export function paginateFloors(floors, page = 1, pageSize = 20) {
    const size = Math.max(1, Number(pageSize) || 20);
    const total = (floors || []).length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
    const start = (safePage - 1) * size;
    const items = (floors || []).slice(start, start + size);
    return { page: safePage, pageSize: size, total, totalPages, start, items };
}

export function serializeChatToTxt(floors, options = {}) {
    const includeHeader = options.includeHeader !== false;
    const includeFloorNo = options.includeFloorNo !== false;
    const parts = [];
    for (const f of floors || []) {
        const body = String(f.text ?? '').trim();
        if (!body && options.hideEmpty !== false) continue;
        if (includeHeader) {
            const prefix = includeFloorNo ? `#${f.floorNo} ${f.name}` : f.name;
            const datePart = f.sendDate ? ` (${f.sendDate})` : '';
            parts.push(`${prefix}${datePart}:\n${body}`);
        } else {
            parts.push(body);
        }
    }
    return parts.join('\n\n');
}

export function serializeChatToJsonl(header, rawMessages, effectiveFloors, options = {}) {
    const dropHidden = Boolean(options.dropHidden);
    const byIndex = new Map((effectiveFloors || []).map((f) => [f.floorIndex, f]));
    const lines = [];
    if (header && typeof header === 'object') {
        lines.push(JSON.stringify(header));
    }
    for (let i = 0; i < (rawMessages || []).length; i++) {
        const orig = rawMessages[i];
        if (!orig) continue;
        const eff = byIndex.get(i);
        if (!eff && dropHidden) continue;
        const copy = structuredClone(orig);
        if (eff) {
            copy.mes = eff.text;
            if (Array.isArray(copy.swipes) && typeof copy.swipe_id === 'number' && copy.swipes[copy.swipe_id] !== undefined) {
                copy.swipes[copy.swipe_id] = eff.text;
            }
        }
        lines.push(JSON.stringify(copy));
    }
    return lines.join('\n');
}

export function parseTxtToJsonl(txtContent, { charName = 'Character', userName = 'User' } = {}) {
    const text = String(txtContent || '').replace(/\r\n/g, '\n').trim();
    if (!text) throw Error('TXT 文件内容为空');
    const header = {
        user_name: userName || 'User',
        character_name: charName || 'Character',
        create_date: new Date().toISOString(),
        chat_metadata: {},
    };
    const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    const messages = [];
    const headerLineRe = /^(?:#\d+\s+)?([^:\n：(]{1,40}?)(?:\s*\([^)\n]+\))?\s*[:：]\s*([\s\S]*)$/;
    for (const block of blocks) {
        const m = block.match(headerLineRe);
        if (m) {
            const speaker = m[1].trim();
            const body = m[2].trim();
            const isUser =
                speaker.toLowerCase() === (userName || 'user').toLowerCase() ||
                ['user', 'you', '我', '用户'].includes(speaker.toLowerCase());
            messages.push({
                name: speaker,
                is_user: isUser,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: body,
            });
        } else {
            messages.push({
                name: charName || 'Character',
                is_user: false,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: block,
            });
        }
    }
    return [header, ...messages].map((obj) => JSON.stringify(obj)).join('\n');
}
