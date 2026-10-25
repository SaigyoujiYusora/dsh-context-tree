import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { BranchModelPicker } from './BranchModelPicker.jsx'
import { installSidebarTree } from './SidebarTree.jsx'
import {
  assistantMessageNodeKey,
  assistantMessageTurn,
  conversationTreeStats,
  findMessageEditSeat,
  findUserActionSeat,
  turnAssistantText,
  turnUserNodeKey,
  turnUserText,
} from './tree.js'

export {
  conversationTreeStats,
} from './tree.js'

const NS = 'dsh-context-tree'

const zh = {
  'view.tree': '上下文树',
  'tree.title': '对话分支树',
  'tree.description': '共享历史只显示一次；编辑或重新生成会在对应的提问或回答处分叉。',
  'tree.emptyTitle': '暂无可显示的消息树',
  'tree.emptyBody': '这条会话还没有普通对话消息，或属于子代理会话。',
  'tree.loading': '正在读取对话树…',
  'tree.error': '无法读取对话树：{message}',
  'tree.sessions': '{count} 个会话版本',
  'tree.messages': '{count} 条消息',
  'tree.forks': '{count} 个分叉点',
  'tree.open': '打开{role}所在的会话：{text}',
  'tree.turn': '第 {count} 轮',
  'tree.versions': '{count} 个后续版本',
  'message.user': '提问',
  'message.assistant': '回答',
  'message.nonText': '非文本消息',
  'status.current': '当前路径',
  'status.currentBranch': '当前会话',
  'action.regenerate': 'Swipe · 新尝试',
  'action.editUser': '编辑提问为新分支',
  'action.editAssistant': '编辑回答为新分支',
  'action.working': '正在创建分支…',
  'branch.label': '切换此消息的分支',
  'branch.previous': '上一个分支',
  'branch.next': '下一个分支',
  'branch.error': '无法切换分支：{message}',
  'editor.help': '原分支保持不变；保存后会打开新的子分支。',
  'editor.promptTitle': '编辑提问',
  'editor.replyTitle': '编辑回答',
  'editor.branchHint': '原版本将保留',
  'editor.saveShort': '保存分支',
  'editor.generate': '另存并生成',
  'editor.model': '模型',
  'editor.modelLoading': '正在读取可用模型…',
  'editor.modelUnavailable': '没有可用模型',
  'editor.modelError': '无法读取模型：{message}',
  'editor.cancel': '取消',
  'editor.save': '保存为新分支',
  'error.blank': '内容不能为空。',
  'error.branch': '无法创建分支：{message}',
}

const en = {
  'view.tree': 'Tree',
  'tree.title': 'Conversation branches',
  'tree.description': 'Shared history appears once; edits and regenerations fork at the exact prompt or reply they replace.',
  'tree.emptyTitle': 'No message tree to display',
  'tree.emptyBody': 'This session has no ordinary conversation messages yet, or it belongs to a subagent.',
  'tree.loading': 'Loading conversation tree…',
  'tree.error': 'Could not load the conversation tree: {message}',
  'tree.sessions': '{count} conversation versions',
  'tree.messages': '{count} messages',
  'tree.forks': '{count} fork points',
  'tree.open': 'Open the session containing this {role}: {text}',
  'tree.turn': 'Turn {count}',
  'tree.versions': '{count} next versions',
  'message.user': 'Prompt',
  'message.assistant': 'Reply',
  'message.nonText': 'Non-text message',
  'status.current': 'Current path',
  'status.currentBranch': 'Current conversation',
  'action.regenerate': 'Regenerate',
  'action.editUser': 'Edit prompt',
  'action.editAssistant': 'Edit reply',
  'action.working': 'Creating branch…',
  'branch.label': 'Switch branches for this message',
  'branch.previous': 'Previous branch',
  'branch.next': 'Next branch',
  'branch.error': 'Could not switch branch: {message}',
  'editor.help': 'The original branch stays unchanged; saving opens a new child branch.',
  'editor.promptTitle': 'Edit prompt',
  'editor.replyTitle': 'Edit reply',
  'editor.branchHint': 'Original version kept',
  'editor.saveShort': 'Save branch',
  'editor.generate': 'Save & generate',
  'editor.model': 'Model',
  'editor.modelLoading': 'Loading available models…',
  'editor.modelUnavailable': 'No models available',
  'editor.modelError': 'Could not load models: {message}',
  'editor.cancel': 'Cancel',
  'editor.save': 'Save as branch',
  'error.blank': 'Content cannot be blank.',
  'error.branch': 'Could not create branch: {message}',
}

