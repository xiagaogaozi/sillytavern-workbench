// UI 基础控件与差异渲染，所有不可信文本按文本或转义 HTML 呈现。
export const esc = (value) =>
    String(value ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const button = (label, action, cls = '') =>
    '<button type="button" class="' + cls + '" data-action="' + esc(action) + '">' + esc(label) + '</button>';
let fieldSerial = 0;
export function field(name, label, value = '', type = 'text', options = {}) {
    const controlId = 'pww-field-' + ++fieldSerial;
    const attr =
        ' id="' +
        controlId +
        '" name="' +
        esc(name) +
        '"' +
        (options.readonly ? ' readonly' : '') +
        (options.required ? ' required' : '');
    let input;
    if (type === 'checkbox')
        return (
            '<label class="check"><input type="checkbox"' +
            attr +
            (value ? ' checked' : '') +
            '>' +
            esc(label) +
            '</label>'
        );
    if (type === 'select') {
        const renderOpt = (item) => {
            const [v, l] = Array.isArray(item) ? item : [item, item];
            return (
                '<option value="' +
                esc(v) +
                '"' +
                (String(value) === String(v) ? ' selected' : '') +
                '>' +
                esc(l) +
                '</option>'
            );
        };
        input =
            '<select' +
            attr +
            '>' +
            options.choices
                .map((item) =>
                    item && typeof item === 'object' && !Array.isArray(item) && Array.isArray(item.items)
                        ? '<optgroup label="' + esc(item.group) + '">' + item.items.map(renderOpt).join('') + '</optgroup>'
                        : renderOpt(item),
                )
                .join('') +
            '</select>';
    }
    else if (['textarea', 'json', 'list'].includes(type))
        input =
            '<textarea' +
            attr +
            ' data-type="' +
            type +
            '" rows="' +
            (options.rows || 5) +
            '" spellcheck="false">' +
            esc(
                type === 'json'
                    ? JSON.stringify(value ?? {}, null, 2)
                    : type === 'list'
                      ? Array.isArray(value)
                          ? value.join(', ')
                          : value
                      : value,
            ) +
            '</textarea>';
    else
        input =
            '<input type="' +
            type +
            '"' +
            attr +
            ' value="' +
            esc(value) +
            '"' +
            (type === 'number' ? ' step="any" data-type="number"' : '') +
            '>';
    return (
        '<div class="field' +
        (options.wide ? ' full' : '') +
        '"><label for="' +
        controlId +
        '"><span>' +
        esc(label) +
        '</span></label>' +
        input +
        (options.help ? '<small>' + esc(options.help) + '</small>' : '') +
        '</div>'
    );
}
export function values(form) {
    const result = {};
    for (const e of $$('[name]', form)) {
        if (e.disabled) continue;
        let value = e.type === 'checkbox' ? e.checked : e.value;
        if (e.dataset.type === 'number') value = value === '' ? null : Number(value);
        if (e.dataset.type === 'json') {
            try {
                value = JSON.parse(value || 'null');
            } catch {
                throw Error(e.name + ' 不是有效 JSON');
            }
        }
        if (e.dataset.type === 'list')
            value = String(value)
                .split(/[,，\n]/)
                .map((s) => s.trim())
                .filter(Boolean);
        result[e.name] = value;
    }
    return result;
}
export function notify(text, error = false) {
    const node = document.createElement('div');
    node.className = 'toast' + (error ? ' error' : '');
    node.textContent = text;
    $('#notifications').append(node);
    setTimeout(() => node.remove(), 7000);
}
// 用 CSS 约束下拉框宽度，不再同步遍历所有 option 做 Canvas 测量触发强制重排。
export function fitSelectLabels() {}

export function modal(title, body, { submit = '确认', onSubmit, onSaveAs, onMount, wide = false, footer = '', busyText = '正在处理，请稍候…', hideCancel = false } = {}) {
    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        let selectObserver;
        dialog.className = 'sheet' + (wide ? ' wide' : '');
        dialog.innerHTML =
            '<form><header><h2 title="' + esc(title) + '">' +
            esc(title) +
            '</h2><button type="button" data-cancel aria-label="关闭">×</button></header><div class="sheet-body">' +
            body +
            '</div><p class="form-error" role="alert"></p><p class="form-status" role="status" aria-live="polite"></p><footer>' +
            footer +
            (hideCancel ? '' : '<button type="button" data-cancel>取消</button>') +
            (onSaveAs ? '<button type="button" data-save-as>另存为…</button>' : '') +
            (submit ? '<button class="primary" type="submit">' + esc(submit) + '</button>' : '') +
            '</footer></form>';
        $('#dialogs').append(dialog);
        const close = (value) => {
            selectObserver?.disconnect();
            dialog.close();
            dialog.remove();
            resolve(value);
        };
        $$('[data-cancel]', dialog).forEach((b) => (b.onclick = () => close(null)));
        dialog.addEventListener('cancel', (e) => {
            e.preventDefault();
            if(!busy) close(null);
        });
        let busy = false;
        const execute = async (handler, shouldClose) => {
            const form = dialog.querySelector('form');
            if (busy || !form.reportValidity()) return;
            busy = true;
            form.setAttribute('aria-busy','true');
            $('.form-status',dialog).textContent=busyText;
            const controls = [...dialog.querySelectorAll('[type=submit], [data-save-as], [data-cancel]')].map(button => [button, button.disabled, button.textContent]);
            for (const [button] of controls) {button.disabled = true; if(button.type==='submit' && shouldClose)button.textContent='处理中…';}
            $('.form-error', dialog).textContent = '';
            try {
                const v = values(form);
                const result = handler ? await handler(v, dialog) : v;
                if (shouldClose && result !== false) close(result === undefined ? v : result);
            } catch (err) {
                $('.form-error', dialog).textContent = err.message;
            } finally {
                busy = false;
                form.removeAttribute('aria-busy');
                $('.form-status',dialog).textContent='';
                for (const [button, disabled, text] of controls) if (button.isConnected) {button.disabled = disabled;button.textContent=text;}
            }
        };
        dialog.querySelector('form').onsubmit = e => {e.preventDefault();if (submit) void execute(onSubmit, true);};
        const saveAs = dialog.querySelector('[data-save-as]');
        if (saveAs) saveAs.onclick = () => execute(onSaveAs, false);
        dialog.showModal();
        const fit = () => fitSelectLabels(dialog);
        dialog.addEventListener('change', fit);
        if (typeof ResizeObserver !== 'undefined') {
            selectObserver = new ResizeObserver(fit);
            selectObserver.observe(dialog);
        }
        onMount?.(dialog, close);
        fit();
        document.fonts?.ready.then(fit);
    });
}
export const confirmAction = (title, text, submit = '确认') =>
    modal(title, '<p>' + esc(text) + '</p>', { submit });
