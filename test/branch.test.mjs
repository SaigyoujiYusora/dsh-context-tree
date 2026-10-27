import test from 'node:test';
import assert from 'node:assert/strict';
import { Session,appendPluginRecord,foldSurface,deriveEventMessage } from '@deepseek-ai/dsh-session';
import { planBranch,editorProjections,LEGACY_EDIT_RECORD,EDIT_RECORD,BRANCH_RECORD,displayMessages } from '../lib/branch-core.js';
import { buildBranchNavigation } from '../lib/navigation.js';
import { turnUserSeq } from '../src/tree.js';
const projections=editorProjections();
function user(id,text){return{id,role:'user',source:{kind:'user'},content:[{type:'text',text}]};}
function answer(id,text){return{id,role:'assistant',source:{kind:'model',provider:'test',model:'fixture'},content:[{type:'text',text}]};}
function fixture(){
 const s=Session.create('session-source',undefined,undefined,0,projections);
 for(let t=1;t<=3;t++){
  s.append('turn/start',{turn:t});
  s.append('user/message',user('u'+t,'Q'+t),{surfaceOp:'append'});
  s.append('step/start',{turn:t,step:1});
  s.append('assistant/message',{turn:t,step:1,message:answer('a'+t,'A'+t),stream:[]},{surfaceOp:'append'});
  s.append('step/end',{turn:t,step:1});
  s.append('turn/end',{turn:t,reason:{kind:'completed'}});
 }
 return s;
}
function child(plan,id='session-child'){
 return Session.create(id,plan.seed,{version:4,id,createdAt:1,isSeeded:true,parentSession:'session-source'},plan.prefixLength,projections);
}
const texts=s=>s.deriveMessages().flatMap(m=>m.content.filter(b=>b.type==='text').map(b=>b.text));

test('swipe middle floor inherits only earlier rounds and preserves entire source',()=>{
 const s=fixture(),before=JSON.stringify(s.snapshotEvents());
 const p=planBranch(s.snapshotEvents(),{turn:2,action:'regenerate'},projections);
 assert.deepEqual(texts(child(p)),['Q1','A1']);
 assert.equal(p.prompts[0].content[0].text,'Q2');
 assert.equal(JSON.stringify(s.snapshotEvents()),before);
 assert.deepEqual(texts(s),['Q1','A1','Q2','A2','Q3','A3']);
});
test('first floor can be swiped with an empty inherited context',()=>{
 const p=planBranch(fixture().snapshotEvents(),{turn:1,action:'regenerate'},projections);
 assert.equal(p.prefixLength,0);assert.deepEqual(texts(child(p)),[]);
 assert.equal(p.prompts[0].content[0].text,'Q1');
});
test('editing prompt changes the new attempt only',()=>{
 const s=fixture();const p=planBranch(s.snapshotEvents(),{turn:2,action:'edit-user',text:'Q2 revised'},projections);
 assert.deepEqual(texts(child(p)),['Q1','A1']);
 assert.equal(p.prompts[0].content[0].text,'Q2 revised');
 assert.ok(texts(s).includes('Q2'));
});

