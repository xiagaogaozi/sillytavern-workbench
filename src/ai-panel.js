import { isDatabaseKind } from './database-model.js';
// 统一 AI 侧栏：上下文选择、讨论、生成修改与逐条审阅采纳（SPreset 风格）。
import { $, $$, esc, field, modal, notify, diffHtml, run } from './ui.js';
import { entries, fingerprint, commit, applyOperations, operationPreview } from './core.js';
import { rpc } from './bridge.js';
import { svg, iconBtn } from './icons.js';
import { editingContext, messagesFor, request, parseAIJson, proposalFrom, PROPOSAL_CONTRACT } from './ai.js';
import { editTemplates } from './settings.js';

export function sessionFor(env) {
    const d = env.getDraft();
    if (!d) return null;
    env.state.sessions ||= {};
    return (env.state.sessions[d.id] ||= {
        history: [],
        instruction: '',
        reference: '',
        channelId: '',
        whole: false,
        other: false,
        character: false,
        chat: false,
        recent: 8,
        proposal: null,
        text: '',
        running: false,
    });
}

async function context(env, s, discussion = false) {
    const d = env.getDraft();
    const extra =
        s.character || s.chat
            ? await rpc('context.read', { character: s.character, chat: s.chat, limit: s.recent })
            : undefined;
    if (discussion && !d.selected.length && !s.whole)
        return {
            selection: [],
            outline: entries(d).map((e) => ({ id: e.id, name: e.name })),
            references: { text: s.reference, extra },
            allowedIds: [],
            baseFingerprint: fingerprint(d.raw),
        };
    return editingContext(d, {
        selected: d.selected,
        readonly: d.readonly,
        excluded: d.excluded,
        whole: s.whole,
        other: s.other ? env.otherDraft() : null,
        reference: s.reference,
        extra,
    });
}