const css = `
.ct-page{box-sizing:border-box;min-height:100%;padding:24px clamp(16px,4vw,44px) 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-family:var(--dsw-font-family,ui-sans-serif,system-ui,sans-serif)}
.ct-page *{box-sizing:border-box}.ct-hero{max-width:920px;margin:0 auto 22px;padding-bottom:18px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ct-eyebrow{display:flex;align-items:center;gap:8px;margin:0 0 7px;color:var(--dsw-alias-state-business-primary);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.ct-title{margin:0;color:var(--dsw-alias-label-primary);font-size:24px;line-height:32px;font-weight:650}.ct-description{max-width:680px;margin:7px 0 0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.ct-stats{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 0;padding:0;list-style:none}.ct-stat{padding:4px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.ct-treeWrap{max-width:920px;min-width:0;margin:0 auto;overflow:hidden}.ct-messageTree,.ct-messageChildren{min-width:0;margin:0;padding:0;list-style:none}.ct-messageTree[data-fork=true]{position:relative;padding-left:24px}.ct-messageTree[data-fork=true]:before{position:absolute;top:28px;bottom:28px;left:7px;width:1px;background:var(--dsw-alias-border-l2);content:""}.ct-messageTree[data-fork=true]>.ct-messageItem:before{position:absolute;top:28px;left:-16px;width:16px;height:1px;background:var(--dsw-alias-border-l2);content:""}
.ct-messageItem{position:relative;min-width:0;margin:0 0 8px}.ct-messageChildren{margin-top:8px}.ct-messageChildren[data-fork=false]>.ct-messageItem:before{position:absolute;top:-8px;left:20px;width:1px;height:8px;background:var(--dsw-alias-border-l2);content:""}.ct-messageChildren[data-fork=true]{position:relative;margin-left:18px;padding-left:24px}.ct-messageChildren[data-fork=true]:before{position:absolute;top:-8px;bottom:28px;left:7px;width:1px;background:var(--dsw-alias-border-l2);content:""}.ct-messageChildren[data-fork=true]>.ct-messageItem:before{position:absolute;top:28px;left:-16px;width:16px;height:1px;background:var(--dsw-alias-border-l2);content:""}
.ct-message{display:grid;width:100%;min-width:0;min-height:56px;grid-template-columns:minmax(0,1fr);gap:6px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;color:inherit;background:transparent;text-align:left;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 72px;transition:border-color .16s ease,background .16s ease,box-shadow .16s ease}.ct-message:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}.ct-message:focus-visible,.ct-inlineButton:focus-visible,.ct-branchButton:focus-visible,.ct-editorButton:focus-visible,.ct-editorText:focus-visible,.ct-editorSelect:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.ct-message[data-current-path=true]{background:var(--dsw-alias-bg-module-platform);box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary)}.ct-message[data-current-terminal=true]{border-color:var(--dsw-alias-state-business-primary)}
.ct-messageHeader{display:flex;min-width:0;flex-wrap:wrap;align-items:center;gap:5px 8px}.ct-messageRole{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:650}.ct-messageRole[data-role=user]{color:var(--dsw-alias-state-business-primary)}.ct-turn{color:var(--dsw-alias-label-caption);font-size:11px;line-height:18px;font-variant-numeric:tabular-nums}.ct-pill{display:inline-flex;align-items:center;min-height:20px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}.ct-pill[data-current=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.ct-messageText{display:-webkit-box;min-width:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:14px;line-height:21px;overflow-wrap:anywhere;white-space:pre-wrap;-webkit-box-orient:vertical;-webkit-line-clamp:3}.ct-message[data-current-path=false] .ct-messageText{color:var(--dsw-alias-label-secondary)}
.ct-empty{max-width:680px;margin:48px auto;padding:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;text-align:center}.ct-empty h2{margin:0 0 6px;font-size:16px}.ct-empty p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px}
.ct-actions{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:3px 0 5px}.ct-action{display:inline-flex;min-height:30px;align-items:center;gap:5px;padding:4px 8px;border:0;border-radius:6px;color:var(--dsw-alias-label-tertiary);background:transparent;font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:color .15s ease,background .15s ease}.ct-action:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.ct-action:disabled{opacity:.48;cursor:not-allowed}.ct-icon{width:15px;height:15px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.ct-working{margin-left:4px;color:var(--dsw-alias-label-tertiary);font-size:11px}.ct-error{flex-basis:100%;margin:2px 0 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.ct-inlineButton,.ct-branchButton{display:inline-flex;width:28px;height:28px;flex:none;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;color:var(--dsw-alias-label-tertiary);background:transparent;font:inherit;cursor:pointer;transition:color .15s ease,background .15s ease}.ct-inlineButton:hover:not(:disabled),.ct-branchButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.ct-inlineButton:disabled,.ct-branchButton:disabled{opacity:.38;cursor:not-allowed}.ct-branchNav{order:1;display:inline-flex;height:28px;align-items:center;gap:1px;margin-inline:2px;color:var(--dsw-alias-label-tertiary)}.ct-branchCounter{min-width:34px;text-align:center;font-size:11px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}.ct-branchButton{width:24px}.ct-chevron{width:13px;height:13px}.ct-inlineStatus{margin-inline:3px;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}.ct-inlineError{max-width:240px;overflow:hidden;margin-inline:3px;color:var(--dsw-alias-state-error-primary);font-size:11px;text-overflow:ellipsis;white-space:nowrap}

[data-ct-editing=true]>:not(.ct-inlineEditor){display:none!important}
.ct-inlineEditor,.ct-inlineEditor *{box-sizing:border-box}
.ct-inlineEditor{width:100%;min-width:0;margin:8px 0;padding:16px 18px 12px;border:1px solid var(--dsw-alias-border-l2,#3b3b3d);border-radius:18px;color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-specific-input-major,#29292c);transition:border-color .15s ease}
.ct-inlineEditor:focus-within{border-color:var(--dsw-alias-border-l3,#555)}
.ct-inlineEditor[data-role=user]{width:min(640px,100%);margin-left:auto}
.ct-editorHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.ct-editorTitle{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-secondary,#ddd)}
.ct-editorHelp{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.ct-editorText{display:block;width:100%;min-height:56px;max-height:min(45vh,360px);padding:0;resize:none;border:0;border-radius:0;outline:0!important;box-shadow:none;background:transparent;color:inherit;font:inherit;font-size:15px;line-height:1.65;overflow-y:auto;scrollbar-width:thin}
.ct-editorFooter{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-top:16px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,#3b3b3d)}
.ct-editorModel{position:relative;display:inline-flex;align-items:center;min-width:0;max-width:min(260px,100%);color:var(--dsw-alias-label-secondary,#ccc)}
.ct-editorModelIcon{position:absolute;left:8px;width:14px;height:14px;pointer-events:none;opacity:.65}
.ct-editorSelect{appearance:none;width:100%;max-width:260px;min-width:120px;min-height:32px;padding:5px 25px 5px 29px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;text-overflow:ellipsis;cursor:pointer}
.ct-editorSelect:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.ct-editorSelect:disabled{opacity:.8;cursor:default}
.ct-editorSelect option,.ct-editorSelect optgroup{background:var(--dsw-alias-bg-base,#202022);color:var(--dsw-alias-label-primary,#eee)}
.ct-editorChevron{position:absolute;right:8px;pointer-events:none;font-size:12px;opacity:.6}
.ct-editorNativeModel{min-width:0;max-width:100%}.ct-editorNativeModel button{max-width:100%}.ct-editorActions{display:flex;align-items:center;gap:6px;margin-left:auto}
.ct-editorButton{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:7px 13px;border:0;border-radius:18px;background:transparent;color:var(--dsw-alias-label-secondary,#bbb);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.ct-editorButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#eee)}
.ct-editorButton[data-primary=true]{padding-inline:16px;color:var(--dsw-alias-bg-base,#171717);background:var(--dsw-alias-label-primary,#eee);font-weight:500}
.ct-editorButton[data-primary=true]:hover:not(:disabled){color:var(--dsw-alias-bg-base,#171717);background:var(--dsw-alias-label-primary,#eee);filter:brightness(.9)}
.ct-editorButton:disabled{opacity:.45;cursor:default}
.ct-inlineEditor .ct-error{margin:8px 0 0;font-size:12px;line-height:1.5}
@media(max-width:600px){.ct-page{padding:18px 12px 36px}.ct-title{font-size:20px;line-height:28px}.ct-messageTree[data-fork=true],.ct-messageChildren[data-fork=true]{padding-left:16px}.ct-messageChildren[data-fork=true]{margin-left:8px}.ct-messageTree[data-fork=true]>.ct-messageItem:before,.ct-messageChildren[data-fork=true]>.ct-messageItem:before{left:-8px;width:8px}.ct-message{padding:10px}.ct-inlineButton,.ct-branchButton{width:40px;height:40px}.ct-branchNav{height:40px}.ct-inlineEditor{padding:14px}.ct-editorModel{max-width:100%}.ct-editorFooter{gap:8px}.ct-editorActions{margin-left:auto}.ct-editorButton{min-height:40px}}
@media(prefers-reduced-motion:reduce){.ct-message,.ct-inlineButton,.ct-branchButton{transition:none}}
`

