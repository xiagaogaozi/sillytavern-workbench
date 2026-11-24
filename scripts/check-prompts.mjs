import assert from 'node:assert/strict';
import * as c from '../src/core.js';
import * as p from '../src/prompt-model.js';
globalThis.location={hash:'#check',origin:'http://test.invalid'};globalThis.window={addEventListener(){}};
const {editingContext}=await import('../src/ai.js');
for(const kind of Object.keys(p.PROMPT_KINDS)){
 const toggles=['promptContinuation','promptSimulation'].includes(kind);
 const message=(content,fixed=false)=>({role:'user',content,deletable:!fixed,...(toggles?{enabled:true,pinned:fixed}:{})});
 const raw={version:1,feature:kind,groups:{a:[message('固定',true),message('正文')],b:[message('同正文')]},vendor:{preserve:true}};
 const d=c.createDraft(kind,raw,'原件',true),to=c.createDraft(kind,raw,'副本',true),original=c.clone(d.raw),ids=c.entries(d).map(e=>e.id);
 assert.throws(()=>c.commit(d,'禁止删除',()=>c.removeEntries(d,[ids[0]])),/保留/);
 c.commit(d,'编辑',()=>p.update(d,ids[1],{content:'新正文'}));assert.equal(d.raw.groups.a[1].content,'新正文');c.undo(d);assert.deepEqual(d.raw,original);
 c.commit(to,'整批复制',()=>c.transfer(d,to,[ids[1],ids[2]]));assert.equal(to.raw.groups.a.length,3);assert.equal(to.raw.groups.b.length,2);assert.deepEqual(d.raw,original);c.undo(to);assert.deepEqual(to.raw,original);
 assert.throws(()=>c.commit(to,'跨组',()=>c.transfer(d,to,[ids[1]],c.entries(to).find(e=>e.group==='b').id)),/同名/);
 const ops=[{type:'update',id:ids[1],fields:{content:'AI内容'}}];assert.equal(c.validateOperations(d,ops,[ids[1]]).length,1);
 assert.throws(()=>c.validateOperations(d,[{type:'update',id:ids[1],fields:{apiPreset:'x'}}],[ids[1]]),/不允许/);
 assert.throws(()=>c.validateOperations(d,[{type:'delete',id:ids[0]}],[ids[0]]),/保留/);
 d.selected=[ids[1]];const context=editingContext(d);assert.equal(context.selection.length,1);assert.equal(context.outline[0].group,'a');assert.equal(context.references.other,undefined);
 if(!toggles)assert.throws(()=>c.setEnabled(d,ids[1],false),/开关/);
 assert.equal(d.raw.vendor.preserve,true);
}
console.log('PASS: seven prompt kinds; native group/protected segment guards; scoped AI; copy/undo; original preservation.');