export function renderAI(env) {
    const panel = $('#ai-panel'),
        d = env.getDraft(),
        s = sessionFor(env);
    if (!panel) return;
    if (!d) {
        panel.innerHTML = `<div class="inspector-empty">${svg('ai', 28)}<p>请先打开一份文档，并在列表中勾选或选择要讨论/修改的条目。</p></div>`;
        return;
    }
    const pending = s.proposal?.operations.filter((_, i) => !s.proposal.accepted.includes(i)).length || 0;
    const activeFlags = [
        s.whole ? '全文' : '',
        s.other ? '另一侧' : '',
        s.character ? '角色' : '',
        s.chat ? `聊天${s.recent || 8}条` : '',
        s.reference?.trim() ? '参考资料' : '',
    ].filter(Boolean);

    panel.innerHTML = `
        <button type="button" data-ai="templates" hidden aria-hidden="true"></button>
        <div class="ai-scroll">
            <section class="ai-card ai-context">
                <div class="ai-ctx-bar">
                    <div class="ai-ctx-summary">
                        <span class="badge ${d.selected.length ? 'badge-live' : ''}">已选 ${d.selected.length} 条</span>
                        <select name="channelId" class="ai-channel-sel" title="选择 API 渠道">
                            ${[['', '酒馆主 API'], ...(env.config.channels || []).map((c) => [c.id, c.name])]
                                .map(([v, l]) => `<option value="${esc(v)}" ${String(s.channelId) === String(v) ? 'selected' : ''}>${esc(l)}</option>`)
                                .join('')}
                        </select>
                    </div>
                    <button type="button" class="mini-btn" data-ai="scope">${svg('filter', 12)} 范围</button>
                </div>
                <details class="insp-fold ai-ctx-fold">
                    <summary>上下文附件${activeFlags.length ? `（${esc(activeFlags.join(' · '))}）` : '（默认仅所选条目）'}</summary>
                    <div class="check-grid" style="margin-top:6px">
                        ${field('whole', '整份文档', s.whole, 'checkbox')}
                        ${field('other', '另一侧全文', s.other, 'checkbox')}
                        ${field('character', '当前角色', s.character, 'checkbox')}
                        ${field('chat', '最近聊天', s.chat, 'checkbox')}
                    </div>
                    <div class="inspector-grid" style="margin-top:6px">
                        ${field('recent', '最近聊天条数', s.recent, 'number')}
                        <div class="field full">
                            <label><span>手动只读参考资料</span></label>
                            <textarea name="reference" rows="3" placeholder="可粘贴背景设定或写作规范，仅作只读参考…">${esc(s.reference || '')}</textarea>
                        </div>
                    </div>
                </details>
            </section>

            <div class="ai-messages">
                ${
                    s.history.length
                        ? s.history
                              .slice(-12)
                              .map(
                                  (m) => `
                            <article class="ai-msg ${m.role === 'user' ? 'user' : 'assistant'}">
                                <div class="ai-msg-head">
                                    <span class="badge ${m.role === 'user' ? 'badge-usr' : 'badge-ast'}">${m.role === 'user' ? '你' : 'AI 助手'}</span>
                                </div>
                                <pre>${esc(m.content)}</pre>
                            </article>`,
                              )
                              .join('')
                        : `<div class="ai-empty-hint muted">输入需求后，点「讨论」只读分析，或点「生成修改」产出可逐条审阅的差异提案。</div>`
                }
            </div>

            ${
                s.text
                    ? `<details class="insp-fold ai-stream-card" open>
                           <summary>${s.running ? '正在流式生成…' : '最近一次原始响应'}</summary>
                           <pre class="stream-text">${esc(s.text)}</pre>
                       </details>`
                    : ''
            }
            ${s.error ? `<div class="ai-error-box">${esc(s.error)}</div>` : ''}
            ${
                s.proposal
                    ? `<section class="ai-card ai-proposal-card is-proposal">
                           <div class="ai-card-head">
                               <strong>${svg('diffAll', 13)} 修改提案</strong>
                               <span class="badge badge-dirty">${pending} 项待采纳</span>
                           </div>
                           <p class="muted" style="margin:0">${esc(s.proposal.summary)}</p>
                           <div class="row">
                               <button type="button" class="primary" data-ai="review">${svg('compare', 13)} 逐条审阅</button>
                               <button type="button" data-ai="accept-all">${svg('apply', 13)} 全部采纳</button>
                               <button type="button" class="danger" data-ai="discard">${svg('trash', 13)} 丢弃</button>
                           </div>
                       </section>`
                    : ''
            }
        </div>

        <div class="ai-compose">
            <textarea name="instruction" rows="3" placeholder="输入你希望讨论或修改的要求…">${esc(s.instruction || '')}</textarea>
            <div class="ai-compose-bar">
                <div class="row" style="gap:5px">
                    <button type="button" data-ai="discuss">讨论</button>
                    <button type="button" class="primary" data-ai="generate">${svg('ai', 13)} 生成修改</button>
                </div>
                <div class="row" style="gap:2px">
                    ${iconBtn('search', '预览实际发送的请求消息与 Token', 'data-ai="preview"', 'sm')}
                    ${iconBtn('json', '响应诊断 / 手动修正 JSON 重新解析', 'data-ai="diagnostics"', 'sm')}
                    ${iconBtn('trash', '清空当前文档 AI 会话', 'data-ai="clear"', 'sm danger')}
                    ${s.running ? iconBtn('close', '停止生成', 'data-ai="stop"', 'sm danger') : ''}
                </div>
            </div>
        </div>
    `;
    for (const e of $$('[name]', panel)) {
        const update = () => {
            s[e.name] = e.type === 'checkbox' ? e.checked : e.type === 'number' ? Number(e.value) : e.value;
            env.persist();
        };
        e.addEventListener(e.tagName === 'TEXTAREA' ? 'input' : 'change', update);
    }
    for (const b of $$('[data-ai]', panel)) b.onclick = run(() => action(env, b.dataset.ai));
    if (s.running)
        for (const b of $$('[data-ai]', panel))
            if (!['stop', 'diagnostics'].includes(b.dataset.ai)) b.disabled = true;
}

