// Prompt libraries are grouped native messages, never runtime settings or chat snapshots.
const clone = x => x === undefined ? x : JSON.parse(JSON.stringify(x));
const uuid = () => crypto.randomUUID();
export const PROMPT_KINDS = {promptFill:'填表提示词',promptContinuation:'智能续写',promptSimulation:'格林推演',promptKeyword:'向量检索关键词',promptSummary:'远记忆总结',promptAssistant:'模板助手',promptAgent:'世界书 Agent'};
export const isPromptKind = kind => Object.hasOwn(PROMPT_KINDS,kind);
export const GROUP_LABELS = {'world-director':'世界导演','undercurrent-analyst':'暗流分析','dramatis-keeper':'角色维护','causality-reviewer':'因果审阅','guidance-composer':'指导编写','lore-researcher':'设定研究',ordinary:'普通填表',strictJson:'严格 JSON',strictSql:'SQL 严格 JSON',outline:'大纲',main:'主 Agent',arcArchitect:'总纲架构',maintainer:'维护 Agent',mainlinePlanner:'主线规划',beatPlanner:'节拍规划',finalReviewer:'最终审阅',webResearcher:'百科检索',instructionComposer:'指令编排',keyword:'检索关键词',summary:'远记忆总结',assistant:'模板助手',decision:'决策',skillify:'技能化'};
export const groupLabel = key => GROUP_LABELS[key] || key;
export const formatAnswer = p => p.role==='assistant' && p.content.startsWith('【具体格式输出】\n');
export const fixedSlot = p => /^\$(HISTORY_ANCHOR|RUNTIME_SNAPSHOT)$/.test(p.content.trim());
export const protectedSegment = p => Boolean(formatAnswer(p) || p.pinned || p.deletable === false || p.mainSlot || p.isMain || p.isMain2 || p.role === 'history' || /^\$(HISTORY_ANCHOR|RUNTIME_SNAPSHOT)$/.test(p.content));
const marker = p => p.mainSlot || (p.isMain?'A':p.isMain2?'B':'') || (p.content.match(/\$(?:HISTORY_ANCHOR|RUNTIME_SNAPSHOT)|<!--\s*ACU[^>]*-->|<WORLD_SIMULATION_ENGINE_SEAM:[A-Z_]+>/)?.[0] || '');
export function protectGroups(before, after) {
    if (Object.keys(before).join('|') !== Object.keys(after).join('|')) throw Error('不能增删或重命名原生提示词分组');
    for (const key of Object.keys(before)) {
        const a=before[key].filter(protectedSegment), b=after[key].filter(protectedSegment);
        if (a.length !== b.length) throw Error(groupLabel(key)+'：原生保留段不能新增、删除或复制');
        a.forEach((p,i) => { const q=b[i];
            if((formatAnswer(p)||fixedSlot(p)) && p.content!==q.content)throw Error('原生格式回答和固定插槽正文不可修改');
            if ((p.pinned||fixedSlot(p)||formatAnswer(p))&&p.role!==q.role || Boolean(p.pinned)!==Boolean(q.pinned) || (p.deletable===false)!==(q.deletable===false) || marker(p)!==marker(q)) throw Error(groupLabel(key)+'：原生保留段的角色、顺序和标记不能改变');
            if (p.pinned && p.enabled !== q.enabled) throw Error('固定引擎段的开关不能改变');
        });
    }
}
export function assertBundle(kind, raw) {
    if (!raw || raw.version!==1 || raw.feature!==kind || !raw.groups || Array.isArray(raw.groups) || typeof raw.groups!=='object') throw Error('提示词文档类型或分组格式不符');
    for (const [key,segments] of Object.entries(raw.groups)) {
        if(!Array.isArray(segments)) throw Error(groupLabel(key)+'必须是消息段数组');
        for(const p of segments) if(!p || typeof p.content!=='string' || !['system','user','assistant','history'].includes(String(p.role).toLowerCase())) throw Error('消息段缺少有效角色或正文');
    }
    return raw;
}
export function empty(kind) {return {version:1,feature:kind,groups:{}};}
export function make(kind) {return {role:['promptContinuation','promptSimulation'].includes(kind)?'user':'USER',content:'新提示词',deletable:true,...(['promptContinuation','promptSimulation'].includes(kind)?{enabled:true,pinned:false}:{})};}
export function ensureIds(d) {
    d.unitIds ||= {};
    for(const [key,segments] of Object.entries(d.raw.groups)) {
        const ids=d.unitIds[key] ||= [];
        while(ids.length<segments.length)ids.push(uuid());ids.length=segments.length;
    }
}
export function units(d) {
    ensureIds(d);return Object.entries(d.raw.groups).flatMap(([group,segments])=>segments.map((raw,index)=>({id:d.unitIds[group][index],group,kind:d.kind,raw,name:groupLabel(group)+' · '+(index+1)+' · '+(raw.mainSlot||raw.role),role:raw.role,content:raw.snapshotTemplate===undefined?raw.content:raw.content+'\n[快照模板]\n'+raw.snapshotTemplate,enabled:raw.enabled!==false,contentReadOnly:formatAnswer(raw)||fixedSlot(raw),toggleable:['promptContinuation','promptSimulation'].includes(d.kind)&&!raw.pinned&&!fixedSlot(raw)&&!formatAnswer(raw),nativeProtected:protectedSegment(raw),index,groupLabel:groupLabel(group)})));
}
export function update(d,id,fields) {
    const e=units(d).find(e=>e.id===id);if(!e)throw Error('消息段不存在');
    if(fields.snapshotTemplate!==undefined&&!/^\$RUNTIME_SNAPSHOT$/.test(e.raw.content.trim()))throw Error('仅快照卡支持快照模板');
    const old=clone(d.raw.groups);Object.assign(e.raw,clone(fields));
    protectGroups(old,d.raw.groups);
}
export function toggle(d,id,value) {const e=units(d).find(e=>e.id===id);if(!e?.toggleable)throw Error('此段没有可编辑的原生开关');update(d,id,{enabled:value});}
export function insert(d,raw,before,group) {
    const all=units(d), target=before?all.find(e=>e.id===before):null;
    group ||= target?.group;
    if(!group || !Array.isArray(d.raw.groups[group]))throw Error('请指定原生目标分组');
    if(target && target.group!==group)throw Error('插入落点不属于目标分组');
    const item=clone(raw||make(d.kind));if(protectedSegment(item))throw Error('不能复制或新增原生保留段');
    const index=target?target.index:d.raw.groups[group].length, id=uuid();d.raw.groups[group].splice(index,0,item);d.unitIds[group].splice(index,0,id);return id;
}
export function remove(d,ids) {const all=units(d);if(all.some(e=>ids.includes(e.id)&&e.nativeProtected))throw Error('不能删除原生保留段');for(const key of Object.keys(d.raw.groups)){const keep=all.filter(e=>e.group===key&&!ids.includes(e.id));d.raw.groups[key]=keep.map(e=>e.raw);d.unitIds[key]=keep.map(e=>e.id);}}
export function order(d,ids) {
    const all=units(d),old=clone(d.raw.groups), arranged=[...ids.map(id=>all.find(e=>e.id===id)).filter(Boolean),...all.filter(e=>!ids.includes(e.id))];
    if(new Set(arranged.map(e=>e.id)).size!==all.length)throw Error('重复排序标识');
    for(const key of Object.keys(d.raw.groups)){const list=arranged.filter(e=>e.group===key),previous=all.filter(e=>e.group===key);if(previous.some((e,i)=>formatAnswer(e.raw)&&list[i]?.id!==e.id))throw Error('原生格式回答不能移动或被跨越');d.raw.groups[key]=list.map(e=>e.raw);d.unitIds[key]=list.map(e=>e.id);}
    protectGroups(old,d.raw.groups);
}
export function copyUnits(from,to,ids,before) {
    if(from.kind!==to.kind)throw Error('只能复制相同功能的提示词');
    const chosen=units(from).filter(e=>ids.includes(e.id)),target=units(to).find(e=>e.id===before);
    for(const e of chosen)if(e.nativeProtected || !to.raw.groups[e.group] || target&&target.group!==e.group)throw Error('只能复制非保留段到同名原生分组；落点需属于该组');
    return chosen.map(e=>({oldId:e.id,newId:insert(to,e.raw,before,e.group)}));
}
export const AI_FIELDS = new Set(['role','content','snapshotTemplate','enabled']);
export function validate(d,ops,allowed) {
    if(!Array.isArray(ops))throw Error('缺少 operations');const all=units(d), scope=new Set(allowed);
    const next={...d,raw:clone(d.raw),unitIds:clone(d.unitIds)};
    for(const op of ops){
        if(!['update','add','delete','reorder'].includes(op?.type))throw Error('未知提案操作');
        const e=all.find(e=>e.id===op.id);
        if(['update','delete'].includes(op.type)&&(!e||!scope.has(e.id)))throw Error('提案超出选中范围');
        if(['update','add'].includes(op.type)){
            if(!op.fields||typeof op.fields!=='object'||Array.isArray(op.fields)||Object.keys(op.fields).some(k=>!AI_FIELDS.has(k)))throw Error('提案包含不允许的字段');
            if(op.fields.enabled!==undefined && (op.type==='add'?!['promptContinuation','promptSimulation'].includes(d.kind):!e.toggleable))throw Error('此段不支持原生开关');
        }
        if(op.type==='add'&&(!op.beforeId||!scope.has(op.beforeId)))throw Error('新增段必须指定所选组内的 beforeId');
        if(op.type==='reorder'&&(!Array.isArray(op.ids)||new Set(op.ids).size!==op.ids.length||op.ids.some(id=>!scope.has(id))))throw Error('排序超出范围');
    }
    apply(next,ops);assertBundle(d.kind,next.raw);return clone(ops);
}
export function apply(d,ops) {for(const op of ops){if(op.type==='update')update(d,op.id,op.fields);else if(op.type==='add')insert(d,{...make(d.kind),...op.fields},op.beforeId);else if(op.type==='delete')remove(d,[op.id]);else {const queue=[...op.ids],set=new Set(queue);order(d,units(d).map(e=>set.has(e.id)?queue.shift():e.id));}}}
