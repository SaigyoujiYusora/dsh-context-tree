import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { BranchModelPicker } from './BranchModelPicker.jsx'
import { installSidebarTree } from './SidebarTree.jsx'
import {
  assistantNodeForMessage,
  effectiveMessageText,
  extractTurnContent,
  flattenTree,
  isClosedTurn,
  latestMessageRow,
  nodeIncludesSession,
  previewText,
  terminalIds,
  terminalLabel,
  versionInfo,
} from './tree.js'

export const inject = ['slots', 'sessions', 'uiWorkspace', 'locale', 'connection', 'uiConversation', 'modelDirectories']

const LOCALE = {
  zh: {
    label: '上下文树',
    title: '上下文树',
    loading: '正在读取分支…',
    loadFailed: '分支读取失败',
    retry: '重试',
    refresh: '刷新',
    familyPaths: '此家族有 {count} 条已保存路径',
    choosePath: '选择已保存路径',
    open: '打开',
    current: '当前路径',
    shared: '共享上下文',
    branch: '分支',
    user: '提问',
    assistant: '回答',
    attachment: '含附件',
    editUser: '编辑提问',
    regenerate: '重新生成',
    editAssistant: '编辑回答',
    previous: '上一版本',
    next: '下一版本',
    cancel: '取消',
    save: '保存并生成',
    saveAssistant: '保存回答',
    retryOpen: '重试打开分支',
    modelUnavailable: '模型目录不可用，暂时不能保存。',
    modelLoading: '正在读取可用模型…',
    emptyModel: '没有可用模型。',
    editorHint: '支持 Ctrl/Cmd+Enter 保存，Esc 取消。',
    preservedAttachments: '附件会随提问保留。',
    editingAssistantHint: '只修改回答文本，不会再次调用模型。',
    runningLocked: '运行中的回合不能修改。',
    noTurn: '找不到可编辑的回合。',
    noText: '（无文本内容）',
    opening: '正在打开…',
    openFailed: '打开分支失败，请重试。',
    copied: '已复制',
    copy: '复制回答',
    copyFailed: '复制失败，请检查浏览器权限。',
    closeTree: '收起',
    expandTree: '展开',
    headerChat: '返回聊天',
    familyRoot: '家族根路径',
  },
  en: {
    label: 'Context tree',
    title: 'Context tree',
    loading: 'Loading branches…',
    loadFailed: 'Could not load branches',
    retry: 'Retry',
    refresh: 'Refresh',
    familyPaths: '{count} saved paths in this family',
    choosePath: 'Choose a saved path',
    open: 'Open',
    current: 'Current path',
    shared: 'Shared context',
    branch: 'Branch',
    user: 'Prompt',
    assistant: 'Answer',
    attachment: 'Attachment',
    editUser: 'Edit prompt',
    regenerate: 'Regenerate',
    editAssistant: 'Edit answer',
    previous: 'Previous version',
    next: 'Next version',
    cancel: 'Cancel',
    save: 'Save and generate',
    saveAssistant: 'Save answer',
    retryOpen: 'Retry opening branch',
    modelUnavailable: 'The model directory is unavailable, so this cannot be saved yet.',
    modelLoading: 'Loading available models…',
    emptyModel: 'No model is available.',
    editorHint: 'Ctrl/Cmd+Enter saves; Esc cancels.',
    preservedAttachments: 'Attachments stay with the prompt.',
    editingAssistantHint: 'Only the answer text changes; no model call is made.',
    runningLocked: 'Running turns cannot be changed.',
    noTurn: 'No editable turn was found.',
    noText: '(no text)',
    opening: 'Opening…',
    openFailed: 'Could not open the branch. Try again.',
    copied: 'Copied',
    copy: 'Copy answer',
    copyFailed: 'Copy failed. Check browser permissions.',
    closeTree: 'Collapse',
    expandTree: 'Expand',
    headerChat: 'Back to chat',
    familyRoot: 'Family root',
  },
}