async function ask(env, task, vars, s) {
    const messages = messagesFor(env.config, task, vars, s.history);
    s.diagnostics = { task, messages };
    const result = await request(env.config, task, vars, {
        channelId: s.channelId,
        history: s.history,
        onStream: (text) => {
            s.text = text;
            const el = $('#ai-panel .stream-text');
            if (el) el.textContent = text;
        },
    });
    s.text = result.text;
    s.diagnostics.response = result.text;
    s.diagnostics.source = result.source;
    s.diagnostics.model = result.model;
    return result;
}

async function operation(env, fn) {
    const s = sessionFor(env);
    if (s.running) return;
    s.running = true;
    s.error = '';
    s.text = '正在等待模型…';
    renderAI(env);
    try {
        await fn(s);
    } catch (e) {
        s.error = e.message;
        notify(e.message, true);
    } finally {
        s.running = false;
        env.persist();
        renderAI(env);
    }
}

async function action(env, name) {
    const d = env.getDraft(),
        s = sessionFor(env);
    if (!d || !s) return;
    if (name === 'stop') {
        await rpc('ai.stop');
        return;
    }
    if (name === 'templates') {
        await editTemplates(env, d.kind);
        return;
    }
    if (name === 'scope') {
        await modal(
            '选择 AI 参与范围',
            '<p class="muted">可修改项会加入选择；只读项只作参考；排除项不发送正文。</p>' +
                entries(d)
                    .map((e) =>
                        field(
                            'scope:' + e.id,
                            e.name,
                            d.excluded?.includes(e.id)
                                ? 'exclude'
                                : d.readonly?.includes(e.id)
                                  ? 'readonly'
                                  : d.selected.includes(e.id)
                                    ? 'modify'
                                    : 'exclude',
                            'select',
                            {
                                choices: [
                                    ['modify', '可修改'],
                                    ['readonly', '只读参考'],
                                    ['exclude', '排除'],
                                ],
                            },
                        ),
                    )
                    .join(''),
            {
                onSubmit: (v) => {
                    d.selected = [];
                    d.readonly = [];
                    d.excluded = [];
                    for (const [k, mode] of Object.entries(v)) {
                        const id = k.slice(6);
                        (mode === 'modify' ? d.selected : mode === 'readonly' ? d.readonly : d.excluded).push(id);
                    }
                    env.changed();
                },
            },
        );
        return;
    }
    if (name === 'clear') {
        if (await modal('清空 AI 会话', '<p>仅清空当前文档的对话和提案，不改文档草稿。</p>')) {
            s.history = [];
            s.proposal = null;
            s.text = '';
            s.error = '';
            env.persist();
            renderAI(env);
        }
        return;
    }
    if (name === 'discard') {
        s.proposal = null;
        env.persist();
        renderAI(env);
        return;
    }
    if (name === 'accept-all') {
        await accept(env, s.proposal?.operations.map((_, i) => i) || []);
        return;
    }
    if (name === 'review') {
        await review(env);
        return;
    }
    if (name === 'diagnostics') {
        await modal(
            '请求与响应诊断',
            field('response', '最近响应（可修正 JSON 后重新解析）', s.text, 'textarea', { rows: 12 }) +
                '<details class="insp-fold"><summary>请求消息</summary><pre style="margin:6px 0 0;max-height:220px;overflow:auto">' +
                esc(JSON.stringify(s.diagnostics?.messages || [], null, 2)) +
                '</pre></details>' +
                (s.error ? '<p class="form-error">' + esc(s.error) + '</p>' : ''),
            {
                wide: true,
                submit: '重新解析为修改提案',
                onSubmit: async (v) => {
                    const c = await context(env, s);
                    s.proposal = proposalFrom(d, parseAIJson(v.response), c);
                    s.text = v.response;
                    s.error = '';
                    env.persist();
                    renderAI(env);
                },
            },
        );
        return;
    }
    const c = await context(env, s, name === 'discuss');
    const task = name === 'discuss' ? 'discuss' : d.kind;
    const contract = name === 'discuss' ? undefined : PROPOSAL_CONTRACT;
    const vars = { task: s.instruction || '检查并说明当前内容', ...c, output_schema: contract };
    if (name === 'preview') {
        const messages = messagesFor(env.config, task, vars, s.history);
        const count = await rpc('tokens', { text: JSON.stringify(messages) });
        await modal(
            '实际发送消息预览',
            '<p class="muted">约 ' +
                count +
                ' tokens；默认不包含未选中的聊天或角色资料。</p><pre class="diff">' +
                esc(JSON.stringify(messages, null, 2)) +
                '</pre>',
            { wide: true, submit: null },
        );
        return;
    }
    await operation(env, async () => {
        const result = await ask(env, task, vars, s);
        if (name !== 'discuss') s.proposal = proposalFrom(d, parseAIJson(result.text), c);
        s.history.push(
            { role: 'user', content: s.instruction || '检查并说明当前内容' },
            { role: 'assistant', content: result.text },
        );
    });
}

