// 高性能差异对比（新增高亮 + 删除线划掉）与安全字面量搜索高亮/跳转定位引擎。
import { esc } from './ui.js';

export function normalizeQuery(q) {
    return String(q ?? '').trim().toLocaleLowerCase();
}

export function findSearchRanges(text, query) {
    text = String(text ?? '');
    const needle = normalizeQuery(query);
    if (!needle) return [];
    const folded = text.toLocaleLowerCase();
    const ranges = [];
    let offsets;
    if (folded.length !== text.length) {
        offsets = [];
        let start = 0;
        for (const ch of text) {
            const len = ch.toLocaleLowerCase().length;
            for (let i = 0; i < len; i++) offsets.push([start, start + ch.length]);
            start += ch.length;
        }
    }
    for (let from = 0, idx; (idx = folded.indexOf(needle, from)) !== -1; ) {
        const end = idx + needle.length;
        const range = offsets ? [offsets[idx][0], offsets[end - 1][1]] : [idx, end];
        const prev = ranges.at(-1);
        if (prev && range[0] < prev[1]) prev[1] = Math.max(prev[1], range[1]);
        else ranges.push(range);
        from = end;
    }
    return ranges;
}

export function highlightHtml(text, query, activeHitIndex = -1, hitCounter = { n: 0 }) {
    text = String(text ?? '');
    const ranges = findSearchRanges(text, query);
    if (!ranges.length) return esc(text);
    let out = '',
        at = 0;
    for (const [s, e] of ranges) {
        if (s > at) out += esc(text.slice(at, s));
        const idx = hitCounter.n++;
        const cls = idx === activeHitIndex ? 'pww-hit is-current' : 'pww-hit';
        out += `<mark class="${cls}" data-hit-index="${idx}">${esc(text.slice(s, e))}</mark>`;
        at = e;
    }
    if (at < text.length) out += esc(text.slice(at));
    return out;
}

// 轻量 Myers/LCS 序列 Diff，用于行级和字符级（自动裁剪公共前后缀并保护超大文本）
function diffSeq(a, b, maxCells = 180000) {
    let start = 0;
    const minLen = Math.min(a.length, b.length);
    while (start < minLen && a[start] === b[start]) start++;
    let endA = a.length - 1,
        endB = b.length - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) {
        endA--;
        endB--;
    }
    const prefix = a.slice(0, start).map((v) => ({ t: ' ', v }));
    const suffix = a.slice(endA + 1).map((v) => ({ t: ' ', v }));
    const midA = a.slice(start, endA + 1);
    const midB = b.slice(start, endB + 1);
    if (!midA.length && !midB.length) return prefix.concat(suffix);
    if (!midA.length) return prefix.concat(midB.map((v) => ({ t: '+', v })), suffix);
    if (!midB.length) return prefix.concat(midA.map((v) => ({ t: '-', v })), suffix);
    if (midA.length * midB.length > maxCells) {
        return prefix.concat(
            midA.map((v) => ({ t: '-', v })),
            midB.map((v) => ({ t: '+', v })),
            suffix,
        );
    }
    const n = midA.length,
        m = midB.length;
    const dp = new Int32Array((n + 1) * (m + 1));
    const stride = m + 1;
    for (let i = n - 1; i >= 0; i--) {
        const ai = midA[i];
        const row = i * stride;
        const nextRow = (i + 1) * stride;
        for (let j = m - 1; j >= 0; j--) {
            dp[row + j] = ai === midB[j] ? dp[nextRow + j + 1] + 1 : Math.max(dp[nextRow + j], dp[row + j + 1]);
        }
    }
    const mid = [];
    let i = 0,
        j = 0;
    while (i < n && j < m) {
        if (midA[i] === midB[j]) {
            mid.push({ t: ' ', v: midA[i] });
            i++;
            j++;
        } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
            mid.push({ t: '-', v: midA[i++] });
        } else {
            mid.push({ t: '+', v: midB[j++] });
        }
    }
    while (i < n) mid.push({ t: '-', v: midA[i++] });
    while (j < m) mid.push({ t: '+', v: midB[j++] });
    return prefix.concat(mid, suffix);
}

function tokenizeInline(line) {
    // 兼顾中文单字与英文单词，提升可读性且缩小 DP 矩阵
    return String(line).match(/[A-Za-z0-9_]+|[\u4e00-\u9fff]|[^\s]|\s+/g) || [];
}

function inlineDiffSegments(oldLine, newLine) {
    const a = tokenizeInline(oldLine),
        b = tokenizeInline(newLine);
    const ops = diffSeq(a, b, 60000);
    const merged = [];
    for (const op of ops) {
        const prev = merged.at(-1);
        if (prev && prev.t === op.t) prev.text += op.v;
        else merged.push({ t: op.t, text: op.v });
    }
    return merged;
}

