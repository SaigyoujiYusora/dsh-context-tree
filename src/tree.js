/** Pure client-side derivations shared by the message tree and its tests. */

/** Count persisted sessions, visible messages, and actual fork points. */
export function conversationTreeStats(tree) {
  if (tree === null) return { sessions: 0, messages: 0, forks: 0 }
  let messages = 0
  let forks = tree.children.length > 1 ? 1 : 0
  const walk = node => {
    messages++
    if (node.children.length > 1) forks++
    for (const child of node.children) walk(child)
  }
  for (const child of tree.children) walk(child)
  return { sessions: tree.sessionIds.length, messages, forks }
}

function nodeTurn(node) {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step'
    ? location.turn?.turn
    : undefined
}

function joinedText(blocks, kind) {
  return blocks
    .filter(block => block[kind.key] === kind.value && typeof block.text === 'string')
    .map(block => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Visible user prose for a completed turn, excluding attachments. */
export function turnUserText(snapshot, turn) {
  const keys = snapshot.chat.locations.getTurn(turn)
  for (const key of keys) {
    const node = snapshot.chat.nodes.get(key)
    if (node.kind === 'user' && nodeTurn(node) === turn) {
      return joinedText(node.data.content, { key: 'type', value: 'text' })
    }
  }
  return ''
}

/** Chat anchor key for the user bubble that owns a completed turn. */
export function turnUserNodeKey(snapshot, turn) {
  const keys = snapshot.chat.locations.getTurn(turn)
  for (const key of keys) {
    const node = snapshot.chat.nodes.get(key)
    if (node.kind === 'user' && nodeTurn(node) === turn) return key
  }
}

/** Persisted event identity of the prompt shown by the inline editor. */
export function turnUserSeq(snapshot, turn) {
  const key = turnUserNodeKey(snapshot, turn)
  return snapshot.chat.nodes.get(key)?.data.seq
}

function assistantMessageNode(snapshot, messageId) {
  for (const node of snapshot.chat.nodes.values()) {
    if (node.kind === 'assistant-step' && node.data.finalNode?.messageId === messageId) {
      return node
    }
  }
}

/** Turn addressed by the finalized assistant message action strip. */
export function assistantMessageTurn(snapshot, messageId) {
  return nodeTurn(assistantMessageNode(snapshot, messageId))
}

/** Chat anchor key for the finalized assistant message action strip. */
export function assistantMessageNodeKey(snapshot, messageId) {
  return assistantMessageNode(snapshot, messageId)?.key
}

/** Locate one exact rendered Chat row by its stable conversation node key. */
export function findMessageEditSeat(root, nodeKey) {
  for (const row of root.querySelectorAll('[data-chat-anchor-key]')) {
    if (row.getAttribute('data-chat-anchor-key') === nodeKey) return row
  }
  return null
}

/** Locate the native IconActions row below one exact user message bubble. */
export function findUserActionSeat(root, nodeKey) {
  return findMessageEditSeat(root, nodeKey)
    ?.querySelector('[data-slot="conversation.chat.node"]')?.firstElementChild?.lastElementChild ?? null
}

/** Final visible assistant prose for a completed turn. */
export function turnAssistantText(snapshot, turn) {
  const keys = snapshot.chat.locations.getTurn(turn)
  let closing
  for (const key of keys) {
    const node = snapshot.chat.nodes.get(key)
    if (node.kind !== 'assistant-step' || nodeTurn(node) !== turn
      || node.data.finalNode === undefined || !Array.isArray(node.data.blocks)) continue
    if (closing === undefined || node.data.finalNode.seq > closing.finalNode.seq) closing = node.data
  }
  return closing === undefined ? '' : joinedText(closing.blocks, { key: 'kind', value: 'text' })
}
