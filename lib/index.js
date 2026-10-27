import { createHash, randomUUID } from 'node:crypto';
import { appendPluginRecord, foldRequestHeader, Session } from '@deepseek-ai/dsh-session';
import { BRANCH_RECORD, EDIT_RECORD, NAME, BranchInputError, appendEvent, appendRecord, displayMessages, editorProjections, planBranch } from './branch-core.js';
import { buildBranchNavigation } from './navigation.js';
import { installBillionCompatibility } from './billion-compat.js';
import { readSidebarTitles } from './sidebar-titles.js';

export const name=NAME;
export const inject=['connection','webServer','agents','sessions','sessionQuery','workspaceRegistry','sessionController','sessionProjections'];
const pending=new WeakMap();
const sidebarCache=new WeakMap();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validId(id){if(typeof id!=='string'||!/^session-[A-Za-z0-9-]{1,160}$/.test(id))throw new BranchInputError('session','无效的会话标识。');return id;}
function marker(source){return source.events.findLast(e=>e.type===BRANCH_RECORD&&e.data?.sessionId===source.header.id)?.data;}
function signature(payload){return createHash('sha256').update(JSON.stringify([payload.sessionId,payload.turn,payload.action,payload.text??null,payload.modelSelection??null,...payload.messageSeq===undefined?[]:[payload.messageSeq]])).digest('hex');}
async function readSource(ctx,id){
  const observation=await ctx.sessionQuery.observeSession(id);
  try{return {header:observation.header,events:observation.events,inheritedEventCount:observation.inheritedEventCount,projections:observation.projections,agent:ctx.agents.get(id)};}
  finally{observation[Symbol.dispose]();}
}
function assertIdle(source){
  if(source.header.origin==='subagent')throw new BranchInputError('subagent','请在普通对话中创建分支。');
  const lastStart=source.events.findLast(e=>e.type==='turn/start');
  const lastEnd=source.events.findLast(e=>e.type==='turn/end');
  if(lastStart && (!lastEnd||lastEnd.seq<lastStart.seq))throw new BranchInputError('busy','请先等待当前回复结束或停止，再创建分支。');
}
function modelSelection(source,payload){
  const header=foldRequestHeader(source.events);
  const pending=source.projections?.values?.modelSelection?.pending;
  const lastPick=source.events.findLast(e=>e.type==='model/selection');
  const lastHeader=source.events.findLast(e=>e.type==='request/header');
  const chosen=payload.modelSelection??pending??(lastPick&&(!lastHeader||lastPick.seq>lastHeader.seq)?lastPick.data:header?.config);
  if(!chosen||typeof chosen.provider!=='string'||!chosen.provider||typeof chosen.model!=='string'||!chosen.model)throw new BranchInputError('model','请先选择此分支使用的模型。');
  const reasoning=chosen.reasoningEffort;
  return {provider:chosen.provider,model:chosen.model,...typeof reasoning==='string'&&reasoning?{reasoningEffort:reasoning}:{}};
}
async function composition(ctx,source){
  const presets=ctx.get('agentPresets');
  if(!presets)return {};
  const active=source.agent&&presets.composedPreset(source.agent.ctx);
  if(active)return {agentPreset:active,setup:async childCtx=>{presets.composeFrom(childCtx,source.agent.ctx);}};
  const id=source.events.findLast(e=>e.type==='agent-preset/selected')?.data?.agentPreset??source.header.agentPreset;
  const resolved=await presets.resolve(id);
  return {agentPreset:resolved.id,setup:async childCtx=>{await presets.mount(childCtx,resolved.id);}};
}
async function flush(ctx,session){
  if(await ctx.sessions.flush(session)!==true)throw new Error('分支尚未确认保存到磁盘，请保持 DSH 打开。');
}
async function existingBranch(ctx,childId,hash){
  let source;
  try{source=await readSource(ctx,childId);}catch(error){
    // A missing id is expected. Corruption/permission failures must never be treated as absent.
    if(error?.code==='SESSION_QUERY_SESSION_NOT_FOUND')return null;
    throw error;
  }
  const record=marker(source);
  if(!record||record.signature!==hash)throw new BranchInputError('operation-conflict','此操作标识已被其他分支使用。');
  if(record.phase!=='ready')throw Object.assign(new Error('分支已建立但上次操作未完成，请打开该分支检查后继续。'),{branchId:childId});
  const live=ctx.sessions.get(childId);
  if(live)await flush(ctx,live);
  return {sessionId:childId,mode:record.mode,reused:true};
}

