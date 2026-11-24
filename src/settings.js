// 精简版工作台设置与 AI 提示词模板编辑器（完全跟随酒馆主题，风格统一）
import { $, $$, esc, field, modal, notify, download, pickFile, run, values } from './ui.js';
import { clone, uuid } from './core.js';
import { defaultTemplates, TASK_LABELS } from './ai.js';
import { rpc } from './bridge.js';
import { svg, iconBtn } from './icons.js';

export async function editTemplates(env, initial = 'preset') {
    const templates = clone(env.config.templates || {});
    let task = TASK_LABELS[initial] ? initial : 'preset',
        segments = clone(templates[task] || defaultTemplates()[task]);
    const html = () =>
        `<div class="settings-card">
            <div class="row" style="justify-content:space-between">
                <div style="flex:1;min-width:180px">${field('task', '任务模板', task, 'select', { choices: Object.entries(TASK_LABELS) })}</div>
                <div class="row" style="padding-top:16px">
                    <button type="button" data-add>${svg('plus', 13)} 添加段</button>
                    <button type="button" data-reset>${svg('reset', 13)} 恢复默认</button>
                    <button type="button" data-import>${svg('import', 13)} 导入</button>
                    <button type="button" data-export>${svg('export', 13)} 导出</button>
                </div>
            </div>
            <p class="muted" style="margin:0">可用占位符：<code>{{task}}</code> · <code>{{selection}}</code> · <code>{{outline}}</code> · <code>{{references}}</code> · <code>{{output_schema}}</code></p>
        </div>
        <div class="entry-list">
            ${segments
                .map(
                    (s, i) => `
                <section class="settings-card" data-index="${i}">
                    <div class="row" style="justify-content:space-between">
                        <div class="row">
                            <select name="role${i}">
                                ${['system', 'user', 'assistant']
                                    .map((r) => `<option value="${r}" ${s.role === r ? 'selected' : ''}>${r}</option>`)
                                    .join('')}
                            </select>
                            ${field('enabled' + i, '启用', s.enabled !== false, 'checkbox')}
                        </div>
                        <div class="row" style="gap:2px">
                            ${iconBtn('up', '上移', `data-up="${i}"`, 'sm')}
                            ${iconBtn('down', '下移', `data-down="${i}"`, 'sm')}
                            ${iconBtn('trash', '删除', `data-remove="${i}"`, 'sm danger')}
                        </div>
                    </div>
                    <textarea name="content${i}" rows="5" spellcheck="false">${esc(s.content || '')}</textarea>
                </section>`,
                )
                .join('')}
        </div>`;

    await modal('AI 分段提示词模板', html(), {
        wide: true,
        submit: '保存模板',
        onSubmit: async (v) => {
            segments = segments.map((s, i) => ({
                ...s,
                role: v['role' + i],
                enabled: v['enabled' + i],
                content: v['content' + i],
            }));
            templates[task] = segments;
            env.config.templates = templates;
            await env.saveConfig();
            notify('AI 模板已保存');
        },
        onMount: (dialog) => {
            const capture = () => {
                const v = values($('form', dialog));
                segments = segments.map((s, i) => ({
                    ...s,
                    role: v['role' + i],
                    enabled: v['enabled' + i],
                    content: v['content' + i],
                }));
            };
            const wire = () => {
                $('[name=task]', dialog).onchange = run(async (e) => {
                    capture();
                    templates[task] = segments;
                    task = e.target.value;
                    segments = clone(templates[task] || defaultTemplates()[task]);
                    render();
                });
                $('[data-add]', dialog).onclick = () => {
                    capture();
                    segments.push({ id: uuid(), role: 'user', enabled: true, content: '' });
                    render();
                };
                $('[data-reset]', dialog).onclick = () => {
                    segments = defaultTemplates()[task];
                    render();
                };
                $('[data-export]', dialog).onclick = () => {
                    capture();
                    download('pww-prompt-' + task + '.json', {
                        schema: 'pww-prompt',
                        version: 1,
                        task,
                        segments,
                    });
                };
                $('[data-import]', dialog).onclick = run(async () => {
                    const file = await pickFile('.json');
                    if (!file) return;
                    const v = JSON.parse(await file.text());
                    const incoming = Array.isArray(v) ? v : v.segments;
                    if (
                        !Array.isArray(incoming) ||
                        incoming.some(
                            (s) =>
                                !['system', 'user', 'assistant'].includes(String(s.role).toLowerCase()) ||
                                typeof s.content !== 'string',
                        )
                    )
                        throw Error('模板必须包含合法角色与正文');
                    segments = incoming.map((s) => ({
                        ...s,
                        id: s.id || uuid(),
                        role: s.role.toLowerCase(),
                        enabled: s.enabled !== false,
                    }));
                    render();
                });
                for (const el of $$('[data-up],[data-down],[data-remove]', dialog))
                    el.onclick = () => {
                        capture();
                        const i = Number(el.dataset.up ?? el.dataset.down ?? el.dataset.remove);
                        if (el.hasAttribute('data-remove')) segments.splice(i, 1);
                        else {
                            const j = i + (el.hasAttribute('data-up') ? -1 : 1);
                            if (j >= 0 && j < segments.length) [segments[i], segments[j]] = [segments[j], segments[i]];
                        }
                        render();
                    };
            };
            const render = () => {
                $('.sheet-body', dialog).innerHTML = html();
                wire();
            };
            wire();
        },
    });
}

