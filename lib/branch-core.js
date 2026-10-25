import { buildForkSeed, decodeSeqRanges, deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session';
import { createMessageProjection,applyTargetsToMessage } from './message-edits.js';
import { createHash } from 'node:crypto';

export const NAME='dsh-context-tree';
export const BRANCH_RECORD='plugin:dsh-context-tree/branch';
export const EDIT_RECORD='plugin:dsh-context-tree/edit';
export const LEGACY_EDIT_RECORD='plugin:dsh-edit-turn/patch';
export const EDIT_RECORDS=new Set([EDIT_RECORD,LEGACY_EDIT_RECORD]);
export const editorProjections=()=>[createMessageProjection(EDIT_RECORD),createMessageProjection(LEGACY_EDIT_RECORD)];

export class BranchInputError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
export function appendEvent(events,type,data,intent={}) {
  const event={type,seq:events.length,time:Date.now(),data:structuredClone(data),...intent};
  events.push(event); return event;
}
export function appendRecord(events,type,data){return appendEvent(events,type,data,{ignorable:true});}
function refs(event){return event.sourceEventSeqs===undefined?[]:[...decodeSeqRanges(event.sourceEventSeqs)];}
function editableUser(event){return event.type==='user/message' && ['dsh-edit-turn',NAME].includes(event.data?.source?.editedBy) && event.surfaceOp?.op==='replace';}
function textOf(content){return content.filter(b=>b.type==='text').map(b=>b.text).join('\n\n');}
export function replaceText(content,text){
  let written=false;
  const next=[];
  for(const block of content){
    if(block.type==='text') {if(!written){next.push({type:'text',text});written=true;}}
    else next.push(structuredClone(block));
  }
  if(!written)next.unshift({type:'text',text});
  return next;
}
export function completedTurns(events){
  const turns=[]; let open;
  for(const event of events){
    if(event.type==='turn/start')open={turn:event.data.turn,start:event.seq,users:[],assistants:[]};
    if(!open)continue;
    if(event.type==='user/message'&&event.data.source?.kind==='user'&&!editableUser(event))open.users.push(event.seq);
    if(event.type==='assistant/message'&&event.data.turn===open.turn)open.assistants.push(event.seq);
    if(event.type==='turn/end'&&event.data.turn===open.turn){turns.push({...open,end:event.seq});open=undefined;}
  }
  return turns;
}

/** Keep only known late edits whose complete provenance lies before the cut. */
export function preservePrefixEdits(source,prefixLength,projections=editorProjections()){
  const seed=prefixLength===0?[{type:'session/end-seed',seq:0,time:Date.now(),data:{inherited:true}}]:structuredClone(buildForkSeed(source,prefixLength-1));
  const mapping=new Map(Array.from({length:prefixLength},(_,i)=>[i,i]));
  // Remember ancestry even for skipped compactions, so dependent early edits fail explicitly.
  const touchesPrefix=new Map();
  for(const event of source){
    const coverage=refs(event);
    touchesPrefix.set(event.seq,event.seq<prefixLength||coverage.some(s=>touchesPrefix.get(s)));
    if(event.seq<prefixLength)continue;
    if(editableUser(event)){
      if(!touchesPrefix.get(event.seq))continue;
      if(coverage.length===0||coverage.some(s=>!mapping.has(s)))throw new BranchInputError('dependent-edit','该楼层之前的编辑依赖后续压缩或重放节点，无法安全分叉。');
      const surface=foldSurface(seed,projections).nodes;
      const selected=coverage.map(s=>mapping.get(s));
      if(selected.some(s=>!surface.includes(s)))throw new BranchInputError('stale-edit','前文编辑的目标已被其他投影替换，无法安全分叉。');
      const positions=selected.map(s=>surface.indexOf(s)).sort((a,b)=>a-b);
      if(positions.at(-1)-positions[0]+1!==positions.length)throw new BranchInputError('edit-window','前文编辑覆盖了不连续的消息。');
      const replacement=appendEvent(seed,event.type,event.data,{surfaceOp:{op:'replace',startSeq:surface[positions[0]],endSeq:surface[positions.at(-1)]},sourceEventSeqs:selected});
      mapping.set(event.seq,replacement.seq);
    } else if(EDIT_RECORDS.has(event.type)){
      if(event.data?.version!==1||!Array.isArray(event.data.targets))throw new BranchInputError('edit-format','遇到无法识别的消息编辑记录。');
      const surface=foldSurface(seed,projections).nodes;
      const targets=[];
      for(const target of event.data.targets){
        if(!mapping.has(target.seq)){
          if(touchesPrefix.get(target.seq))throw new BranchInputError('dependent-edit','前文回答修改依赖后续压缩节点，无法安全分叉。');
          continue;
        }
        const seq=mapping.get(target.seq);
        if(surface.includes(seq))targets.push({...target,seq});
      }
      if(targets.length)appendRecord(seed,event.type,{version:1,targets});
    }
  }
  return {seed,mapping};
}

export function planBranch(events,payload,projections=editorProjections()){
  const {action,turn,text}=payload;
  if(!['regenerate','edit-user','edit-assistant'].includes(action))throw new BranchInputError('action','未知的分支操作。');
  if(!Number.isSafeInteger(turn)||turn<1)throw new BranchInputError('turn','请选择有效楼层。');
  if(action!=='regenerate'&&(typeof text!=='string'||!text.trim()||text.length>1_000_000))throw new BranchInputError('text','修改内容为空或过长。');
  const target=completedTurns(events).find(t=>t.turn===turn);
  if(!target||!target.users.length)throw new BranchInputError('turn-incomplete','该楼层尚未结束或没有人类消息。');
  const prefixLength=action==='edit-assistant'?target.end+1:target.start;
  const {seed,mapping}=preservePrefixEdits(events,prefixLength,projections);
  // Resolve the selected turn's human input using its own closed snapshot plus later edits.
  const through=preservePrefixEdits(events,target.end+1,projections);
  const surface=foldSurface(through.seed,projections);
  const resolveUser=seq=>{
    let mapped=through.mapping.get(seq);
    for(const replacement of through.seed){
      if(editableUser(replacement)&&refs(replacement).includes(mapped))mapped=replacement.seq;
    }
    const event=through.seed[mapped];
    if(!surface.nodes.includes(mapped)||event?.type!=='user/message')throw new BranchInputError('prompt-unavailable','该楼层的提问已被无法拆分的压缩替换。');
    return deriveEventMessage(event,surface.projectedMessages);
  };
  const prompts=target.users.map(resolveUser).map(message=>({content:structuredClone(message.content),source:{kind:'user'}}));
  if(action==='edit-user')prompts[0].content=replaceText(prompts[0].content,text);
  if(action==='edit-assistant'){
    const assistant=target.assistants.findLast(seq=>events[seq].data.message.content.some(b=>b.type==='text'));
    if(assistant===undefined)throw new BranchInputError('reply-unavailable','该楼层没有可修改的正文回答。');
    const seq=mapping.get(assistant);
    const folded=foldSurface(seed,projections);
    if(!folded.nodes.includes(seq))throw new BranchInputError('reply-retired','这条回答已被压缩，请选择仍可见的楼层。');
    const message=deriveEventMessage(seed[seq],folded.projectedMessages);
    const blocks=message.content.map((b,i)=>({b,i})).filter(({b})=>b.type==='text');
    appendRecord(seed,EDIT_RECORD,{version:1,targets:blocks.map(({i},j)=>({seq,blockIndex:i,kind:'text',text:j===0?text:''}))});
  }
  return {seed,prefixLength,target,mode:action==='edit-assistant'?'seed-only':'generate',prompts,preview:textOf(prompts[0].content)};
}

/** Stable summaries use the effective surface; plugin edit records never become chat nodes. */
export function displayMessages(events,projections=editorProjections()){
  // Tree navigation includes historical floors even after native compaction.
  // Only explicit edit records change their text; a later summary is not that floor.
  const rows=[]; const slots=new Map(); let current=0;
  for(const event of events){
    if(event.type==='turn/start')current=event.data.turn;
    if(editableUser(event)){
      const targets=[...new Set(refs(event).map(s=>slots.get(s)).filter(Boolean))];
      if(targets.length===1&&targets[0].message.role==='user'){
        targets[0].message=structuredClone(event.data);slots.set(event.seq,targets[0]);
      }
    }else if(EDIT_RECORDS.has(event.type)){
      for(const target of event.data?.targets??[]){
        const row=slots.get(target.seq);
        if(row?.message.role==='assistant')row.message=applyTargetsToMessage(row.message,[target]);
      }
    }else if((event.type==='user/message'||event.type==='assistant/message')&&event.surfaceOp==='append'){
      const message=deriveEventMessage(event);
      if(message.role==='user'&&message.source?.kind!=='user')continue;
      const row={turn:event.data?.turn??current,seq:event.seq,message:structuredClone(message),original:message};
      rows.push(row);slots.set(event.seq,row);
    }
  }
  // Floors follow completed human rounds. Intermediate tool-step narration is
  // retained in the native transcript, but must not offer an editor for a different final reply.
  const floors=new Map();
  for(const row of rows){
    const floor=floors.get(row.turn)??{};
    if(row.message.role==='user'&&!floor.user)floor.user=row;
    if(row.message.role==='assistant'&&textOf(row.message.content))floor.assistant=row;
    floors.set(row.turn,floor);
  }
  return [...floors.values()].flatMap(f=>[f.user,f.assistant].filter(Boolean)).map(({turn,seq,message,original})=>({role:message.role,messageId:original.id,turn,seq,text:textOf(message.content),patched:textOf(message.content)!==textOf(original.content),nonText:message.content.some(b=>b.type!=='text'),contentKey:createHash('sha256').update(JSON.stringify(message.content)).digest('hex')}));
}
