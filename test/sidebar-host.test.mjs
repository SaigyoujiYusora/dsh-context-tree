import test from 'node:test';
import assert from 'node:assert/strict';
import { sidebarFamilies } from '../lib/index.js';
import { BRANCH_RECORD } from '../lib/branch-core.js';

test('sidebar index recognizes only this plugin records, checks direct parent and caches reads',async()=>{
  const root='session-root';
  const rows=['branch','native','subagent','wrong','inherited'].map(name=>({header:{id:'session-'+name,parentSession:root,...name==='subagent'?{origin:'subagent'}:{}}}));
  const counts={read:0,dispose:0};
  const ctx={sessions:{},agents:{get:()=>undefined},sessionQuery:{
    listSessions:async()=>rows,
    observeSession:async id=>{counts.read++;return{
      header:rows.find(r=>r.header.id===id).header,
      events:id==='session-native'?[]:[{type:BRANCH_RECORD,data:{sessionId:id==='session-inherited'?'session-ancestor':id,parentId:id==='session-wrong'?'session-else':root}}],
      [Symbol.dispose](){counts.dispose++;},
    };},
  }};
  assert.deepEqual(await sidebarFamilies(ctx),{parents:{'session-branch':root}});
  assert.equal(counts.read,4);
  assert.equal(counts.dispose,4);
  await sidebarFamilies(ctx);
  assert.equal(counts.read,4);
});