function installStyles() {
  if (typeof document === 'undefined') return
  const id = 'dsh-context-tree/client.css'
  if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', id)
  tag.dataset.plugin = NS
  tag.textContent = css
  document.head.appendChild(tag)
}

installStyles()

function Icon({ kind }) {
  const paths = kind === 'regenerate'
    ? <><path d="M3 7a6 6 0 1 1 1.5 6"/><path d="M3 3v4h4"/></>
    : kind === 'previous'
      ? <path d="m11 4-4 5 4 5"/>
      : kind === 'next'
        ? <path d="m7 4 4 5-4 5"/>
    : kind === 'tree'
      ? <><path d="M8 3v4M4 13v-2a4 4 0 0 1 4-4 4 4 0 0 1 4 4v2"/><rect x="2" y="13" width="4" height="3" rx="1"/><rect x="10" y="13" width="4" height="3" rx="1"/></>
      : <><path d="M3 13.5V16h2.5L14 7.5 11.5 5 3 13.5Z"/><path d="m10.5 6 2.5 2.5"/></>
  return <svg className={kind === 'previous' || kind === 'next' ? 'ct-icon ct-chevron' : 'ct-icon'} viewBox="0 0 18 18" aria-hidden="true">{paths}</svg>
}

function useConversationTree(loadNavigation, sessionId, running) {
  const [state, setState] = useState({ status: 'loading', tree: null, error: null })
  useEffect(() => {
    let current = true
    setState({ status: 'loading', tree: null, error: null })
    void loadNavigation(sessionId).then(result => {
      if (!current) return
      if (!result?.ok) {
        setState({ status: 'error', tree: null, error: resultError(result) })
        return
      }
      setState({ status: 'ready', tree: result.value?.tree ?? null, error: null })
    }).catch(cause => {
      if (current) setState({ status: 'error', tree: null, error: cause instanceof Error ? cause.message : String(cause) })
    })
    return () => { current = false }
  }, [loadNavigation, running, sessionId])
  return state
}