export function download(name, data, type = 'application/json') {
    const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 4)], { type });
    const url = URL.createObjectURL(blob),
        a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function pickFile(accept = '.json,.yaml,.yml,.txt,.md') {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
        input.addEventListener('cancel', () => resolve(null), { once: true });
        input.click();
    });
}
let dmp;
export async function diffHtml(before, after) {
    try {
        if (!dmp) {
            const { DiffMatchPatch } = await import('/lib.js');
            dmp = new DiffMatchPatch();
        }
        const diff = dmp.diff_main(String(before), String(after));
        dmp.diff_cleanupSemantic(diff);
        return diff
            .map(
                ([op, text]) =>
                    '<' +
                    (op === 1 ? 'ins' : op === -1 ? 'del' : 'span') +
                    '>' +
                    esc(text) +
                    '</' +
                    (op === 1 ? 'ins' : op === -1 ? 'del' : 'span') +
                    '>',
            )
            .join('');
    } catch {
        return '<del>' + esc(before) + '</del>\n<ins>' + esc(after) + '</ins>';
    }
}
export async function parseDocumentText(text) {
    try {
        return JSON.parse(text);
    } catch {
        const { yaml } = await import('/lib.js');
        const normalized = /^\s*---(?:\s|$)/m.test(text)
            ? text
            : text.replace(/^(uid:\s*[^\n]*$)/gm, '---\n$1');
        const docs = yaml.parseAllDocuments(normalized).map((x) => {
            if (x.errors?.length) throw x.errors[0];
            return x.toJSON();
        });
        return docs.length === 1 ? docs[0] : docs;
    }
}
export async function yamlString(value) {
    const { yaml } = await import('/lib.js');
    return yaml.stringify(value);
}
export function run(fn) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (e) {
            notify(e.message, true);
        }
    };
}

// Preserve native horizontal toolbar position across draft re-renders; no wheel/touch interception.
export function captureToolbarScroll() {
    return [...document.querySelectorAll('[data-toolbar-scroll]')].map(el => [el.dataset.toolbarScroll, el.scrollLeft]);
}
export function restoreToolbarScroll(positions) {
    for (const [key, left] of positions) {
        const el=[...document.querySelectorAll('[data-toolbar-scroll]')].find(el=>el.dataset.toolbarScroll===key);
        if(el) el.scrollLeft=left;
    }
}
