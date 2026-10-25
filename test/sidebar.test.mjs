import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSidebar, projectStatuses } from '../src/sidebar-tree.js';

const row=(id,extra={})=>({id,cwd:'F:/work',title:id,updatedAt:1,retainedBy:{},...extra});
const list=(...rows)=>({ids:rows.map(r=>r.id),byId:Object.fromEntries(rows.map(r=>[r.id,r]))});
test('only plugin branches collapse, including nested branches; shared source remains untouched',()=>{
  const source=list(row('root'),row('a'),row('b',{retainedBy:{mainView:1},updatedAt:9}),row('ordinary-fork'),row('child',{origin:'subagent'}));
  const before=structuredClone(source);
  const value=projectSidebar(source,{a:'root',b:'a'});
  assert.deepEqual(value.list.ids,['root','ordinary-fork','child']);
  assert.equal(value.targets.root,'b');
  assert.equal(value.list.byId.root.retainedBy.mainView,1);
  assert.equal(value.list.byId.root.updatedAt,9);
  assert.deepEqual(source,before);
});
test('remembered selection restores branch; removed/archived branch falls back to root',()=>{
  const source=list(row('root'),row('a'));
  assert.equal(projectSidebar(source,{a:'root'},{root:'a'}).targets.root,'a');
  assert.equal(projectSidebar(source,{a:'root'},{root:'missing'}).targets.root,'root');
  const archived=projectSidebar(source,{a:'root'},{root:'a'},['a']);
  assert.equal(archived.targets.root,undefined);
  assert.deepEqual(archived.list.ids,['root','a']); // Native archived view can still restore the branch.
});
test('missing roots, cycles, archived roots and cross-workspace branches stay reachable',()=>{
  const source=list(row('a'),row('b'),row('other',{cwd:'F:/other'}));
  for(const parents of [{a:'gone'},{a:'b',b:'a'},{other:'a'}]) assert.deepEqual(projectSidebar(source,parents).list.ids,source.ids);
  assert.deepEqual(projectSidebar(source,{b:'a'},{},['a']).list.ids,source.ids);
});
test('root status reflects running branches without modifying shared status map',()=>{
  const source=new Map([['root',{running:false}],['a',{running:true}]]);
  const result=projectStatuses(source,new Map([['root',['root','a']]]));
  assert.equal(result.get('root').running,true);
  assert.equal(source.get('root').running,false);
});