test('editing the opening prompt excludes same-turn steering and its late edits',()=>{
 const s=Session.create('session-steering',undefined,undefined,0,projections);
 s.append('turn/start',{turn:1});
 s.append('user/message',user('past','earlier context'),{surfaceOp:'append'});
 s.append('turn/end',{turn:1,reason:{kind:'completed'}});
 s.append('turn/start',{turn:2});
 const opening=s.append('user/message',{...user('opening','original prompt'),content:[{type:'text',text:'original prompt'},{type:'image',url:'https://example.invalid/fixture.png'}]},{surfaceOp:'append'});
 s.append('step/start',{turn:2,step:1});
 s.append('assistant/message',{turn:2,step:1,message:answer('old-work','old work'),stream:[]},{surfaceOp:'append'});
 s.append('step/end',{turn:2,step:1});
 const steering=s.append('user/message',user('steer1','later steering one'),{surfaceOp:'append'});
 s.append('user/message',user('steer2','later steering two'),{surfaceOp:'append'});
 s.append('turn/end',{turn:2,reason:{kind:'completed'}});
 s.append('user/message',{...user('later-edit','edited later steering'),source:{kind:'user',editedBy:'dsh-edit-turn'}},{surfaceOp:{op:'replace',startSeq:steering.seq,endSeq:steering.seq},sourceEventSeqs:[steering.seq]});
 const replacement=s.append('user/message',{...user('opening-edit','previously edited prompt'),source:{kind:'user',editedBy:'dsh-edit-turn'},content:[{type:'text',text:'previously edited prompt'},{type:'image',url:'https://example.invalid/fixture.png'}]},{surfaceOp:{op:'replace',startSeq:opening.seq,endSeq:opening.seq},sourceEventSeqs:[opening.seq]});
 const before=JSON.stringify(s.snapshotEvents());
 for(const messageSeq of [undefined,opening.seq,replacement.seq]){
  const p=planBranch(s.snapshotEvents(),{turn:2,action:'edit-user',messageSeq,text:'revised prompt'},projections);
  assert.deepEqual(texts(child(p)),['earlier context']);
  assert.equal(p.prompts.length,1);
  assert.deepEqual(p.prompts[0].content,[{type:'text',text:'revised prompt'},{type:'image',url:'https://example.invalid/fixture.png'}]);
  assert.ok(!JSON.stringify(p.seed).includes('later steering'));
 }
 assert.throws(()=>planBranch(s.snapshotEvents(),{turn:2,action:'edit-user',messageSeq:steering.seq,text:'wrong target'},projections),error=>error.code==='prompt-target');
 assert.equal(JSON.stringify(s.snapshotEvents()),before);
 const snapshot={chat:{locations:{getTurn:()=>['opening','steering']},nodes:new Map([
  ['opening',{kind:'user',location:{kind:'turn',turn:{turn:2}},data:{seq:replacement.seq}}],
  ['steering',{kind:'user',location:{kind:'step',turn:{turn:2}},data:{seq:steering.seq}}],
 ])}};
 assert.equal(turnUserSeq(snapshot,2),replacement.seq);
 const navigation=buildBranchNavigation(new Map([[s.id,{header:s.header,events:s.snapshotEvents(),messages:displayMessages(s.snapshotEvents())}]]),s.id);
 assert.equal(navigation.tree.children[0].children[0].messageSeqs[s.id],opening.seq);
});
test('editing an answer creates a closed child through that floor, excludes old tail',()=>{
 const s=fixture();const p=planBranch(s.snapshotEvents(),{turn:2,action:'edit-assistant',text:'A2 revised'},projections);
 const c=child(p);assert.deepEqual(texts(c),['Q1','A1','Q2','A2 revised']);
 assert.ok(texts(s).includes('A2'));assert.equal(p.mode,'seed-only');
 const restored=Session.create(c.id,c.snapshotEvents(),c.header,c.inheritedEventCount,projections);
 assert.deepEqual(texts(restored),texts(c));
});
test('late earlier user edits survive a historical cut and chain correctly',()=>{
 const s=fixture();const first=s.snapshotEvents().find(e=>e.type==='user/message');
 const a=s.append('user/message',{...user('edit1','Q1 revised'),source:{kind:'user',editedBy:'dsh-edit-turn'}},{surfaceOp:{op:'replace',startSeq:first.seq,endSeq:first.seq},sourceEventSeqs:[first.seq]});
 const b=s.append('user/message',{...user('edit2','Q1 twice'),source:{kind:'user',editedBy:'dsh-edit-turn'}},{surfaceOp:{op:'replace',startSeq:a.seq,endSeq:a.seq},sourceEventSeqs:[a.seq]});
 const p=planBranch(s.snapshotEvents(),{turn:2,action:'regenerate'},projections);
 assert.deepEqual(texts(child(p)),['Q1 twice','A1']);
 assert.ok(b.seq>=p.prefixLength);
});
test('late patch containing past and future answers inherits only past targets',()=>{
 const s=fixture();const answers=s.snapshotEvents().filter(e=>e.type==='assistant/message');
 appendPluginRecord(s,LEGACY_EDIT_RECORD,{version:1,targets:[{seq:answers[0].seq,blockIndex:0,kind:'text',text:'past edit'},{seq:answers[2].seq,blockIndex:0,kind:'text',text:'future secret'}]});
 const p=planBranch(s.snapshotEvents(),{turn:2,action:'regenerate'},projections);
 assert.deepEqual(texts(child(p)),['Q1','past edit']);
 assert.equal(p.seed.some(e=>JSON.stringify(e).includes('future secret')),false);
});
test('later compaction summary cannot leak old future into a new attempt',()=>{
 const s=fixture();const nodes=s.surface.nodes;
 s.append('developer/message',{turn:3,step:1,message:{id:'summary',role:'developer',source:{kind:'compaction'},content:[{type:'text',text:'SUMMARY INCLUDING FUTURE Q3'}]}},{surfaceOp:{op:'replace',startSeq:nodes[0],endSeq:nodes.at(-1)},sourceEventSeqs:nodes});
 const p=planBranch(s.snapshotEvents(),{turn:2,action:'regenerate'},projections);
 assert.deepEqual(texts(child(p)),['Q1','A1']);
 assert.ok(!JSON.stringify(p.seed).includes('SUMMARY INCLUDING FUTURE'));
});
test('future-only prompt edit is excluded',()=>{
 const s=fixture();const e=s.snapshotEvents().find(e=>e.type==='user/message'&&e.data.id==='u3');
 s.append('user/message',{...user('editfuture','PRIVATE FUTURE'),source:{kind:'user',editedBy:'dsh-edit-turn'}},{surfaceOp:{op:'replace',startSeq:e.seq,endSeq:e.seq},sourceEventSeqs:[e.seq]});
 const p=planBranch(s.snapshotEvents(),{turn:2,action:'regenerate'},projections);
 assert.deepEqual(texts(child(p)),['Q1','A1']);
});
test('swipe respects late edits to the target prompt',()=>{
 const s=fixture();const e=s.snapshotEvents().find(e=>e.type==='user/message'&&e.data.id==='u2');
 s.append('user/message',{...user('editedtarget','Q2 latest'),source:{kind:'user',editedBy:'dsh-edit-turn'}},{surfaceOp:{op:'replace',startSeq:e.seq,endSeq:e.seq},sourceEventSeqs:[e.seq]});
 const p=planBranch(s.snapshotEvents(),{turn:2,action:'regenerate'},projections);
 assert.equal(p.prompts[0].content[0].text,'Q2 latest');
 assert.deepEqual(texts(child(p)),['Q1','A1']);
});
test('tree preserves source and two attempts at the same floor with nested navigation',()=>{
 const source=fixture(); const sources=new Map([['session-source',{header:source.header,events:source.snapshotEvents(),messages:displayMessages(source.snapshotEvents())}]]);
 for(let i=1;i<=2;i++){
  const p=planBranch(source.snapshotEvents(),{turn:2,action:'edit-assistant',text:'variant '+i},projections);
  const c=child(p,'session-v'+i);
  sources.set(c.id,{header:c.header,events:c.snapshotEvents(),inheritedEventCount:c.inheritedEventCount,branch:{parentId:source.id,turn:2,role:'assistant',action:'edit-assistant'},messages:displayMessages(c.snapshotEvents())});
 }
 const nav=buildBranchNavigation(sources,'session-v2');
 assert.deepEqual(nav.assistant[2].ids,['session-source','session-v1','session-v2']);
 assert.equal(nav.assistant[2].index,2);assert.equal(nav.tree.sessionIds.length,3);
 assert.match(JSON.stringify(nav.tree),/A3/);assert.match(JSON.stringify(nav.tree),/variant 1/);assert.match(JSON.stringify(nav.tree),/variant 2/);
});