export function buildDiffRows(oldText, newText) {
    const a = String(oldText ?? '').replace(/\r\n/g, '\n').split('\n');
    const b = String(newText ?? '').replace(/\r\n/g, '\n').split('\n');
    const ops = diffSeq(a, b, 180000);
    const rows = [];
    let oldNo = 1,
        newNo = 1;
    let i = 0;
    while (i < ops.length) {
        if (ops[i].t === ' ') {
            rows.push({ t: ' ', oldNo: oldNo++, newNo: newNo++, segs: [{ t: ' ', text: ops[i].v }] });
            i++;
            continue;
        }
        const dels = [],
            adds = [];
        while (i < ops.length && ops[i].t !== ' ') {
            if (ops[i].t === '-') dels.push(ops[i].v);
            else adds.push(ops[i].v);
            i++;
        }
        const paired = Math.min(dels.length, adds.length);
        for (let k = 0; k < paired; k++) {
            const segs = inlineDiffSegments(dels[k], adds[k]);
            rows.push({
                t: '~',
                paired: true,
                oldNo: oldNo++,
                newNo: newNo++,
                oldSegs: segs.filter((s) => s.t !== '+'),
                newSegs: segs.filter((s) => s.t !== '-'),
                segs,
            });
        }
        for (let k = paired; k < dels.length; k++) {
            rows.push({ t: '-', oldNo: oldNo++, newNo: null, segs: [{ t: '-', text: dels[k] }] });
        }
        for (let k = paired; k < adds.length; k++) {
            rows.push({ t: '+', oldNo: null, newNo: newNo++, segs: [{ t: '+', text: adds[k] }] });
        }
    }
    return rows;
}

export function renderInlineDiffHtml(oldText, newText, query = '', activeHit = -1) {
    const rows = buildDiffRows(oldText, newText);
    const hitCounter = { n: 0 };
    const renderSegs = (segs) =>
        segs
            .map((s) => {
                const inner = highlightHtml(s.text, query, activeHit, hitCounter);
                if (s.t === '-') return `<del class="pww-diff-del">${inner}</del>`;
                if (s.t === '+') return `<ins class="pww-diff-ins">${inner}</ins>`;
                return inner;
            })
            .join('');

    let changedCount = 0;
    const html = rows
        .map((row) => {
            if (row.t !== ' ') changedCount++;
            const rowCls =
                row.t === '-'
                    ? 'pww-diff-line is-del'
                    : row.t === '+'
                      ? 'pww-diff-line is-ins'
                      : row.t === '~'
                        ? 'pww-diff-line is-mod'
                        : 'pww-diff-line is-eq';
            const sign = row.t === '-' ? '−' : row.t === '+' ? '+' : row.t === '~' ? '~' : ' ';
            const ln = row.oldNo != null && row.newNo != null
                ? `${row.oldNo}→${row.newNo}`
                : row.oldNo != null
                  ? String(row.oldNo)
                  : String(row.newNo);
            return `<div class="${rowCls}"><span class="pww-diff-ln">${ln}</span><span class="pww-diff-sign">${sign}</span><span class="pww-diff-code">${renderSegs(row.segs)}</span></div>`;
        })
        .join('');
    return { html, changedCount, totalHits: hitCounter.n, rows };
}

export function renderSideBySideDiffHtml(oldText, newText, query = '', activeHit = -1) {
    const rows = buildDiffRows(oldText, newText);
    const hitCounter = { n: 0 };
    const renderSegs = (segs) =>
        (segs || [])
            .map((s) => {
                const inner = highlightHtml(s.text, query, activeHit, hitCounter);
                if (s.t === '-') return `<del class="pww-diff-del">${inner}</del>`;
                if (s.t === '+') return `<ins class="pww-diff-ins">${inner}</ins>`;
                return inner;
            })
            .join('');

    let changedCount = 0;
    const html = rows
        .map((row) => {
            if (row.t !== ' ') changedCount++;
            const leftSegs = row.t === '~' ? row.oldSegs : row.t === '+' ? null : row.segs;
            const rightSegs = row.t === '~' ? row.newSegs : row.t === '-' ? null : row.segs;
            const lCls = row.t === '-' || row.t === '~' ? 'is-del' : row.t === '+' ? 'is-empty' : 'is-eq';
            const rCls = row.t === '+' || row.t === '~' ? 'is-ins' : row.t === '-' ? 'is-empty' : 'is-eq';
            return (
                `<div class="pww-sbs-row">` +
                `<div class="pww-sbs-cell ${lCls}"><span class="pww-diff-ln">${row.oldNo ?? ''}</span><span class="pww-diff-code">${leftSegs ? renderSegs(leftSegs) : ''}</span></div>` +
                `<div class="pww-sbs-cell ${rCls}"><span class="pww-diff-ln">${row.newNo ?? ''}</span><span class="pww-diff-code">${rightSegs ? renderSegs(rightSegs) : ''}</span></div>` +
                `</div>`
            );
        })
        .join('');
    return { html, changedCount, totalHits: hitCounter.n, rows };
}

export function collectEntrySearchHits(list, query) {
    const needle = normalizeQuery(query);
    if (!needle) return [];
    const hits = [];
    for (const e of list) {
        const inName = findSearchRanges(e.name, needle).length;
        const inContent = findSearchRanges(e.content, needle).length;
        const inId = findSearchRanges(e.id, needle).length;
        const count = inName + inContent + inId;
        if (count > 0) hits.push({ id: e.id, count, inName, inContent, inId });
    }
    return hits;
}