export async function createBranch(ctx,payload){
  validId(payload?.sessionId);
  if(!UUID.test(payload?.operationId??''))throw new BranchInputError('operation','缺少有效的操作标识，请重新打开编辑器。');
  const childId=`session-${payload.operationId}`;
  const hash=signature(payload);
  let jobs=pending.get(ctx.sessions);if(!jobs){jobs=new Map();pending.set(ctx.sessions,jobs);}
  const current=jobs.get(childId);
  if(current){if(current.hash!==hash)throw new BranchInputError('operation-conflict','操作内容已改变。');return current.promise;}
  const promise=(async()=>{
    const existing=await existingBranch(ctx,childId,hash);if(existing)return existing;
    const source=await readSource(ctx,payload.sessionId);assertIdle(source);
    const run=async()=>{
      // Maintenance serializes the source Agent. Re-read after acquiring it.
      const snapshot=source.agent?await readSource(ctx,payload.sessionId):source;
      assertIdle(snapshot);
      const projections=ctx.sessions.messageProjections;
      const plan=planBranch(snapshot.events,payload,projections);
      const selection=modelSelection(snapshot,payload);
      const preset=await composition(ctx,snapshot);
      const seed=plan.seed;
      for(const type of ['permission/preset','sandbox/mode','approval/policy']){
        const current=snapshot.events.findLast(e=>e.type===type);
        if(current)appendEvent(seed,type,current.data);
      }
      appendEvent(seed,'model/selection',selection);
      const record={version:1,sessionId:childId,parentId:payload.sessionId,operationId:payload.operationId,signature:hash,turn:payload.turn,action:payload.action,role:payload.action==='edit-user'?'user':'assistant',mode:plan.mode,phase:'prepared',createdAt:Date.now()};
      appendRecord(seed,BRANCH_RECORD,record);
      const header={version:4,id:childId,createdAt:record.createdAt,isSeeded:true,parentSession:payload.sessionId,...snapshot.header.cwd?{cwd:snapshot.header.cwd}:{},...preset.agentPreset?{agentPreset:preset.agentPreset}:{}};
      // Validate the exact candidate before any persistent write or model work.
      Session.create(childId,seed,header,plan.prefixLength,projections);
      const options={...selection};
      const lastHeader=foldRequestHeader(snapshot.events);
      if(lastHeader?.config?.provider===selection.provider&&lastHeader.config.model===selection.model&&lastHeader.config.maxTokens!==undefined&&lastHeader.adapterDefaults?.maxTokens!==true)options.maxTokens=lastHeader.config.maxTokens;
      let child;
      try {
        child=await ctx.agents.create({sessionId:childId,seed,inheritedEventCount:plan.prefixLength,meta:{isSeeded:true,parentSession:payload.sessionId,...header.cwd?{cwd:header.cwd}:{},...preset.agentPreset?{agentPreset:preset.agentPreset}:{}},agentOptions:options,setup:async(childCtx,agent)=>{
          await preset.setup?.(childCtx);
          // Only the unpublished child can contain inherited queued input here.
          agent.inbox.clear();
        }});
        await flush(ctx,child.agent.session);
        const workspace=ctx.workspaceRegistry.list().find(w=>w.sessionIds.includes(payload.sessionId));
        if(workspace)await workspace.attachSession(childId);
        if(plan.mode==='generate'){
          for(const [index,prompt] of plan.prompts.entries()){
            const message={id:randomUUID(),role:'user',content:prompt.content,source:prompt.source};
            if(index===plan.prompts.length-1)child.agent.followup(message);
            else child.agent.send(message,'next-step',false);
          }
          await flush(ctx,child.agent.session);
        }
        appendPluginRecord(child.agent.session,BRANCH_RECORD,{...record,phase:'ready'});
        await flush(ctx,child.agent.session);
        return {sessionId:childId,mode:plan.mode};
      } catch(error){
        // Keep a partial child's identity visible for recovery; the source is untouched.
        throw Object.assign(new Error(`创建分支未完全完成：${error?.message??error}`),{branchId:childId});
      }
    };
    return source.agent?.runMaintenance?source.agent.runMaintenance(run):run();
  })();
  jobs.set(childId,{hash,promise});
  try{return await promise;}finally{jobs.delete(childId);}
}