test('tree shared nodes distinguish attachments even when visible text is equal',()=>{
 const sources=new Map([
  ['session-a',{header:{id:'session-a',createdAt:1},events:[],messages:[{role:'user',turn:1,text:'same',nonText:true,contentKey:'old-image'}]}],
  ['session-b',{header:{id:'session-b',parentSession:'session-a',createdAt:2},events:[],branch:{parentId:'session-a',turn:2,role:'assistant',action:'regenerate'},messages:[{role:'user',turn:1,text:'same',nonText:true,contentKey:'new-image'}]}],
 ]);
 assert.equal(buildBranchNavigation(sources,'session-b').tree.children.length,2);
});
test('a fork at an earlier floor does not inherit unrelated later version groups',()=>{
 const source=fixture();const base={header:source.header,events:source.snapshotEvents(),messages:displayMessages(source.snapshotEvents())};
 const sources=new Map([['session-source',base]]);
 for(const [id,turn]of [['session-b',2],['session-c',1]]){
  const p=planBranch(source.snapshotEvents(),{turn,action:'edit-assistant',text:id},projections);const c=child(p,id);
  sources.set(id,{header:c.header,events:c.snapshotEvents(),branch:{parentId:source.id,turn,role:'assistant',action:'edit-assistant'},messages:displayMessages(c.snapshotEvents())});
 }
 assert.equal(buildBranchNavigation(sources,'session-c').assistant[2],undefined);
 assert.ok(buildBranchNavigation(sources,'session-c').assistant[1]);
});
test('compacted historical floors remain available in the tree',()=>{
 const s=fixture();const nodes=s.surface.nodes;
 s.append('developer/message',{turn:3,step:1,message:{id:'summary',role:'developer',source:{kind:'compaction'},content:[{type:'text',text:'summary'}]}},{surfaceOp:{op:'replace',startSeq:nodes[0],endSeq:nodes.at(-1)},sourceEventSeqs:nodes});
 assert.deepEqual(displayMessages(s.snapshotEvents()).map(m=>m.text),['Q1','A1','Q2','A2','Q3','A3']);
});

test('intermediate tool-step narration is not exposed as the final-answer editor',()=>{
 const s=Session.create('session-steps');
 s.append('turn/start',{turn:1});s.append('user/message',user('q','Q'),{surfaceOp:'append'});
 for(let step=1;step<=2;step++){
  s.append('step/start',{turn:1,step});
  s.append('assistant/message',{turn:1,step,message:answer('a'+step,step===1?'intermediate narration':'final answer'),stream:[]},{surfaceOp:'append'});
  s.append('step/end',{turn:1,step});
 }
 s.append('turn/end',{turn:1,reason:{kind:'completed'}});
 assert.deepEqual(displayMessages(s.snapshotEvents()).map(m=>m.text),['Q','final answer']);
 assert.equal(s.snapshotEvents().filter(e=>e.type==='assistant/message').length,2);
});