const STYLE_ID = 'dsh-context-tree-clean-ui'
const STYLE = `
.ct-shell,.ct-inline-slot,.ct-editor-panel,[data-context-tree-header-action]{--ct-primary:var(--dsw-alias-label-primary,#20262d);--ct-secondary:var(--dsw-alias-label-secondary,#69727c);--ct-layer:var(--dsw-alias-bg-layer-1,#fff);--ct-layer2:var(--dsw-alias-bg-layer-2,#f6f7f8);--ct-border:var(--dsw-alias-border-l2,#dfe3e7);--ct-focus:var(--dsw-alias-brand-primary,#3d72d9)}
.ct-shell{color:var(--ct-primary);display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px 14px calc(24px + var(--dsh-composer-height,0px));font-size:13px;line-height:1.4}
.ct-header{align-items:center;display:flex;gap:8px;justify-content:space-between;min-height:30px}
.ct-title{font-size:15px;font-weight:650;margin:0}.ct-subtle{color:var(--ct-secondary);font-size:12px}.ct-actions{align-items:center;display:flex;flex-wrap:wrap;gap:6px}
.ct-button,.ct-select{background:var(--ct-layer);border:1px solid var(--ct-border);border-radius:5px;color:var(--ct-primary);font:inherit;min-height:28px;padding:4px 9px}.ct-button{cursor:pointer}.ct-button:hover:not(:disabled){border-color:var(--ct-focus)}.ct-button:focus-visible,.ct-select:focus-visible,.ct-editor:focus-visible{border-color:var(--ct-focus);outline:2px solid color-mix(in srgb,var(--ct-focus) 30%,transparent);outline-offset:1px}.ct-button:disabled{cursor:not-allowed;opacity:.5}.ct-button.ct-primary{background:var(--ct-focus);border-color:var(--ct-focus);color:#fff}.ct-button.ct-quiet{background:transparent;border-color:transparent;color:var(--ct-secondary)}
.ct-toolbar{align-items:flex-start;border-bottom:1px solid var(--ct-border);display:flex;flex-wrap:wrap;gap:8px;padding-bottom:10px}.ct-path-picker{display:flex;flex:1 1 260px;gap:6px;min-width:210px}.ct-path-picker .ct-select{flex:1;min-width:0}.ct-status{align-items:center;display:flex;gap:6px;min-height:28px}.ct-dot{background:#46a36a;border-radius:50%;height:7px;width:7px}.ct-dot.ct-busy{background:#d88a29}.ct-error{background:color-mix(in srgb,#c83939 9%,var(--ct-layer));border:1px solid color-mix(in srgb,#c83939 32%,var(--ct-border));border-radius:5px;color:#a32929;padding:7px 9px}.ct-notice{background:var(--ct-layer2);border:1px solid var(--ct-border);border-radius:5px;color:var(--ct-secondary);padding:7px 9px}
.ct-tree{display:flex;flex-direction:column;gap:2px;min-width:0}.ct-tree-row{border-left:2px solid transparent;min-width:0;padding:4px 0 4px 7px;position:relative}.ct-tree-row.ct-current{background:color-mix(in srgb,var(--ct-focus) 8%,transparent);border-left-color:var(--ct-focus)}.ct-tree-row.ct-shared{border-left-color:var(--ct-border)}.ct-tree-row-inner{align-items:flex-start;display:flex;gap:5px;min-width:0}.ct-toggle{background:transparent;border:0;color:var(--ct-secondary);cursor:pointer;height:22px;padding:2px 3px;width:22px}.ct-toggle:disabled{visibility:hidden}.ct-node-main{flex:1;min-width:0}.ct-node-line{align-items:baseline;display:flex;flex-wrap:wrap;gap:6px;min-width:0}.ct-role{color:var(--ct-secondary);font-size:11px;letter-spacing:.02em;text-transform:uppercase}.ct-node-text{cursor:pointer;display:block;min-width:0;overflow-wrap:anywhere}.ct-node-text:hover{text-decoration:underline}.ct-node-meta{align-items:center;display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}.ct-chip{background:var(--ct-layer2);border:1px solid var(--ct-border);border-radius:4px;color:var(--ct-secondary);font-size:11px;padding:1px 5px}.ct-current-chip{color:var(--ct-focus)}.ct-node-actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}.ct-node-actions .ct-button{font-size:12px;min-height:25px;padding:2px 7px}.ct-children{border-left:0;margin-left:0;padding-left:0}.ct-editor{background:var(--ct-layer);border:1px solid var(--ct-border);border-radius:6px;box-sizing:border-box;font:inherit;line-height:1.45;margin-top:7px;max-height:260px;min-height:76px;overflow:auto;padding:8px;resize:none;width:100%}.ct-editor-panel{background:var(--ct-layer2);border:1px solid var(--ct-border);border-radius:6px;margin-top:7px;padding:8px}.ct-editor-actions{align-items:center;display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}.ct-editor-actions .ct-subtle{flex:1 1 180px}.ct-model{border-top:1px solid var(--ct-border);margin-top:8px;padding-top:7px}.ct-model .ct-editorHelp{color:var(--ct-secondary);font-size:12px}.ct-editor-error{color:#a32929;font-size:12px;margin-top:5px}.ct-inline-slot{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.ct-hidden-sync{display:none}.ct-effective-markdown{display:block;min-width:0}.ct-versions{align-items:center;display:flex;gap:4px}.ct-versions .ct-button{font-size:11px;min-height:24px;padding:2px 6px}.ct-empty{color:var(--ct-secondary);padding:20px 4px;text-align:center}.ct-spinner{color:var(--ct-secondary);padding:12px 4px}.ct-tree-footer{border-top:1px solid var(--ct-border);color:var(--ct-secondary);font-size:11px;padding-top:8px}
@media (max-width:600px){.ct-shell{padding:10px 10px calc(24px + var(--dsh-composer-height,0px))}.ct-toolbar{display:block}.ct-path-picker{margin-bottom:7px}.ct-status{justify-content:space-between}}
`

const noop = () => {}
const emptySubscribe = () => noop
const pendingChatSessions = new Set()

function markPendingChatSession(sessionId) {
  if (!sessionId) return
  pendingChatSessions.add(sessionId)
  setTimeout(() => pendingChatSessions.delete(sessionId), 10000)
}

function unmarkPendingChatSession(sessionId) {
  if (sessionId) pendingChatSessions.delete(sessionId)
}