export async function branchNavigation(ctx,payload){
  const id=validId(payload?.sessionId);
  const records=await ctx.sessionQuery.listSessions();
  const byId=new Map(records.map(({header})=>[header.id,header]));
  if(!byId.has(id)){const own=await readSource(ctx,id);byId.set(id,own.header);}
  let root=id;const ancestors=new Set();
  while(byId.get(root)?.parentSession&&byId.has(byId.get(root).parentSession)&&!ancestors.has(root)){
    ancestors.add(root);root=byId.get(root).parentSession;
  }
  const family=new Set([root]);
  for(let changed=true;changed;){changed=false;for(const [key,h]of byId){if(h.origin!=='subagent'&&family.has(h.parentSession)&&!family.has(key)){family.add(key);changed=true;}}}
  if(family.size>1000)throw new BranchInputError('tree-size','这棵树超过 1000 个分支，请先缩小查看范围。');
  const sources=new Map();const failed=[];
  for(const key of family){
    try{const source=await readSource(ctx,key);source.branch=marker(source);source.messages=displayMessages(source.events);sources.set(key,source);}
    catch(error){failed.push({id:key,message:String(error?.message??error)});}
  }
  if(!sources.has(id))throw new Error('当前分支无法读取。');
  return {...buildBranchNavigation(sources,id),messages:sources.get(id).messages,unavailable:failed};
}

export async function sidebarFamilies(ctx){
  let cache=sidebarCache.get(ctx.sessions);
  if(!cache){cache=new Map();sidebarCache.set(ctx.sessions,cache);}
  const records=await ctx.sessionQuery.listSessions();
  const parents={};
  for(const row of records){
    const {header}=row;
    if(!header.parentSession||header.origin==='subagent')continue;
    let entry=cache.get(header.id);
    if(!entry){
      try{
        const source=await readSource(ctx,header.id);
        const record=marker(source);
        entry={parent:record?.parentId===header.parentSession?record.parentId:null};
        cache.set(header.id,entry);
      }catch{continue;} // Keep unreadable branches visible; retry on refresh.
    }
    if(entry.parent)parents[header.id]=entry.parent;
  }
  return {parents};
}

export function apply(ctx){
  ctx.effect(()=>installBillionCompatibility(ctx),'context-tree Billion fork compatibility');
  for(const projection of editorProjections()){
    if(!ctx.sessions.messageProjections.some(p=>p.type===projection.type))ctx.sessions.registerMessageProjection(projection);
  }
  ctx.effect(()=>ctx.connection.register(ctx,'/dsh-context-tree',async(endpoint,payload)=>{
    try{
      if(endpoint==='branch')return{ok:true,value:await createBranch(ctx,payload)};
      if(endpoint==='navigation')return{ok:true,value:await branchNavigation(ctx,payload)};
      if(endpoint==='sidebar')return{ok:true,value:await sidebarFamilies(ctx)};
      if(endpoint==='sidebar-titles')return{ok:true,value:await readSidebarTitles(ctx,payload)};
      return{ok:false,error:{code:'endpoint',message:'未知操作。'}};
    }catch(error){return{ok:false,error:{code:error.code??'internal',message:String(error?.message??error),...(error.branchId?{branchId:error.branchId}:{})}};}
  }),'context-tree authenticated RPC');
}