function MessageNode({ node, currentId, openSession, createBranch, openBranch, getModelDirectory, t }) {
  const currentPath = node.sessionIds.includes(currentId)
  const currentTerminal = node.terminalSessionIds.includes(currentId)
  const targetSession = currentPath
    ? currentId
    : node.terminalSessionIds.at(-1) ?? node.sessionIds.at(-1)
  const [editing, setEditing] = useState(false)
  const mutation = useBranchMutation({ sessionId: targetSession, turn: node.turn, createBranch, openBranch, t })
  const role = t(node.role === 'user' ? 'message.user' : 'message.assistant')
  const text = node.text === '' ? t('message.nonText') : node.text
  const actionKey = node.action === 'edit-user'
    ? 'action.editUser'
    : node.action === 'edit-assistant'
      ? 'action.editAssistant'
      : node.action === 'regenerate'
        ? 'action.regenerate'
        : null
  return (
    <li className="ct-messageItem">
      <button
        type="button"
        className="ct-message"
        data-current-path={currentPath ? 'true' : 'false'}
        data-current-terminal={currentTerminal ? 'true' : 'false'}
        aria-current={currentTerminal ? 'page' : undefined}
        aria-label={t('tree.open', { role, text })}
        onClick={() => { if (targetSession !== undefined) openSession(targetSession) }}
      >
        <span className="ct-messageHeader">
          <span className="ct-messageRole" data-role={node.role}>{role}</span>
          <span className="ct-turn">{t('tree.turn', { count: String(node.turn) })}</span>
          {actionKey !== null && <span className="ct-pill">{t(actionKey)}</span>}
          {currentTerminal && <span className="ct-pill" data-current="true">{t('status.currentBranch')}</span>}
          {node.children.length > 1 && <span className="ct-pill">{t('tree.versions', { count: String(node.children.length) })}</span>}
        </span>
        <span className="ct-messageText" title={text}>{text}</span>
      </button>
      <div className="ct-actions">
        {node.role === 'assistant' && <button className="ct-action" disabled={mutation.busy} onClick={() => { void mutation.run('regenerate') }}>{t('action.regenerate')}</button>}
        <button className="ct-action" disabled={mutation.busy || !node.text} onClick={() => { mutation.setError(null); setEditing(true) }}>{t(node.role === 'user' ? 'action.editUser' : 'action.editAssistant')}</button>
        {mutation.error && <span role="alert" className="ct-inlineError">{mutation.error}</span>}
      </div>
      {editing && <InlineEditor action={node.role === 'user' ? 'edit-user' : 'edit-assistant'} initialText={node.text} busy={mutation.busy} error={mutation.error} directory={getModelDirectory(targetSession)} onCancel={() => setEditing(false)} onSubmit={(text, selection) => { void mutation.run(node.role === 'user' ? 'edit-user' : 'edit-assistant',text,selection,()=>setEditing(false)) }} t={t} />}
      {node.children.length > 0 && (
        <ol className="ct-messageChildren" data-fork={node.children.length > 1 ? 'true' : 'false'}>
          {node.children.map(child => (
            <MessageNode key={child.id} node={child} currentId={currentId} openSession={openSession} createBranch={createBranch} openBranch={openBranch} getModelDirectory={getModelDirectory} t={t} />
          ))}
        </ol>
      )}
    </li>
  )
}

