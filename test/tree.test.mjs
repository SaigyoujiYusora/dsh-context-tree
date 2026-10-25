import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assistantNodeForMessage,
  effectiveMessageText,
  extractTurnContent,
  flattenTree,
  terminalIds,
  terminalLabel,
  versionInfo,
} from '../src/tree.js'

test('flattenTree keeps shared nodes once and preserves child order', () => {
  const tree = {
    children: [
      { id: 'u1', role: 'user', text: 'first', sessionIds: ['s1', 's2'], children: [
        { id: 'a1', role: 'assistant', text: 'one', terminalSessionIds: ['s1'] },
        { id: 'a2', role: 'assistant', text: 'two', terminalSessionIds: ['s2'] },
      ] },
    ],
  }
  assert.deepEqual(flattenTree(tree).map(row => row.id), ['u1', 'a1', 'a2'])
  assert.deepEqual(terminalIds(tree), ['s1', 's2'])
  assert.match(terminalLabel(tree, 's2'), /two/)
})

test('effectiveMessageText chooses the greatest sequence for a message', () => {
  const rows = [
    { role: 'assistant', messageId: 'm1', turn: 2, seq: 1, text: 'draft' },
    { role: 'assistant', messageId: 'm1', turn: 2, seq: 4, text: 'effective' },
    { role: 'assistant', messageId: 'm2', turn: 2, seq: 9, text: 'other' },
  ]
  assert.equal(effectiveMessageText(rows, { messageId: 'm1', role: 'assistant' }), 'effective')
})

test('extractTurnContent uses the final assistant step and reports attachments', () => {
  const chat = {
    locations: { getTurn: () => ['u', 'a1', 'a2'] },
    nodes: new Map([
      ['u', { kind: 'user', data: { content: [{ type: 'text', text: 'hello' }, { type: 'image', url: 'x' }] } }],
      ['a1', { kind: 'assistant-step', location: { turn: { turn: 3 } }, data: { blocks: [{ kind: 'text', text: 'old' }], finalNode: { messageId: 'm', seq: 1 } } }],
      ['a2', { kind: 'assistant-step', location: { turn: { turn: 3 } }, data: { blocks: [{ kind: 'text', text: 'new' }], finalNode: { messageId: 'm', seq: 2 } } }],
    ]),
  }
  assert.deepEqual(extractTurnContent(chat, 3), {
    userText: 'hello',
    userHasAttachments: true,
    assistantText: 'new',
    assistantMessageId: 'm',
    assistantNodeKey: 'a2',
  })
})

test('versionInfo exposes only adjacent versions', () => {
  assert.deepEqual(versionInfo({ 4: { ids: ['a', 'b', 'c'], index: 1 } }, 4), {
    ids: ['a', 'b', 'c'], index: 1, previous: 'a', next: 'c',
  })
  assert.equal(versionInfo({}, 4), null)
})

test('assistantNodeForMessage supports the host values/get store without entries', () => {
  const chat = {
    nodes: {
      get: () => undefined,
      values: function* values() {
        yield { key: '14:assistant-step2:1', kind: 'assistant-step', data: { finalNode: { messageId: 'm2', seq: 3 } } }
      },
    },
  }
  assert.equal(assistantNodeForMessage(chat, 'm2')?.key, '14:assistant-step2:1')
})
