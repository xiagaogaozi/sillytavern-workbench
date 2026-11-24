// Only explicitly editable text fields participate; never rewrite identifiers, roles, keys or DDL.
import {clone,entries,commit,fingerprint} from './core.js';
import {audit} from './database-model.js';
import {isPromptKind,protectGroups,formatAnswer,fixedSlot} from './prompt-model.js';
const escRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const expand=value=>String(value??'').replace(/\\n/g,'\n').replace(/\\t/g,'\t');
function readPath(raw,path){return path.reduce((x,key)=>x[key],raw);}
function writePath(raw,path,value){const holder=path.slice(0,-1).reduce((x,key)=>x[key],raw);holder[path.at(-1)]=value;}
export function planDatabaseReplacement(d,options={}) {
    const search=options.extended?expand(options.search):String(options.search??'');
    if(!search)throw Error('请输入非空查找内容');
    const regex=new RegExp(options.regex?search:escRegex(search),'g'+(options.caseSensitive?'':'i'));
    const replacement=options.extended?expand(options.replace):String(options.replace??'');
    const selected=new Set(options.scope==='selected'?d.selected:[]);
    if(options.scope==='selected'&&!selected.size)throw Error('请先选择要处理的条目');
    const changes=[],skipped=[];let matches=0;
    const inspect=(path,name,label,segment,segmentField)=>{
        const before=readPath(d.raw,path);if(typeof before!=='string')return;
        regex.lastIndex=0;const hits=[...before.matchAll(regex)].length;if(!hits)return;
        matches+=hits;
        const after=options.regex?before.replace(regex,replacement):before.replace(regex,()=>replacement);
        if(before===after)return;
        if(segment){
            if(segmentField==='content'&&(formatAnswer(segment)||fixedSlot(segment))){skipped.push({name,label,hits,reason:'原生格式回答或固定插槽'});return;}
            if(isPromptKind(d.kind)){
                try{protectGroups({unit:[segment]},{unit:[{...segment,[segmentField]:after}]});}
                catch(error){skipped.push({name,label,hits,reason:error.message});return;}
            }
        }
        changes.push({path,name,label,hits,before,after});
    };
    for(const entry of entries(d)){
        if(options.scope==='selected'&&!selected.has(entry.id))continue;
        const e=entry.raw;
        const path=d.kind==='plot'?['plotTasks',d.raw.plotTasks.indexOf(e)]:d.kind==='contentReplace'?['promptGroup',d.raw.promptGroup.indexOf(e)]:isPromptKind(d.kind)?['groups',entry.group,entry.index]:[entry.id];
        if(options.inName && typeof e.name==='string')inspect([...path,'name'],entry.name,'名称');
        if(options.content!==false){
            if(isPromptKind(d.kind)||d.kind==='contentReplace'){
                inspect([...path,'content'],entry.name,'正文',e,'content');
                if(typeof e.snapshotTemplate==='string')inspect([...path,'snapshotTemplate'],entry.name,'快照模板',e,'snapshotTemplate');
            }else if(d.kind==='plot'){
                for(const [i,p] of e.promptGroup.entries())inspect([...path,'promptGroup',i,'content'],entry.name,'提示词段 '+(i+1),p,'content');
                if(typeof e.finalDirectiveTemplate==='string')inspect([...path,'finalDirectiveTemplate'],entry.name,'最终指令');
            }else if(d.kind==='tableTemplate'){
                for(const key of ['note','initNode','insertNode','updateNode','deleteNode'])if(typeof e.sourceData?.[key]==='string')inspect([...path,'sourceData',key],entry.name,'填写规则 · '+key);
                for(const key of ['injectionTemplate','extraIndexInjectionTemplate'])if(typeof e.exportConfig?.[key]==='string')inspect([...path,'exportConfig',key],entry.name,'注入模板 · '+key);
            }
        }
        if(options.rules&&d.kind==='plot')for(const key of ['description','triggerWhen','extractTags','extractInjectTags'])if(typeof e[key]==='string')inspect([...path,key],entry.name,'说明/规则 · '+key);
        if(options.rows&&d.kind==='tableTemplate')for(const key of ['content','seedRows'])for(const [row,cells] of (e[key]||[]).entries()){
            if(key==='content'&&row===0)continue;
            if(Array.isArray(cells))for(let col=1;col<cells.length;col++)if(typeof cells[col]==='string')inspect([...path,key,row,col],entry.name,`${key} 初始数据 ${row+1}行${col+1}列`);
        }
    }
    if(d.kind==='plot'&&options.scope!=='selected'&&options.content!==false&&typeof d.raw.finalSystemDirective==='string')inspect(['finalSystemDirective'],'文档','文档级最终指令');
    return {kind:d.kind,base:fingerprint(d.raw),changes,skipped,matches};
}
export function applyDatabaseReplacement(d,plan,indices=plan.changes.map((_,i)=>i)){
    if(d.kind!==plan.kind||fingerprint(d.raw)!==plan.base)throw Error('预览后草稿发生变化，请重新查找');
    const accepted=[...new Set(indices)].map(i=>plan.changes[i]);if(accepted.some(x=>!x))throw Error('无效的替换选择');
    if(!accepted.length)throw Error('没有勾选要替换的字段');
    const previous=isPromptKind(d.kind)?clone(d.raw.groups):null;
    commit(d,'全局查找替换',()=>{
        for(const change of accepted)writePath(d.raw,change.path,change.after);
        if(previous)protectGroups(previous,d.raw.groups);
        const issues=audit(d);if(issues.length)throw Error(issues.join('；'));
    });
    return accepted.length;
}