async function accept(env, indices) {
    const d = env.getDraft(),
        s = sessionFor(env),
        p = s.proposal;
    if (!p) return;
    if (p.baseFingerprint !== fingerprint(d.raw)) throw Error('草稿已改变，不能套用旧提案；请重新生成');
    const selected = indices.filter((i) => !p.accepted.includes(i));
    if (!selected.length) return;
    commit(d, '采纳 AI 修改', () =>
        applyOperations(
            d,
            selected.map((i) => p.operations[i]),
        ),
    );
    p.accepted.push(...selected);
    p.baseFingerprint = fingerprint(d.raw);
    env.changed();
    notify('已采纳到草稿；还没有写回原文件');
}

async function review(env) {
    const d = env.getDraft(),
        s = sessionFor(env),
        p = s.proposal;
    if (!p) return;
    let html = '';
    for (let i = 0; i < p.operations.length; i++) {
        const op = p.operations[i],
            accepted = p.accepted.includes(i);
        let diff = '';
        try {
            const v = operationPreview(d, op);
            diff = isDatabaseKind(d.kind)
                ? await diffHtml(JSON.stringify(v.before?.raw || null, null, 2), JSON.stringify(v.after?.raw || null, null, 2))
                : await diffHtml(v.before?.content || '', v.after?.content || '');
        } catch (e) {
            diff = esc(e.message);
        }
        html +=
            '<section class="ai-card"><div class="ai-card-head"><strong>' +
            esc(op.type + ' · ' + (op.id || '新条目')) +
            '</strong><div class="row">' +
            (accepted
                ? '<span class="badge badge-live">已采纳</span>'
                : '<button type="button" class="mini-btn primary" data-accept="' +
                  i +
                  '">采纳此项</button><button type="button" class="mini-btn" data-edit="' +
                  i +
                  '">人工修订</button>') +
            '</div></div><pre class="diff">' +
            diff +
            '</pre><details class="insp-fold"><summary>完整操作 JSON</summary><pre style="margin:6px 0 0">' +
            esc(JSON.stringify(op, null, 2)) +
            '</pre></details></section>';
    }
    await modal('修改提案逐条审阅', html, {
        wide: true,
        submit: '采纳剩余全部',
        onSubmit: () =>
            accept(
                env,
                p.operations.map((_, i) => i),
            ),
        onMount: (dialog) => {
            for (const b of $$('[data-accept]', dialog))
                b.onclick = run(async () => {
                    await accept(env, [Number(b.dataset.accept)]);
                    b.disabled = true;
                    b.textContent = '已采纳';
                });
            for (const b of $$('[data-edit]', dialog))
                b.onclick = run(async () => {
                    const i = Number(b.dataset.edit),
                        v = await modal(
                            '人工修订此操作',
                            field('operation', '操作 JSON', p.operations[i], 'json', { rows: 15 }),
                            { wide: true },
                        );
                    if (v) {
                        const c = await context(env, s);
                        const parsed = proposalFrom(d, { operations: [v.operation] }, c);
                        p.operations[i] = parsed.operations[0];
                        env.persist();
                        notify('修订已保存，重新打开审阅可查看新差异');
                    }
                });
        },
    });
}
