const EMPTY = []

function list(value) {
  return Array.isArray(value) ? value : EMPTY
}

export function textValue(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return String(value)
}

export function previewText(value, limit = 96) {
  const text = textValue(value).replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

export function flattenTree(tree) {
  const rows = []
  const seen = new Set()
  const roots = [...list(tree?.children)]
  if (!roots.length && tree?.id) roots.push(tree)

  const visit = (node, depth, parentId) => {
    if (!node || typeof node !== 'object') return
    const id = textValue(node.id) || `${parentId ?? 'root'}:${rows.length}`
    if (seen.has(id)) return
    seen.add(id)
    rows.push({ node, depth, id, parentId })
    for (const child of list(node.children)) visit(child, depth + 1, id)
  }
  roots.forEach(node => visit(node, 0, null))
  return rows
}

export function terminalIds(tree) {
  const direct = list(tree?.terminalSessionIds).filter(Boolean)
  if (direct.length) return [...new Set(direct)]
  const ids = []
  for (const { node } of flattenTree(tree)) {
    for (const id of list(node.terminalSessionIds)) if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

export function nodeIncludesSession(node, sessionId) {
  if (!node || !sessionId) return false
  return node.id === sessionId || list(node.sessionIds).includes(sessionId) || list(node.terminalSessionIds).includes(sessionId)
}

export function deepestNodeForSession(tree, sessionId) {
  let result = null
  for (const row of flattenTree(tree)) {
    if (nodeIncludesSession(row.node, sessionId)) result = row
  }
  return result
}

export function terminalLabel(tree, sessionId) {
  const row = deepestNodeForSession(tree, sessionId)
  if (!row) return previewText(sessionId, 24) || '未命名分支'
  const role = row.node.role === 'assistant' ? '回答' : '提问'
  return `${role}：${previewText(row.node.text, 58) || '（无文本）'}`
}

export function latestMessageRow(messages, criteria = {}) {
  const rows = list(messages).filter(row => {
    if (!row || typeof row !== 'object') return false
    if (criteria.role && row.role !== criteria.role) return false
    if (criteria.turn != null && row.turn !== criteria.turn) return false
    if (criteria.messageId && row.messageId !== criteria.messageId) return false
    return true
  })
  return rows.reduce((latest, row) => {
    if (!latest || Number(row.seq ?? 0) >= Number(latest.seq ?? 0)) return row
    return latest
  }, null)
}

export function effectiveMessageText(messages, criteria = {}) {
  return textValue(latestMessageRow(messages, criteria)?.text)
}

export function extractTurnContent(chat, turn) {
  const result = { userText: '', userHasAttachments: false, assistantText: '', assistantMessageId: null, assistantNodeKey: null }
  const locations = chat?.locations?.getTurn?.(turn)
  const keys = list(locations)
  const nodes = chat?.nodes
  const readNode = key => nodes?.get?.(key) ?? nodes?.[key]
  let bestAssistant = null
  for (const key of keys) {
    const node = readNode(key)
    if (!node) continue
    if (node.kind === 'user') {
      for (const item of list(node.data?.content)) {
        if (item?.type === 'text') result.userText += textValue(item.text)
        else if (item) result.userHasAttachments = true
      }
    }
    if (node.kind === 'assistant-step') {
      const seq = Number(node.data?.finalNode?.seq ?? -1)
      if (!bestAssistant || seq >= bestAssistant.seq) bestAssistant = { node, key, seq }
    }
  }
  if (bestAssistant) {
    result.assistantMessageId = bestAssistant.node.data?.finalNode?.messageId ?? null
    result.assistantNodeKey = bestAssistant.key
    result.assistantText = list(bestAssistant.node.data?.blocks)
      .filter(block => block?.kind === 'text')
      .map(block => textValue(block.text))
      .join('')
  }
  return result
}

export function assistantNodeForMessage(chat, messageId) {
  const nodes = chat?.nodes
  if (!nodes || !messageId) return null
  let entries
  if (nodes instanceof Map && typeof nodes.entries === 'function') {
    entries = nodes.entries()
  } else if (typeof nodes.values === 'function') {
    entries = [...nodes.values()].map(node => [node?.key, node])
  } else if (typeof nodes.entries === 'function') {
    entries = nodes.entries()
  } else {
    entries = Object.entries(nodes)
  }
  let result = null
  let fallbackIndex = 0
  for (const [key, node] of entries) {
    if (node?.kind !== 'assistant-step' || node.data?.finalNode?.messageId !== messageId) continue
    const seq = Number(node.data?.finalNode?.seq ?? -1)
    const nodeKey = node.key ?? key ?? `assistant-step:${fallbackIndex}`
    fallbackIndex += 1
    if (!result || seq >= result.seq) result = { key: nodeKey, node, seq }
  }
  return result
}

export function versionInfo(groups, turn) {
  const group = groups?.[turn] ?? groups?.[String(turn)]
  if (!group || !Array.isArray(group.ids)) return null
  const index = Math.max(0, Math.min(Number(group.index ?? 0), group.ids.length - 1))
  return { ids: [...group.ids], index, previous: group.ids[index - 1] ?? null, next: group.ids[index + 1] ?? null }
}

export function isClosedTurn(turn) {
  return turn?.status === 'closed'
}
