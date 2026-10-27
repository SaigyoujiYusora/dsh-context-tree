import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@deepseek-ai/dsh-session';
import { createBranch } from '../lib/index.js';
import { editorProjections, BRANCH_RECORD } from '../lib/branch-core.js';
const sourceId='session-11111111-1111-4111-8111-111111111111';
const operationId='22222222-2222-4222-8222-222222222222';
function fixture({steering=false}={}){
 const projections=editorProjections();
 const source=Session.create(sourceId,undefined,undefined,0,projections);
 for(const [type,data]of [['permission/preset',{preset:'danger-full-access'}],['sandbox/mode',{mode:'danger-full-access'}],['approval/policy',{policy:'never'}]])source.append(type,data);
 for(let turn=1;turn<=3;turn++){
  source.append('turn/start',{turn});
  source.append('user/message',{id:'u'+turn,role:'user',source:{kind:'user'},content:[{type:'text',text:'question '+turn}]},{surfaceOp:'append'});
  source.append('step/start',{turn,step:1});
  source.append('assistant/message',{turn,step:1,message:{id:'a'+turn,role:'assistant',source:{kind:'model',provider:'test',model:'test'},content:[{type:'text',text:'answer '+turn}]},stream:[]},{surfaceOp:'append'});
  source.append('step/end',{turn,step:1});
  if(steering&&turn===2){
   for(const id of ['steer1','steer2'])source.append('user/message',{id,role:'user',source:{kind:'user'},content:[{type:'text',text:id}]},{surfaceOp:'append'});
  }
  source.append('turn/end',{turn,reason:{kind:'completed'}});
 }
 for(const [type,data]of [['permission/preset',{preset:'read-only'}],['sandbox/mode',{mode:'read-only'}],['approval/policy',{policy:'ask'}]])source.append(type,data);
 const sessions=new Map([[sourceId,source]]);const agents=new Map();const sent=[];const counts={created:0,cleared:0,flushed:0,disposed:0};
 let failure=()=>false;let queueFailure=false;
 const ctx={
  get(){return undefined;},
  sessions:{messageProjections:projections,get:id=>sessions.get(id),flush:async()=>{counts.flushed++;return !failure(counts.flushed);}},
  sessionQuery:{observeSession:async id=>{const s=sessions.get(id);if(!s)throw Object.assign(new Error('missing'),{code:'SESSION_QUERY_SESSION_NOT_FOUND'});return{header:s.header,events:s.snapshotEvents(),inheritedEventCount:s.inheritedEventCount,[Symbol.dispose](){counts.disposed++;}};}},
  workspaceRegistry:{list:()=>[]},
  agents:{get:id=>agents.get(id),async create(options){
   counts.created++;
   const s=Session.create(options.sessionId,options.seed,{version:4,id:options.sessionId,createdAt:Date.now(),...options.meta},options.inheritedEventCount,projections);
   const agent={id:s.id,session:s,ctx:{},inbox:{clear(){counts.cleared++;}},followup(m){if(queueFailure)throw Error('queue rejected');sent.push({id:s.id,message:m});},send(m){sent.push({id:s.id,message:m});}};
   await options.setup({},agent);sessions.set(s.id,s);agents.set(s.id,agent);return{agent,dispose:async()=>{}};
  }},
 };
 return{ctx,source,sessions,sent,counts,setFailure:fn=>{failure=fn;},rejectQueue:()=>{queueFailure=true;}};
}
const payload={sessionId:sourceId,operationId,action:'regenerate',turn:2,modelSelection:{provider:'test',model:'test',reasoningEffort:'high'}};
test('editing a prompt queues only that prompt, never its later steering',async()=>{
 const f=fixture({steering:true});const before=JSON.stringify(f.source.snapshotEvents());
 const messageSeq=f.source.snapshotEvents().find(e=>e.type==='user/message'&&e.data.id==='u2').seq;
 const result=await createBranch(f.ctx,{...payload,action:'edit-user',messageSeq,text:'revised question'});
 assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].message.content[0].text,'revised question');
 assert.deepEqual(f.sessions.get(result.sessionId).deriveMessages().map(m=>m.content[0].text),['question 1','answer 1']);
 assert.equal(JSON.stringify(f.source.snapshotEvents()),before);
 await assert.rejects(createBranch(f.ctx,{...payload,action:'edit-user',messageSeq:messageSeq+1,text:'revised question'}),/其他分支/);
});
test('host preserves source bytes, current full permission state and selected model',async()=>{
 const f=fixture();const before=JSON.stringify(f.source.snapshotEvents());
 const result=await createBranch(f.ctx,payload);const child=f.sessions.get(result.sessionId);
 assert.equal(JSON.stringify(f.source.snapshotEvents()),before);
 assert.equal(child.header.parentSession,sourceId);assert.equal(child.header.isSeeded,true);
 const log=child.snapshotEvents();assert.equal(log.findLast(e=>e.type==='sandbox/mode').data.mode,'read-only');assert.equal(log.findLast(e=>e.type==='approval/policy').data.policy,'ask');
 assert.equal(log.findLast(e=>e.type==='permission/preset').data.preset,'read-only');
 assert.deepEqual(log.findLast(e=>e.type==='model/selection').data,payload.modelSelection);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].message.content[0].text,'question 2');
 assert.ok(!JSON.stringify(child.deriveMessages()).includes('question 3'));
 assert.equal(f.counts.cleared,1);
});
test('same operation retries reuse one durable branch and enqueue once',async()=>{
 const f=fixture();const a=await createBranch(f.ctx,payload);const b=await createBranch(f.ctx,payload);
 assert.equal(a.sessionId,b.sessionId);assert.equal(b.reused,true);assert.equal(f.counts.created,1);assert.equal(f.sent.length,1);
 await assert.rejects(createBranch(f.ctx,{...payload,text:'different'}),/其他分支/);
});
test('reusing a live ready marker still requires durability',async()=>{
 const f=fixture();f.setFailure(n=>n>=3);
 await assert.rejects(createBranch(f.ctx,payload),/保存到磁盘/);
 assert.equal(f.sessions.get('session-'+operationId).snapshotEvents().findLast(e=>e.type===BRANCH_RECORD).data.phase,'ready');
 await assert.rejects(createBranch(f.ctx,payload),/保存到磁盘/);
 assert.equal(f.sent.length,1);
});
test('queue failure does not mark a half-finished attempt ready',async()=>{
 const f=fixture();f.rejectQueue();await assert.rejects(createBranch(f.ctx,payload),/queue rejected/);
 const child=f.sessions.get('session-'+operationId);
 assert.equal(child.snapshotEvents().findLast(e=>e.type===BRANCH_RECORD).data.phase,'prepared');
 await assert.rejects(createBranch(f.ctx,payload),/上次操作未完成/);
 assert.equal(f.counts.created,1);
});
test('two clicks at the same floor with distinct operations remain independent',async()=>{
 const f=fixture();const a=await createBranch(f.ctx,payload);const b=await createBranch(f.ctx,{...payload,operationId:'33333333-3333-4333-8333-333333333333'});
 assert.notEqual(a.sessionId,b.sessionId);assert.equal(f.counts.created,2);assert.equal(f.sent.length,2);
});