function consumePendingChatSession(sessionId) {
  if (!sessionId || !pendingChatSessions.has(sessionId)) return false
  pendingChatSessions.delete(sessionId)
  return true
}

function translator(ctx) {
  return ctx.locale?.bind?.('contextTree') ?? ((key, value) => {
    const entry = LOCALE.zh[key]
    return entry ?? key
  })
}

function familyPathsLabel(t, count) {
  const value = t('familyPaths', { count })
  if (typeof value !== 'string') return `${count}`
  return value.replaceAll('{count}', String(count)).replaceAll('%count%', String(count))
}

function useTranslator(ctx) {
  return useMemo(() => translator(ctx), [ctx])
}

function useExternalSnapshot(store, fallback) {
  const subscribe = useMemo(() => store?.subscribe?.bind(store) ?? emptySubscribe, [store])
  const getSnapshot = useMemo(() => store?.getSnapshot?.bind(store) ?? (() => fallback), [store, fallback])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function useHostSession(useSession) {
  return useSession?.(state => state) ?? {}
}

function useHostChat(useChat) {
  const value = useChat?.(state => state) ?? null
  return value?.chat ?? value
}

function sessionIsRunning(session) {
  return Boolean(session?.running || session?.status === 'running' || session?.pendingKind)
}

export function createOperationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function errorMessage(error, fallback) {
  if (typeof error === 'string') return error
  return error?.message || fallback
}

function useNavigation(ctx, sessionId) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null })
  const requestRef = useRef(null)
  const load = useCallback(async () => {
    if (!sessionId || !ctx.connection?.rpc?.call) return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setState(current => ({ ...current, status: 'loading', error: null }))
    try {
      const result = await ctx.connection.rpc.call('/dsh-context-tree', 'navigation', { sessionId }, controller.signal)
      if (controller.signal.aborted) return
      if (!result?.ok) throw result?.error ?? new Error('navigation failed')
      setState({ status: 'ready', data: result.value ?? null, error: null })
    } catch (error) {
      if (!controller.signal.aborted) setState(current => ({ ...current, status: 'error', error }))
    }
  }, [ctx, sessionId])
  useEffect(() => {
    void load()
    return () => requestRef.current?.abort()
  }, [load])
  return { ...state, reload: load }
}

function useBranchDirectory(ctx, sessionId) {
  const base = useMemo(() => {
    try { return ctx.modelDirectories?.directoryFor?.(sessionId) ?? null } catch { return null }
  }, [ctx, sessionId])
  const picker = useMemo(() => {
    const getEntry = () => {
      const entries = ctx.slots?.entries?.('conversation.input.model') ?? []
      return entries[entries.length - 1]
    }
    return {
      subscribe: listener => ctx.slots?.subscribe?.('conversation.input.model', listener) ?? noop,
      getSnapshot: getEntry,
      t: ctx.locale?.bind?.('model') ?? ((key) => key),
    }
  }, [ctx])
  return useMemo(() => base ? { ...base, picker } : null, [base, picker])
}

function useModelSelection(ctx, sessionId, enabled) {
  const directory = useBranchDirectory(ctx, sessionId)
  const initial = useMemo(() => ({ current: null, pending: null }), [])
  const modelState = useExternalSnapshot(directory?.store, initial)
  const [selection, setSelectionState] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const touched = useRef(false)

  useEffect(() => {
    touched.current = false
    setSelectionState(modelState?.current ?? null)
  }, [sessionId])
  useEffect(() => {
    if (!touched.current && modelState?.current) setSelectionState(modelState.current)
  }, [modelState?.current])
  useEffect(() => {
    if (!enabled || !directory?.load) return undefined
    let active = true
    setLoadError(null)
    Promise.resolve(directory.load()).catch(error => { if (active) setLoadError(error) })
    return () => { active = false }
  }, [directory, enabled])

  const setSelection = useCallback(next => {
    touched.current = true
    setSelectionState(next)
  }, [])
  const loading = Boolean(modelState?.pending) || (enabled && !selection && !loadError)
  const available = Boolean(selection?.provider && selection?.model) && !loadError && !modelState?.error && !modelState?.unavailable
  return { directory, modelState, selection, setSelection, loadError: loadError ?? modelState?.error, loading, available }
}

async function openSession(ctx, sessionId) {
  if (!sessionId) throw new Error('missing session id')
  if (ctx.sessions?.refresh) await ctx.sessions.refresh()
  const opened = await ctx.uiWorkspace.openSession(sessionId)
  if (opened === false) throw new Error('openSession returned false')
  return opened
}