export function ConversationTreeView({ sessionId, useSession, loadNavigation, openSession, createBranch, openBranch, getModelDirectory, t }) {
  const running = useSession(snapshot => snapshot.running)
  const { status, tree, error } = useConversationTree(loadNavigation, sessionId, running)
  const stats = useMemo(() => conversationTreeStats(tree), [tree])
  if (status !== 'ready' || tree === null || tree.children.length === 0) {
    const failed = status === 'error'
    return (
      <section className="ct-page">
        <div className="ct-empty" role={failed ? 'alert' : 'status'}>
          <h2>{failed ? t('tree.error', { message: error ?? 'unknown error' }) : status === 'loading' ? t('tree.loading') : t('tree.emptyTitle')}</h2>
          {!failed && status === 'ready' && <p>{t('tree.emptyBody')}</p>}
        </div>
      </section>
    )
  }
  return (
    <section className="ct-page" aria-labelledby="ct-tree-title">
      <header className="ct-hero">
        <p className="ct-eyebrow"><Icon kind="tree" />{t('view.tree')}</p>
        <h1 className="ct-title" id="ct-tree-title">{t('tree.title')}</h1>
        <p className="ct-description">{t('tree.description')}</p>
        <ul className="ct-stats" aria-label={t('tree.title')}>
          <li className="ct-stat">{t('tree.sessions', { count: String(stats.sessions) })}</li>
          <li className="ct-stat">{t('tree.messages', { count: String(stats.messages) })}</li>
          <li className="ct-stat">{t('tree.forks', { count: String(stats.forks) })}</li>
        </ul>
      </header>
      <nav className="ct-treeWrap" aria-label={t('tree.title')}>
        <ol className="ct-messageTree" data-fork={tree.children.length > 1 ? 'true' : 'false'}>
          {tree.children.map(child => (
            <MessageNode key={child.id} node={child} currentId={tree.currentId} openSession={openSession} createBranch={createBranch} openBranch={openBranch} getModelDirectory={getModelDirectory} t={t} />
          ))}
        </ol>
      </nav>
    </section>
  )
}