function validateChannel(value, allowMissingModel = false) {
    if (!value.name?.trim() || (!allowMissingModel && !value.model?.trim()))
        throw Error('渠道名称与模型不能为空');
    if (value.authMode !== 'none' && !value.secretId?.trim())
        throw Error('请选择密钥引用；本地无密钥服务请明确选择无密钥模式');
    if (value.authMode === 'none' && value.source !== 'custom') throw Error('无密钥模式仅用于自定义 API');
    if (value.source === 'custom') {
        let url;
        try {
            url = new URL(value.url);
        } catch {
            throw Error('请填写完整的自定义 API 地址');
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw Error('API 地址必须是无内嵌凭据的 http/https 地址');
    }
    return value;
}

async function channelEditor(
    env,
    channel = { id: uuid(), name: '独立渠道', source: 'custom', model: '', url: '', secretId: '' },
) {
    const result = await modal(
        '独立模型渠道',
        `<div class="inspector-grid">
            ${field('name', '渠道名称', channel.name)}
            ${field('source', '来源', channel.source, 'select', {
                choices: ['custom', 'openai', 'openrouter', 'claude', 'makersuite', 'deepseek', 'xai', 'mistralai'],
            })}
            ${field('url', '自定义端点 URL（仅 custom）', channel.url || '', 'text', { wide: true })}
            ${field('model', '模型名称', channel.model || '')}
            ${field('authMode', '认证方式', channel.authMode || 'secret', 'select', {
                choices: [
                    ['secret', '酒馆已存密钥引用'],
                    ['none', '本地无密钥（仅 custom）'],
                ],
            })}
            <div class="field full">
                <label><span>密钥引用</span><button type="button" class="mini-btn" data-add-secret>${svg('plus', 12)} 存入新密钥</button></label>
                <div class="row"><select name="secretId" style="flex:1"></select></div>
                <small>工作台绝不保存明文 API Key，只存酒馆密钥引用 ID。</small>
            </div>
            ${field('temperature', '温度', channel.temperature ?? 0.4, 'number')}
            ${field('maxTokens', '输出上限 tokens', channel.maxTokens ?? 4096, 'number')}
            <div class="field full"><button type="button" data-models>${svg('refresh', 13)} 拉取可用模型列表</button></div>
        </div>`,
        {
            wide: true,
            onSubmit: (v) => validateChannel({ ...channel, ...v }),
            onMount: (dialog) => {
                const loadSecrets = run(async (selected = channel.secretId) => {
                    const list = await rpc('ai.secrets', { source: $('[name=source]', dialog).value });
                    $('[name=secretId]', dialog).innerHTML =
                        '<option value="">选择密钥引用…</option>' +
                        list.items
                            .map(
                                (s) =>
                                    '<option value="' +
                                    esc(s.id) +
                                    '"' +
                                    (s.id === selected ? ' selected' : '') +
                                    '>' +
                                    esc((s.label || s.id) + (s.active ? '（当前）' : '')) +
                                    '</option>',
                            )
                            .join('');
                });
                $('[name=source]', dialog).onchange = () => loadSecrets('');
                $('[data-add-secret]', dialog).onclick = run(async () => {
                    const v = await modal(
                        '存入酒馆密钥',
                        field('label', '标签', '工作台渠道') +
                            field('value', '密钥（仅发送到酒馆密钥库）', '', 'password'),
                    );
                    if (!v) return;
                    const created = await rpc('ai.addSecret', {
                        source: $('[name=source]', dialog).value,
                        label: v.label,
                        value: v.value,
                    });
                    await loadSecrets(created.id);
                });
                $('[data-models]', dialog).onclick = run(async () => {
                    const draft = validateChannel({ ...channel, ...values($('form', dialog)) }, true);
                    const models = await rpc('ai.models', { draftChannel: draft });
                    if (!models.length) {
                        notify('未返回模型列表', true);
                        return;
                    }
                    const picked = await modal(
                        '选择模型',
                        field('model', '模型', models[0], 'select', { choices: models }),
                    );
                    if (picked) $('[name=model]', dialog).value = picked.model;
                });
                loadSecrets();
            },
        },
    );
    if (!result) return;
    env.config.channels ||= [];
    const i = env.config.channels.findIndex((c) => c.id === result.id);
    if (i >= 0) env.config.channels[i] = result;
    else env.config.channels.push(result);
    await env.saveConfig();
}

export async function openSettings(env, runtime) {
    const theme = env.config.theme || {},
        ai = env.config.ai || {};
    await modal(
        '工作台设置',
        `<section class="settings-card">
            <div class="settings-card-head">
                <strong>${svg('sliders', 14)} 界面显示</strong>
                <span class="muted">配色自动跟随酒馆主题</span>
            </div>
            <div class="inspector-grid">
                ${field('themeMode', '主题模式', theme.mode || 'inherit', 'select', {
                    choices: [
                        ['inherit', '跟随酒馆'],
                        ['dark', '深色'],
                        ['light', '浅色'],
                    ],
                })}
                ${field('fontScale', '字号比例', theme.fontScale || 1, 'number')}
                ${field('rowHeight', '条目最小高度 (px)', theme.rowHeight || 52, 'number')}
            </div>
            <div class="check-grid">
                ${field('fullscreen', '全屏显示工作台', theme.fullscreen !== false, 'checkbox')}
            </div>
        </section>

        <section class="settings-card">
            <div class="settings-card-head">
                <strong>${svg('ai', 14)} AI 默认参数</strong>
                <span class="muted">主 API：${esc((runtime.connection?.source || '未连接') + ' · ' + (runtime.connection?.model || '未选模型'))}</span>
            </div>
            <div class="inspector-grid">
                ${field('maxTokens', '预留输出 tokens', ai.maxTokens || 6000, 'number')}
                ${field('warningTokens', '输入警戒 tokens', ai.warningTokens || 30000, 'number')}
                ${field('temperature', '温度 (Temperature)', ai.temperature ?? 0.4, 'number')}
            </div>
            <div class="check-grid">
                ${field('stream', '流式输出显示', ai.stream !== false, 'checkbox')}
            </div>
        </section>

        <section class="settings-card">
            <div class="settings-card-head">
                <strong>${svg('link', 14)} 独立模型渠道</strong>
                <button type="button" class="mini-btn" data-add-channel>${svg('plus', 12)} 添加渠道</button>
            </div>
            <div class="entry-list" data-channels></div>
        </section>

        <section class="settings-card">
            <div class="settings-card-head">
                <strong>${svg('export', 14)} 设置迁移</strong>
                <span class="muted">不含密钥与备份文件</span>
            </div>
            <div class="row">
                <button type="button" data-export>${svg('export', 13)} 导出设置</button>
                <button type="button" data-import>${svg('import', 13)} 导入设置</button>
            </div>
        </section>`,
        {
            wide: true,
            submit: '保存设置',
            onSubmit: async (v) => {
                env.config.theme = {
                    mode: v.themeMode,
                    fontScale: Number(v.fontScale) || 1,
                    rowHeight: Math.max(40, Number(v.rowHeight) || 52),
                    fullscreen: Boolean(v.fullscreen),
                };
                env.config.ai = {
                    maxTokens: Math.max(256, Number(v.maxTokens) || 6000),
                    warningTokens: Math.max(1000, Number(v.warningTokens) || 30000),
                    temperature: Number(v.temperature ?? 0.4),
                    stream: Boolean(v.stream),
                };
                await env.saveConfig();
                notify('工作台设置已保存');
            },
            onMount: (dialog, close) => {
                const renderChannels = () => {
                    $('[data-channels]', dialog).innerHTML =
                        (env.config.channels || [])
                            .map(
                                (c) => `
                            <div class="settings-row">
                                <span><strong>${esc(c.name)}</strong> <span class="muted">· ${esc(c.model || '未指定模型')}</span></span>
                                <div class="row" style="gap:4px">
                                    <button type="button" class="mini-btn" data-edit="${esc(c.id)}">编辑</button>
                                    <button type="button" class="mini-btn" data-models="${esc(c.id)}">模型</button>
                                    <button type="button" class="mini-btn danger" data-remove="${esc(c.id)}">移除</button>
                                </div>
                            </div>`,
                            )
                            .join('') || '<p class="muted" style="margin:0">默认直接使用酒馆主 API，无需额外配置。</p>';
                    for (const el of $$('[data-edit]', dialog))
                        el.onclick = run(async () => {
                            await channelEditor(
                                env,
                                env.config.channels.find((c) => c.id === el.dataset.edit),
                            );
                            renderChannels();
                        });
                    for (const el of $$('[data-remove]', dialog))
                        el.onclick = run(async () => {
                            env.config.channels = env.config.channels.filter((c) => c.id !== el.dataset.remove);
                            await env.saveConfig();
                            renderChannels();
                        });
                    for (const el of $$('[data-models]', dialog))
                        el.onclick = run(async () => {
                            const models = await rpc('ai.models', { channelId: el.dataset.models });
                            await modal(
                                '可用模型',
                                '<pre class="diff">' + esc(models.join('\n') || '未返回模型列表') + '</pre>',
                                { submit: null },
                            );
                        });
                };
                renderChannels();
                $('[data-add-channel]', dialog).onclick = run(async () => {
                    await channelEditor(env);
                    renderChannels();
                });
                $('[data-export]', dialog).onclick = () => {
                    const v = clone(env.config);
                    delete v.backups;
                    download('pww-settings.json', { schema: 'pww-settings', version: 1, config: v });
                };
                $('[data-import]', dialog).onclick = run(async () => {
                    const f = await pickFile('.json');
                    if (!f) return;
                    const v = JSON.parse(await f.text());
                    if (v.schema !== 'pww-settings' || v.version !== 1) throw Error('不是工作台设置文件');
                    env.config = { ...v.config, version: 1, backups: env.config.backups || [] };
                    await env.saveConfig();
                    notify('已导入设置');
                    close();
                });
            },
        },
    );
}