function useBranchMutation(ctx, sourceSessionId, onOpened) {
  const [state, setState] = useState({ busy: false, error: null, pendingOpen: null })
  const busyRef = useRef(false)
  const abortRef = useRef(null)
  const cancelRequestedRef = useRef(false)
  const onOpenedRef = useRef(onOpened)
  onOpenedRef.current = onOpened

  const openReturned = useCallback(async value => {
    const targetSessionId = value?.sessionId
    markPendingChatSession(targetSessionId)
    try {
      await openSession(ctx, targetSessionId)
      if (cancelRequestedRef.current) {
        unmarkPendingChatSession(targetSessionId)
        setState({ busy: false, error: null, pendingOpen: null })
        return { ok: false, cancelled: true, value }
      }
      setState({ busy: false, error: null, pendingOpen: null })
      onOpenedRef.current?.(value)
      return { ok: true, opened: true, value }
    } catch (error) {
      unmarkPendingChatSession(targetSessionId)
      if (cancelRequestedRef.current) {
        setState({ busy: false, error: null, pendingOpen: null })
        return { ok: false, cancelled: true, value, error }
      }
      setState({ busy: false, error, pendingOpen: value })
      return { ok: true, opened: false, value, error }
    }
  }, [ctx])

  const retryOpen = useCallback(async () => {
    if (!state.pendingOpen) return { ok: false }
    cancelRequestedRef.current = false
    setState(current => ({ ...current, busy: true, error: null }))
    return openReturned(state.pendingOpen)
  }, [openReturned, state.pendingOpen])

  const run = useCallback(async ({ action, turn, text, modelSelection }) => {
    if (busyRef.current || !sourceSessionId) return { ok: false, duplicate: true }
    busyRef.current = true
    cancelRequestedRef.current = false
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setState({ busy: true, error: null, pendingOpen: null })
    const payload = { sessionId: sourceSessionId, operationId: createOperationId(), action, turn }
    if (action === 'edit-user' || action === 'edit-assistant') payload.text = text
    if (modelSelection && action !== 'edit-assistant') payload.modelSelection = modelSelection
    try {
      const result = await ctx.connection.rpc.call('/dsh-context-tree', 'branch', payload, controller.signal)
      if (controller.signal.aborted) return { ok: false, aborted: true }
      if (!result?.ok) throw result?.error ?? new Error('branch failed')
      return await openReturned(result.value)
    } catch (error) {
      if (!controller.signal.aborted) setState({ busy: false, error, pendingOpen: null })
      return { ok: false, aborted: controller.signal.aborted, error }
    } finally {
      busyRef.current = false
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [ctx, openReturned, sourceSessionId])

  const cancel = useCallback(() => {
    cancelRequestedRef.current = true
    abortRef.current?.abort()
    busyRef.current = false
    setState({ busy: false, error: null, pendingOpen: null })
  }, [])

  useEffect(() => () => {
    cancelRequestedRef.current = true
    abortRef.current?.abort()
  }, [])
  return { state, run, retryOpen, cancel }
}

function AutosizeEditor({ value, onChange, disabled, readOnly, onKeyDown, composingRef }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 76), 240)}px`
  }, [value])
  return <textarea
    ref={ref}
    className="ct-editor"
    value={value}
    disabled={disabled}
    readOnly={readOnly}
    onChange={event => onChange(event.target.value)}
    onCompositionStart={() => { composingRef.current = true }}
    onCompositionEnd={() => { composingRef.current = false }}
    onKeyDown={onKeyDown}
    spellCheck="true"
  />
}

function ModelEditor({ model, t, locked }) {
  if (!model.directory) return <div className="ct-editor-error" role="alert">{t('modelUnavailable')}</div>
  if (model.loadError) return <div className="ct-editor-error" role="alert">{errorMessage(model.loadError, t('modelUnavailable'))}</div>
  if (model.loading) return <div className="ct-model"><span className="ct-editorHelp">{t('modelLoading')}</span></div>
  if (!model.available) return <div className="ct-editor-error" role="alert">{t('emptyModel')}</div>
  return <div className="ct-model">
    <BranchModelPicker
      directory={model.directory}
      modelState={model.modelState}
      selection={model.selection}
      onChange={model.setSelection}
      locked={locked}
    />
  </div>
}

function BranchEditor({ ctx, sessionId, turn, kind, initialText, hasAttachments, sourceRunning, onCancel, onComplete }) {
  const t = useTranslator(ctx)
  const [text, setText] = useState(initialText ?? '')
  const [localError, setLocalError] = useState(null)
  const composingRef = useRef(false)
  const model = useModelSelection(ctx, sessionId, kind !== 'edit-assistant')
  const mutation = useBranchMutation(ctx, sessionId, onComplete)
  const saving = mutation.state.busy
  const disabled = sourceRunning || Boolean(mutation.state.pendingOpen)
  const modelRequired = kind !== 'edit-assistant'
  const canSave = !disabled && !saving && (!modelRequired || model.available) && turn != null

  const cancelCurrent = useCallback(() => {
    mutation.cancel()
    onCancel?.()
  }, [mutation.cancel, onCancel])

  const save = useCallback(async () => {
    if (disabled || saving) return
    if (turn == null) { setLocalError(t('noTurn')); return }
    if (modelRequired && !model.available) { setLocalError(t('modelUnavailable')); return }
    setLocalError(null)
    await mutation.run({
      action: kind,
      turn,
      text,
      modelSelection: modelRequired ? model.selection : undefined,
    })
  }, [disabled, kind, model.available, model.selection, modelRequired, mutation.run, saving, t, text, turn])

  const onKeyDown = useCallback(event => {
    if (event.key === 'Escape' && !composingRef.current) {
      event.preventDefault()
      cancelCurrent()
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !composingRef.current) {
      event.preventDefault()
      void save()
    }
  }, [cancelCurrent, save])

  const error = localError || mutation.state.error
  const actionLabel = kind === 'edit-assistant' ? t('saveAssistant') : kind === 'regenerate' ? t('regenerate') : t('save')
  return <div className="ct-editor-panel" data-context-tree-editor={kind}>
    {kind === 'regenerate' ? <div className="ct-subtle">{t('regenerate')} · {t('editorHint')}</div> : <>
      <AutosizeEditor value={text} onChange={setText} disabled={disabled} readOnly={saving} onKeyDown={onKeyDown} composingRef={composingRef} />
      <div className="ct-subtle">{kind === 'edit-assistant' ? t('editingAssistantHint') : t('editorHint')}</div>
      {kind === 'edit-user' && hasAttachments ? <div className="ct-subtle">{t('preservedAttachments')}</div> : null}
    </>}
    {modelRequired ? <ModelEditor model={model} t={t} locked={disabled || saving} /> : null}
    {sourceRunning ? <div className="ct-editor-error" role="alert">{t('runningLocked')}</div> : null}
    {error ? <div className="ct-editor-error" role="alert">{errorMessage(error, t('loadFailed'))}</div> : null}
    {mutation.state.pendingOpen ? <div className="ct-editor-actions">
      <span className="ct-subtle">{t('openFailed')}</span>
      <button type="button" className="ct-button ct-primary" onClick={() => void mutation.retryOpen()} disabled={mutation.state.busy}>{t('retryOpen')}</button>
    </div> : null}
    <div className="ct-editor-actions">
      <span className="ct-subtle">{mutation.state.busy ? t('opening') : ''}</span>
      <button type="button" className="ct-button ct-quiet" onClick={cancelCurrent}>{t('cancel')}</button>
      <button type="button" className="ct-button ct-primary" onClick={() => void save()} disabled={!canSave}>{actionLabel}</button>
    </div>
  </div>
}

function VersionButtons({ t, versions, onOpen, disabled }) {
  if (!versions) return null
  return <span className="ct-versions">
    <button type="button" className="ct-button" disabled={disabled || !versions.previous} onClick={() => onOpen(versions.previous)}>{t('previous')}</button>
    <span className="ct-subtle">{versions.index + 1}/{versions.ids.length}</span>
    <button type="button" className="ct-button" disabled={disabled || !versions.next} onClick={() => onOpen(versions.next)}>{t('next')}</button>
  </span>
}

function TreeNodeRow({ ctx, row, nav, currentId, sourceRunning, openSessionId, returnToChat }) {
  const t = useTranslator(ctx)
  const { node, depth } = row
  const [collapsed, setCollapsed] = useState(false)
  const [editorKind, setEditorKind] = useState(null)
  const turn = node.turn
  const inCurrent = nodeIncludesSession(node, currentId)
  const children = Array.isArray(node.children) ? node.children : []
  const canMutate = inCurrent && !sourceRunning && turn != null
  const versions = inCurrent ? versionInfo(node.role === 'assistant' ? nav?.assistant : nav?.user, turn) : null
  const initialText = node.role === 'assistant'
    ? effectiveMessageText(nav?.messages, { messageId: node.messageId, role: 'assistant', turn }) || node.text
    : node.text
  const sessionTarget = node.sessionIds?.includes?.(currentId) ? currentId : node.sessionIds?.[0]
  const label = node.role === 'assistant' ? t('assistant') : t('user')
  const openVersion = id => { if (id) void openSessionId(id) }
  return <>
    <div className={`ct-tree-row ${inCurrent ? 'ct-current' : ''} ${node.sessionIds?.length > 1 ? 'ct-shared' : ''}`} style={{ marginLeft: `${Math.min(depth, 8) * 8}px` }}>
      <div className="ct-tree-row-inner">
        <button type="button" className="ct-toggle" onClick={() => setCollapsed(value => !value)} disabled={!children.length} aria-label={collapsed ? t('expandTree') : t('closeTree')}>{children.length ? (collapsed ? '+' : '−') : '·'}</button>
        <div className="ct-node-main">
          <div className="ct-node-line">
            <span className="ct-role">{label}</span>
            <span className="ct-node-text" role="button" tabIndex={0} onClick={() => sessionTarget && openSessionId(sessionTarget)} onKeyDown={event => { if (event.key === 'Enter' && sessionTarget) openSessionId(sessionTarget) }}>{previewText(node.text) || t('noText')}</span>
          </div>
          <div className="ct-node-meta">
            {inCurrent ? <span className="ct-chip ct-current-chip">{t('current')}</span> : null}
            {node.nonText ? <span className="ct-chip">{t('attachment')}</span> : null}
            {node.sessionIds?.length > 1 ? <span className="ct-chip">{t('shared')}</span> : null}
          </div>
          {canMutate ? <div className="ct-node-actions">
            {node.role === 'user' ? <button type="button" className="ct-button" onClick={() => setEditorKind('edit-user')}>{t('editUser')}</button> : null}
            {node.role === 'assistant' ? <>
              <button type="button" className="ct-button" onClick={() => setEditorKind('regenerate')}>{t('regenerate')}</button>
              <button type="button" className="ct-button" onClick={() => setEditorKind('edit-assistant')}>{t('editAssistant')}</button>
            </> : null}
          </div> : null}
          {versions ? <div className="ct-node-actions"><VersionButtons t={t} versions={versions} onOpen={openVersion} disabled={false} /></div> : null}
          {editorKind ? <BranchEditor
            ctx={ctx}
            sessionId={currentId}
            turn={turn}
            kind={editorKind}
            initialText={initialText}
            hasAttachments={Boolean(node.nonText)}
            sourceRunning={sourceRunning}
            onCancel={() => setEditorKind(null)}
            onComplete={() => { setEditorKind(null); returnToChat?.() }}
          /> : null}
        </div>
      </div>
    </div>
    {children.length && !collapsed ? <div className="ct-children">{children.map((child, index) => <TreeNodeRow key={`${child.id ?? row.id}:${index}`} ctx={ctx} row={{ node: child, depth: depth + 1, id: child.id ?? `${row.id}:${index}` }} nav={nav} currentId={currentId} sourceRunning={sourceRunning} openSessionId={openSessionId} returnToChat={returnToChat} />)}</div> : null}
  </>
}

function ContextTreeView({ ctx, sessionId, useSession, actions, viewActions }) {
  const t = useTranslator(ctx)
  const session = useHostSession(useSession)
  const running = sessionIsRunning(session)
  const nav = useNavigation(ctx, sessionId)
  const [selectedPath, setSelectedPath] = useState(sessionId)
  const [openError, setOpenError] = useState(null)
  const [openBusy, setOpenBusy] = useState(false)
  const paths = terminalIds(nav.data?.tree)
  const currentId = nav.data?.currentId ?? sessionId
  const viewActionsRef = actions ?? viewActions
  const returnToChat = useCallback(() => viewActionsRef?.setView?.('chat'), [viewActionsRef])
  useEffect(() => { setSelectedPath(currentId) }, [currentId])

  const open = useCallback(async id => {
    if (!id || openBusy) return
    setOpenBusy(true)
    setOpenError(null)
    try {
      await openSession(ctx, id)
      viewActionsRef?.setView?.('chat')
      setSelectedPath(id)
    } catch (error) {
      setOpenError(error)
    } finally {
      setOpenBusy(false)
    }
  }, [ctx, openBusy, viewActionsRef])

  const content = nav.status === 'loading' || nav.status === 'idle' ? <div className="ct-spinner">{t('loading')}</div>
    : nav.status === 'error' ? <div className="ct-error" role="alert"><span>{errorMessage(nav.error, t('loadFailed'))}</span> <button type="button" className="ct-button" onClick={() => void nav.reload()}>{t('retry')}</button></div>
      : !nav.data?.tree ? <div className="ct-empty">{t('noText')}</div>
        : <div className="ct-tree">{flattenTree(nav.data.tree).filter(row => row.depth === 0).map(row => <TreeNodeRow key={row.id} ctx={ctx} row={row} nav={nav.data} currentId={currentId} sourceRunning={running} openSessionId={open} returnToChat={returnToChat} />)}</div>

  return <section className="ct-shell" aria-label={t('title')}>
    <div className="ct-header"><h2 className="ct-title">{t('title')}</h2><div className="ct-status"><span className={`ct-dot ${running ? 'ct-busy' : ''}`} /> <span className="ct-subtle">{running ? t('opening') : t('current')}</span></div></div>
    <div className="ct-toolbar">
      <div className="ct-path-picker">
        <select className="ct-select" value={selectedPath ?? ''} onChange={event => void open(event.target.value)} disabled={openBusy || !paths.length} aria-label={t('choosePath')}>
          {!paths.length ? <option value="">{t('familyRoot')}</option> : paths.map(id => <option key={id} value={id}>{terminalLabel(nav.data?.tree, id)}</option>)}
        </select>
        <button type="button" className="ct-button" onClick={() => void open(selectedPath)} disabled={openBusy || !selectedPath}>{openBusy ? t('opening') : t('open')}</button>
      </div>
      <div className="ct-actions"><span className="ct-subtle">{familyPathsLabel(t, paths.length)}</span><button type="button" className="ct-button" onClick={() => void nav.reload()} disabled={nav.status === 'loading'}>{t('refresh')}</button></div>
    </div>
    {openError ? <div className="ct-error" role="alert">{errorMessage(openError, t('openFailed'))}</div> : null}
    {content}
    {nav.data?.tree ? <div className="ct-tree-footer">{t('branch')} · {nav.data.tree.sessionIds?.length ?? paths.length} {familyPathsLabel(t, paths.length)}</div> : null}
  </section>
}

export function findAssistantRow(root, anchorKey) {
  if (!root || !anchorKey) return null
  const elements = root.querySelectorAll?.('[data-chat-anchor-key]') ?? []
  for (const element of elements) {
    if (element.getAttribute('data-chat-anchor-key') !== anchorKey) continue
    return element.closest?.('[data-chat-group-part="response"]') ?? element
  }
  return null
}

export function findAssistantMarkdownTarget(root, anchorKey) {
  if (!root || !anchorKey) return null
  const anchor = [...(root.querySelectorAll?.('[data-chat-anchor-key]') ?? [])]
    .find(element => element.getAttribute('data-chat-anchor-key') === anchorKey)
  if (!anchor) return null
  const row = anchor.closest?.('[data-chat-group-part="response"]') ?? anchor
  const candidates = []
  if (anchor.matches?.('[class*="markdown"]')) candidates.push(anchor)
  for (const element of anchor.querySelectorAll?.('[class*="markdown"]') ?? []) candidates.push(element)
  if (!candidates.length && row !== anchor) {
    for (const element of row.querySelectorAll?.('[class*="markdown"]') ?? []) candidates.push(element)
  }
  return candidates.find(candidate => !candidates.some(other => other !== candidate && other.contains?.(candidate))) ?? null
}

function findTurnTailCopy(root, turn) {
  if (turn == null) return null
  const turnValue = String(turn)
  for (const tail of root.querySelectorAll?.('[data-chat-flow-kind="turn-tail"][data-chat-turn]') ?? []) {
    if (tail.getAttribute('data-chat-turn') !== turnValue) continue
    const end = tail.querySelector?.('[data-clock="end"]')
    if (!end) continue
    return end.matches?.('button') ? end : end.querySelector?.('button') ?? null
  }
  return null
}

function restoreAssistantMount(mount) {
  if (!mount) return
  if (mount.container?.isConnected) mount.container.remove()
  if (mount.target?.isConnected) {
    mount.target.style.display = mount.targetDisplay
    if (mount.targetAria == null) mount.target.removeAttribute('aria-hidden')
    else mount.target.setAttribute('aria-hidden', mount.targetAria)
  }
  if (mount.copy?.isConnected) {
    mount.copy.style.display = mount.copyDisplay
    if (mount.copyAria == null) mount.copy.removeAttribute('aria-hidden')
    else mount.copy.setAttribute('aria-hidden', mount.copyAria)
  }
}

function AssistantTextSync({ sessionId, messageId, chat, text, turn }) {
  const [anchorKey, setAnchorKey] = useState(null)
  const [mount, setMount] = useState(null)
  const mountRef = useRef(null)
  useEffect(() => {
    const found = assistantNodeForMessage(chat, messageId)
    setAnchorKey(found?.key ?? null)
  }, [chat, messageId])
  useEffect(() => {
    if (text == null || !anchorKey || typeof document === 'undefined') {
      setMount(null)
      return undefined
    }
    let disposed = false
    let attempts = 0
    let timer = null
    const attempt = () => {
      if (disposed) return
      const target = findAssistantMarkdownTarget(document, anchorKey)
      const parent = target?.parentElement
      if (target && parent) {
        restoreAssistantMount(mountRef.current)
        const container = document.createElement('div')
        container.className = 'ct-effective-markdown'
        container.setAttribute('data-context-tree-effective-container', 'true')
        parent.insertBefore(container, target.nextSibling)
        const copy = findTurnTailCopy(document, turn)
        const created = {
          target,
          container,
          targetDisplay: target.style.display,
          targetAria: target.getAttribute('aria-hidden'),
          copy,
          copyDisplay: copy?.style.display,
          copyAria: copy?.getAttribute('aria-hidden'),
        }
        target.style.display = 'none'
        target.setAttribute('aria-hidden', 'true')
        if (copy) {
          copy.style.display = 'none'
          copy.setAttribute('aria-hidden', 'true')
        }
        mountRef.current = created
        setMount(created)
        return
      }
      if (attempts < 10) {
        attempts += 1
        timer = setTimeout(attempt, 40)
      }
    }
    attempt()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      restoreAssistantMount(mountRef.current)
      mountRef.current = null
    }
  }, [anchorKey, messageId, sessionId, text, turn])
  useEffect(() => {
    if (!mount || mount.copy || text == null || turn == null || typeof document === 'undefined') return undefined
    let disposed = false
    let attempts = 0
    let timer = null
    const attempt = () => {
      if (disposed || mount.copy) return
      const copy = findTurnTailCopy(document, turn)
      if (copy) {
        mount.copy = copy
        mount.copyDisplay = copy.style.display
        mount.copyAria = copy.getAttribute('aria-hidden')
        copy.style.display = 'none'
        copy.setAttribute('aria-hidden', 'true')
      } else if (attempts < 10) {
        attempts += 1
        timer = setTimeout(attempt, 40)
      }
    }
    attempt()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [mount, text, turn])
  if (!mount || text == null) return null
  return createPortal(<MarkdownText text={text} streaming={false} />, mount.container)
}

function CopyEffectiveText({ ctx, text }) {
  const t = useTranslator(ctx)
  const [status, setStatus] = useState(null)
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setStatus('ok')
    } catch {
      setStatus('error')
    }
  }
  return <span className="ct-inline-slot"><button type="button" className="ct-button" onClick={() => void copy()} disabled={!text}>{status === 'ok' ? t('copied') : t('copy')}</button>{status === 'error' ? <span className="ct-editor-error" role="alert">{t('copyFailed')}</span> : null}</span>
}

function AssistantActionsSlot({ ctx, sessionId, messageId, useSession, useChat }) {
  const t = useTranslator(ctx)
  const session = useHostSession(useSession)
  const chat = useHostChat(useChat)
  const nav = useNavigation(ctx, sessionId)
  const [editorKind, setEditorKind] = useState(null)
  const nodeInfo = assistantNodeForMessage(chat, messageId)
  const messageRow = latestMessageRow(nav.data?.messages, { messageId, role: 'assistant' })
  const turn = nodeInfo?.node?.location?.turn?.turn ?? messageRow?.turn
  const text = messageRow ? effectiveMessageText(nav.data?.messages, { messageId, role: 'assistant', turn }) : ''
  const patchedText = messageRow?.patched === true ? text : null
  const running = sessionIsRunning(session)
  const versions = versionInfo(nav.data?.assistant, turn)
  const openVersion = id => { if (id) void openSession(ctx, id) }
  return <div className="ct-inline-slot" data-context-tree-assistant-actions>
    <AssistantTextSync sessionId={sessionId} messageId={messageId} chat={chat} text={patchedText} turn={turn} />
    {patchedText != null ? <CopyEffectiveText ctx={ctx} text={text} /> : null}
    {!running && turn != null ? <>
      <button type="button" className="ct-button" onClick={() => setEditorKind('regenerate')}>{t('regenerate')}</button>
      <button type="button" className="ct-button" onClick={() => setEditorKind('edit-assistant')}>{t('editAssistant')}</button>
    </> : null}
    {versions ? <VersionButtons t={t} versions={versions} onOpen={openVersion} disabled={false} /> : null}
    {running ? <span className="ct-subtle">{t('runningLocked')}</span> : null}
    {editorKind ? <BranchEditor
      ctx={ctx}
      sessionId={sessionId}
      turn={turn}
      kind={editorKind}
      initialText={text}
      sourceRunning={running}
      onCancel={() => setEditorKind(null)}
      onComplete={() => setEditorKind(null)}
    /> : null}
  </div>
}

function TurnTailSlot({ ctx, sessionId, turn, useSession, useChat }) {
  const t = useTranslator(ctx)
  const session = useHostSession(useSession)
  const chat = useHostChat(useChat)
  const nav = useNavigation(ctx, sessionId)
  const turnNumber = typeof turn === 'object' ? turn?.turn : turn
  const content = extractTurnContent(chat, turnNumber)
  const running = sessionIsRunning(session) || !isClosedTurn(turn)
  const versions = versionInfo(nav.data?.user, turnNumber)
  const [editing, setEditing] = useState(false)
  return <div className="ct-inline-slot" data-context-tree-turn-tail-editor data-context-tree-turn={turnNumber}>
    {!running && !editing ? <button type="button" className="ct-button" onClick={() => setEditing(true)}>{t('editUser')}</button> : null}
    {!running && editing ? <BranchEditor
        ctx={ctx}
        sessionId={sessionId}
        turn={turnNumber}
        kind="edit-user"
        initialText={content.userText}
        hasAttachments={content.userHasAttachments}
        sourceRunning={running}
        onCancel={() => setEditing(false)}
        onComplete={() => setEditing(false)}
      /> : null}
    {versions ? <VersionButtons t={t} versions={versions} onOpen={id => { if (id) void openSession(ctx, id) }} disabled={false} /> : null}
    {running && !versions ? <span className="ct-subtle">{t('runningLocked')}</span> : null}
  </div>
}

function HeaderActionSlot({ ctx, actions, headerActions, autoChat }) {
  const t = useTranslator(ctx)
  const target = actions ?? headerActions
  useEffect(() => {
    if (autoChat) target?.setView?.('chat')
  }, [autoChat, target])
  return <button type="button" className="ct-button ct-quiet" data-context-tree-header-action onClick={() => target?.setView?.('chat')}>{t('headerChat')}</button>
}

function registerSlots(ctx) {
  const viewComponent = props => <ContextTreeView {...props} ctx={ctx} />
  const turnTailComponent = props => <TurnTailSlot {...props} ctx={ctx} />
  const assistantActionsComponent = props => <AssistantActionsSlot {...props} ctx={ctx} />
  const headerActionsComponent = props => <HeaderActionSlot {...props} ctx={ctx} />
  const label = () => translator(ctx)('label')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'branches', locale: 'contextTree', label, inject: (_sessionId, actions) => ({ viewActions: actions }) }, viewComponent))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'context-tree-user-editor', locale: 'contextTree', label }, turnTailComponent))
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'context-tree-assistant-actions', locale: 'contextTree', label }, assistantActionsComponent))
  ctx.slots.inject('conversation.session.header.actions', () => {
    const sessionStore = ctx.slots.entries('conversation.session')?.find(entry => entry.store)?.store
    return ctx.slots.register({ name: 'conversation.session.header.actions', id: 'context-tree-chat-return', locale: 'contextTree', label, store: sessionStore, inject: (sessionId, actions) => ({ headerActions: actions, autoChat: consumePendingChatSession(sessionId) }) }, headerActionsComponent)
  })
}

function installStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return noop
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE
  document.head.appendChild(style)
  return () => style.remove()
}

export function apply(ctx) {
  ctx.effect(() => {
    const localeDisposer = ctx.locale.register('contextTree', LOCALE)
    installSidebarTree(ctx)
    registerSlots(ctx)
    const removeStyles = installStyles()
    return () => {
      localeDisposer?.()
      removeStyles?.()
    }
  }, 'dsh-context-tree-clean-ui')
}