function InlineEditor({ action, initialText, busy, error, directory, onCancel, onSubmit, t }) {
  const [text, setText] = useState(initialText)
  const textarea = useRef(null)
  const userEdit = action === 'edit-user'
  const modelState = useSyncExternalStore(
    listener => directory.store.subscribe(listener),
    () => directory.store.getSnapshot(),
  )
  const [modelTouched, setModelTouched] = useState(false)
  const [selection, setSelection] = useState(() => modelState.current === null
    ? null
    : plainModelSelection(modelState.current))
  useEffect(() => {
    textarea.current?.focus()
    textarea.current?.setSelectionRange(initialText.length, initialText.length)
  }, [initialText])
  useEffect(() => {
    const field = textarea.current
    if (!field) return
    const fit = () => {
      field.style.height = 'auto'
      field.style.height = `${Math.max(56, Math.min(field.scrollHeight, window.innerHeight * .45, 360))}px`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [text])
  useEffect(() => { void directory.load().catch(() => {}) }, [directory])
  useEffect(() => {
    if (!modelTouched && modelState.current !== null) {
      setSelection(plainModelSelection(modelState.current))
    }
  }, [modelState.current, modelTouched])
  const blank = text.trim() === ''
  const modelStatus = modelState.error !== null
    ? t('editor.modelError', { message: modelState.error })
    : selection === null && modelState.status === 'loading'
      ? t('editor.modelLoading')
      : selection === null
        ? t('editor.modelUnavailable')
        : null
  return (
    <form
      className="ct-inlineEditor"
      data-role={userEdit ? 'user' : 'assistant'}
      onKeyDown={event => {
        if (event.defaultPrevented) return
        if (event.key === 'Escape' && !busy) {
          event.preventDefault()
          onCancel()
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          if (!busy && !blank && selection !== null) onSubmit(text, selection)
        }
      }}
      onSubmit={event => {
        event.preventDefault()
        if (!busy && !blank && selection !== null) onSubmit(text, selection)
      }}
    >
      <div className="ct-editorHeader">
        <span className="ct-editorTitle">{t(userEdit ? 'editor.promptTitle' : 'editor.replyTitle')}</span>
        <span className="ct-editorHelp">{t('editor.branchHint')}</span>
      </div>
      <label>
        <textarea
          ref={textarea}
          className="ct-editorText"
          value={text}
          disabled={busy}
          onChange={event => { setText(event.target.value) }}
          aria-label={t(userEdit ? 'action.editUser' : 'action.editAssistant')}
        />
      </label>
      {blank && <p className="ct-error">{t('error.blank')}</p>}
      {error !== null && <p className="ct-error" role="alert">{error}</p>}
      {modelStatus !== null && <p className="ct-error" role="alert">{modelStatus}</p>}
      <div className="ct-editorFooter">
        <div className="ct-editorNativeModel">
          <BranchModelPicker directory={directory} modelState={modelState} selection={selection} locked={busy} onChange={next => {
            setModelTouched(true)
            setSelection(plainModelSelection(next))
          }} />
        </div>
        <div className="ct-editorActions">
          <button type="button" className="ct-editorButton" disabled={busy} onClick={onCancel}>
            {t('editor.cancel')}
          </button>
          <button
            type="submit"
            className="ct-editorButton"
            data-primary="true"
            title="Ctrl / ⌘ + Enter"
            disabled={busy || blank || selection === null}
          >
            {busy ? t('action.working') : t(userEdit ? 'editor.generate' : 'editor.saveShort')}
          </button>
        </div>
      </div>
    </form>
  )
}

export function selectTurnActions(owner) {
  const turn = owner?.turn
  return turn?.status === 'closed'
    ? { turn: turn.turn }
    : null
}

function resultError(result) {
  return result?.ok === false && typeof result.error?.message === 'string'
    ? result.error.message
    : 'unknown error'
}

function useBranchNavigation(loadNavigation, sessionId, turn, role, running) {
  const [all, setAll] = useState(null)
  useEffect(() => {
    let current = true
    setAll(null)
    if (!Number.isSafeInteger(turn)) return () => { current = false }
    void loadNavigation(sessionId).then(result => {
      if (current && result?.ok) setAll(result.value)
    })
    return () => { current = false }
  }, [loadNavigation, role, running, sessionId, turn])
  return all?.[role]?.[turn] ?? null
}

function useBranchMutation({ sessionId, turn, createBranch, openBranch, t }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const abort = useRef(null)
  useEffect(() => () => { abort.current?.abort() }, [])

  const run = async (action, text, modelSelection, onCreated) => {
    setBusy(true)
    setError(null)
    const controller = new AbortController()
    abort.current = controller
    try {
      const result = await createBranch({
        operationId: crypto.randomUUID(),
        sessionId,
        action,
        turn,
        ...(text === undefined ? {} : { text }),
        ...(modelSelection === undefined ? {} : { modelSelection }),
      }, controller.signal)
      if (!result?.ok) throw new Error(resultError(result))
      onCreated?.()
      await openBranch(result.value.sessionId)
    } catch (cause) {
      if (controller.signal.aborted) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(t('error.branch', { message }))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

function BranchNavigator({ navigation, openBranch, t }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  if (navigation === null || navigation.ids.length < 2) return null
  const move = async index => {
    setBusy(true)
    setError(null)
    try {
      await openBranch(navigation.ids[index])
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(t('branch.error', { message }))
      setBusy(false)
    }
  }
  return (
    <>
      <nav className="ct-branchNav" aria-label={t('branch.label')}>
        <button
          type="button"
          className="ct-branchButton"
          aria-label={t('branch.previous')}
          title={t('branch.previous')}
          disabled={busy || navigation.index === 0}
          onClick={() => { void move(navigation.index - 1) }}
        >
          <Icon kind="previous" />
        </button>
        <span className="ct-branchCounter" aria-live="polite">
          {navigation.index + 1} / {navigation.ids.length}
        </span>
        <button
          type="button"
          className="ct-branchButton"
          aria-label={t('branch.next')}
          title={t('branch.next')}
          disabled={busy || navigation.index === navigation.ids.length - 1}
          onClick={() => { void move(navigation.index + 1) }}
        >
          <Icon kind="next" />
        </button>
      </nav>
      {error !== null && <span className="ct-inlineError" role="alert" title={error}>{error}</span>}
    </>
  )
}

function EditButton({ kind = 'edit', label, disabled, onClick }) {
  return (
    <button
      type="button"
      className="ct-inlineButton"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon kind={kind} />
    </button>
  )
}

export function UserBranchActions({ matched, turn: turnOwner, sessionId, useSession, useChat, createBranch, loadNavigation, openBranch, getModelDirectory, t }) {
  const turn = matched?.turn ?? turnOwner?.turn
  const userText = useChat(chat => turnUserText({ chat }, turn))
  const userNodeKey = useChat(chat => turnUserNodeKey({ chat }, turn))
  const running = useSession(snapshot => snapshot.running)
  const navigation = useBranchNavigation(loadNavigation, sessionId, turn, 'user', running)
  const [seat, setSeat] = useState(null)
  const [editorSeat, setEditorSeat] = useState(null)
  const [editing, setEditing] = useState(false)
  const mutation = useBranchMutation({ sessionId, turn, createBranch, openBranch, t })
  useEffect(() => {
    if (typeof document === 'undefined') return
    setSeat(findUserActionSeat(document, userNodeKey))
    setEditorSeat(findMessageEditSeat(document, userNodeKey))
  }, [userNodeKey])
  useEffect(() => {
    if (!editing || editorSeat === null) return
    editorSeat.setAttribute('data-ct-editing', 'true')
    return () => { editorSeat.removeAttribute('data-ct-editing') }
  }, [editing, editorSeat])

  const buttons = (
    <>
      <EditButton
        label={t('action.editUser')}
        disabled={running || mutation.busy || userText === ''}
        onClick={() => {
          mutation.setError(null)
          setEditing(true)
        }}
      />
      <BranchNavigator navigation={navigation} openBranch={openBranch} t={t} />
      {mutation.busy && <span className="ct-inlineStatus" role="status">{t('action.working')}</span>}
      {mutation.error !== null && !editing && (
        <span className="ct-inlineError" role="alert" title={mutation.error}>{mutation.error}</span>
      )}
    </>
  )
  const controls = seat === null ? buttons : createPortal(buttons, seat)

  return (
    <>
      {controls}
      {editing && editorSeat !== null && createPortal((
        <InlineEditor
          action="edit-user"
          initialText={userText}
          busy={mutation.busy}
          error={mutation.error}
          directory={getModelDirectory(sessionId)}
          onCancel={() => { setEditing(false); mutation.setError(null) }}
          onSubmit={(text, modelSelection) => {
            void mutation.run('edit-user', text, modelSelection, () => { setEditing(false) })
          }}
          t={t}
        />
      ), editorSeat)}
    </>
  )
}

export function AssistantBranchActions({ messageId, sessionId, useSession, useChat, createBranch, loadNavigation, openBranch, getModelDirectory, t }) {
  const turn = useChat(chat => assistantMessageTurn({ chat }, messageId))
  const assistantNodeKey = useChat(chat => assistantMessageNodeKey({ chat }, messageId))
  const userText = useChat(chat => turnUserText({ chat }, turn))
  const rawAssistantText = useChat(chat => turnAssistantText({ chat }, turn))
  const [effectiveReply, setEffectiveReply] = useState(null)
  const assistantText = effectiveReply?.text ?? rawAssistantText
  const running = useSession(snapshot => snapshot.running)
  const navigation = useBranchNavigation(loadNavigation, sessionId, turn, 'assistant', running)
  const [editorSeat, setEditorSeat] = useState(null)
  const [editing, setEditing] = useState(false)
  const mutation = useBranchMutation({ sessionId, turn, createBranch, openBranch, t })
  const [patchSeat, setPatchSeat] = useState(null)
  useEffect(() => {
    let active = true
    setEffectiveReply(null)
    void loadNavigation(sessionId).then(result => {
      if (active && result?.ok) setEffectiveReply(result.value.messages?.find(m => m.role === 'assistant' && m.messageId === messageId) ?? null)
    }).catch(() => {})
    return () => { active = false }
  }, [loadNavigation, sessionId, messageId, running])
  useEffect(() => {
    if (!effectiveReply?.patched || editorSeat === null) { setPatchSeat(null); return }
    // Scope to the native response row identified by the exact conversation node key.
    const roots = [...document.querySelectorAll('[data-chat-anchor-key]')].filter(row => row.getAttribute('data-chat-anchor-key') === assistantNodeKey && row.getAttribute('data-chat-group-part') === 'response')
    const root = roots[0] ?? editorSeat
    const textNodes = [...root.querySelectorAll('[class*="markdown"]')].filter(el => !el.parentElement?.closest('[class*="markdown"]'))
    const previous = textNodes.map(el => [el, el.style.display])
    const footer = [...document.querySelectorAll('[data-chat-flow-kind="turn-tail"]')].find(row => row.getAttribute('data-chat-turn') === String(turn))
    const nativeCopy = footer?.querySelector('[data-clock="end"] > button')
    const copyDisplay = nativeCopy?.style.display
    if (nativeCopy) nativeCopy.style.display = 'none'
    for (const [el] of previous) el.style.display = 'none'
    const seat = document.createElement('div')
    seat.setAttribute('data-context-tree-reply', messageId)
    root.appendChild(seat)
    setPatchSeat(seat)
    return () => { for (const [el, display] of previous) el.style.display = display; if (nativeCopy) nativeCopy.style.display = copyDisplay; seat.remove(); setPatchSeat(null) }
  }, [effectiveReply, editorSeat, assistantNodeKey, messageId])
  useEffect(() => {
    if (typeof document === 'undefined') return
    setEditorSeat(findMessageEditSeat(document, assistantNodeKey))
  }, [assistantNodeKey])
  useEffect(() => {
    if (!editing || editorSeat === null) return
    editorSeat.setAttribute('data-ct-editing', 'true')
    return () => { editorSeat.removeAttribute('data-ct-editing') }
  }, [editing, editorSeat])

  return (
    <>
      {patchSeat !== null && effectiveReply?.patched && createPortal(<MarkdownText text={effectiveReply.text} streaming={false} />, patchSeat)}
      {effectiveReply?.patched && <button className="ct-inlineButton" aria-label="复制修改后的回答" title="复制修改后的回答" onClick={() => { void navigator.clipboard.writeText(effectiveReply.text).catch(() => mutation.setError('复制失败，请手动选择文字。')) }}>⧉</button>}
      <EditButton
        kind="regenerate"
        label={t('action.regenerate')}
        disabled={running || mutation.busy || userText === '' || !Number.isSafeInteger(turn)}
        onClick={() => { void mutation.run('regenerate') }}
      />
      <EditButton
        label={t('action.editAssistant')}
        disabled={running || mutation.busy || assistantText === '' || !Number.isSafeInteger(turn)}
        onClick={() => {
          mutation.setError(null)
          setEditing(true)
        }}
      />
      <BranchNavigator navigation={navigation} openBranch={openBranch} t={t} />
      {mutation.busy && <span className="ct-inlineStatus" role="status">{t('action.working')}</span>}
      {mutation.error !== null && !editing && (
        <span className="ct-inlineError" role="alert" title={mutation.error}>{mutation.error}</span>
      )}
      {editing && editorSeat !== null && createPortal((
        <InlineEditor
          action="edit-assistant"
          initialText={assistantText}
          busy={mutation.busy}
          error={mutation.error}
          directory={getModelDirectory(sessionId)}
          onCancel={() => { setEditing(false); mutation.setError(null) }}
          onSubmit={(text, modelSelection) => {
            void mutation.run('edit-assistant', text, modelSelection, () => { setEditing(false) })
          }}
          t={t}
        />
      ), editorSeat)}
    </>
  )
}

function ChatNavigationGuard({ enterChat, ...props }) {
  useEffect(() => { enterChat() }, [enterChat])
  return null
}

function plainModelSelection(selection) {
  if (typeof selection?.provider !== 'string' || selection.provider === ''
    || typeof selection?.model !== 'string' || selection.model === '') {
    throw new Error('the current session has no valid model selection')
  }
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

async function currentModelSelection(ctx, sessionId) {
  const directory = ctx.modelDirectories.directoryFor(sessionId)
  const current = directory.store.getSnapshot().current
  return plainModelSelection(current ?? (await directory.load()).current)
}

export const inject = [
  'slots', 'sessions', 'uiWorkspace', 'locale', 'connection', 'uiConversation', 'modelDirectories',
]

export function apply(ctx) {
  try { return install(ctx) } catch (error) {
    console.error('dsh-context-tree initialization failed', error)
    throw error
  }
}

function install(ctx) {
  installSidebarTree(ctx)
  const t = ctx.locale.bind(NS)
  const navigationCache = new Map()
  const editorDirectories = new Map()
  let pendingChatSession = null
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-context-tree: dictionaries')
  const openBranch = async sessionId => {
    if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) await ctx.sessions.refresh()
    if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) {
      throw new Error(`new branch "${sessionId}" is not available in the session list`)
    }
    pendingChatSession = sessionId
    ctx.uiWorkspace.openSession(sessionId)
  }
  const createBranch = async (payload, signal) => {
    const modelSelection = payload.modelSelection === undefined
      ? await currentModelSelection(ctx, payload.sessionId)
      : plainModelSelection(payload.modelSelection)
    const result = await ctx.connection.rpc.call(
      '/dsh-context-tree',
      'branch',
      { ...payload, modelSelection },
      signal,
    )
    if (result?.ok) navigationCache.clear()
    return result
  }
  const loadNavigation = sessionId => {
    const cached = navigationCache.get(sessionId)
    if (cached !== undefined) return cached
    const request = ctx.connection.rpc.call('/dsh-context-tree', 'navigation', { sessionId })
      .finally(() => {
        if (navigationCache.get(sessionId) === request) navigationCache.delete(sessionId)
      })
    navigationCache.set(sessionId, request)
    return request
  }
  const injectBranch = () => ({
    createBranch,
    loadNavigation,
    openBranch,
    getModelDirectory: sessionId => {
      const source = ctx.modelDirectories.directoryFor(sessionId)
      const cached = editorDirectories.get(sessionId)
      if (cached?.source === source) return cached
      const directory = {
        source,
        store: source.store,
        load: () => source.load(),
        picker: {
          subscribe: listener => ctx.slots.subscribe('conversation.input.model', listener),
          getSnapshot: () => ctx.slots.entries('conversation.input.model').at(-1) ?? null,
          t: ctx.locale.bind('model'),
        },
      }
      editorDirectories.set(sessionId, directory)
      return directory
    },
  })
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'branches',
    order: 20,
    locale: NS,
    label: () => t('view.tree'),
    inject: (sessionId, actions) => ({ ...injectBranch(), loadNavigation, openSession: id => { ctx.uiWorkspace.openSession(id); if (id === sessionId) actions.setView('chat') } }),
  }, ConversationTreeView))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'context-tree-user-actions',
    locale: NS,
    inject: injectBranch,
  }, UserBranchActions))
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'branch-actions',
    order: 20,
    locale: NS,
    inject: injectBranch,
  }, AssistantBranchActions))
  ctx.slots.inject('conversation.session.header.actions', () => {
    const store = ctx.slots.entries('conversation.session').find(entry => entry.store !== undefined)?.store
    if (store === undefined) throw new Error('dsh-context-tree could not find the conversation session store')
    return ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'branch-chat-navigation',
      locale: NS,
      store,
      inject: (sessionId, actions) => ({
        enterChat: () => {
          if (pendingChatSession !== sessionId) return
          pendingChatSession = null
          actions.setView('chat')
        },
      }),
    }, ChatNavigationGuard)
  })
}
