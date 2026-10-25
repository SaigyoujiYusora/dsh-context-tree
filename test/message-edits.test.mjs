import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, appendPluginRecord, deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session';
import { applyTargetsToMessage, createMessageProjection } from '../lib/message-edits.js';

const RECORD_TYPE = 'plugin:dsh-context-tree/edit';
const projection = createMessageProjection(RECORD_TYPE);

function message(content, role = 'assistant') {
  return {
    id: 'answer-1',
    role,
    source: {kind: 'model', provider: 'fixture', model: 'fixture'},
    attachments: [{id: 'attachment-1', name: 'trace.json'}],
    toolCalls: [{id: 'tool-1', name: 'lookup'}],
    content,
  };
}

function answerEvent(answer = message([{type: 'text', text: 'before'}])) {
  return {
    turn: 1,
    step: 1,
    message: answer,
    stream: [],
  };
}

function session(answer = message([{type: 'text', text: 'before'}])) {
  const source = Session.create('message-edits', undefined, undefined, 0, [projection]);
  source.append('assistant/message', answerEvent(answer), {surfaceOp: 'append'});
  return source;
}

function projected(source) {
  const events = source.snapshotEvents();
  const answer = events.find(event => event.type === 'assistant/message');
  const surface = foldSurface(events, [projection]);
  return deriveEventMessage(answer, surface.projectedMessages);
}

test('applyTargetsToMessage is pure and preserves message and block metadata', () => {
  const original = message([
    {type: 'text', text: 'before', citations: ['cite-1']},
    {type: 'image', url: 'image://one', alt: 'kept'},
    {type: 'thinking', text: 'reasoning before', signature: 'sig-1'},
  ]);
  const before = structuredClone(original);
  const result = applyTargetsToMessage(original, [
    {blockIndex: 0, kind: 'text', text: 'after'},
    {blockIndex: 2, kind: 'reasoning', text: 'reasoning after'},
  ]);

  assert.deepEqual(original, before);
  assert.notStrictEqual(result, original);
  assert.equal(result.id, original.id);
  assert.equal(result.source, original.source);
  assert.equal(result.attachments, original.attachments);
  assert.equal(result.toolCalls, original.toolCalls);
  assert.deepEqual(result.content, [
    {type: 'text', text: 'after', citations: ['cite-1']},
    original.content[1],
    {type: 'thinking', text: 'reasoning after', signature: 'sig-1'},
  ]);
});

test('later targets for the same block win in order', () => {
  const original = message([{type: 'text', text: 'before'}]);
  const result = applyTargetsToMessage(original, [
    {blockIndex: 0, kind: 'text', text: 'first'},
    {blockIndex: 0, kind: 'text', text: 'last'},
  ]);
  assert.equal(result.content[0].text, 'last');
  assert.equal(original.content[0].text, 'before');
});

test('invalid targets and non-assistant messages are unchanged', () => {
  const original = message([
    {type: 'text', text: 'before'},
    {type: 'image', url: 'image://one'},
  ]);
  const invalid = [
    null,
    {blockIndex: -1, kind: 'text', text: 'bad'},
    {blockIndex: 0, kind: 'reasoning', text: 'wrong kind'},
    {blockIndex: 1, kind: 'text', text: 'non-text'},
    {blockIndex: 0, kind: 'text', text: 42},
    {seq: 'future', blockIndex: 0, kind: 'text', text: 'bad seq'},
  ];
  assert.strictEqual(applyTargetsToMessage(original, invalid), original);
  assert.deepEqual(applyTargetsToMessage({...original, role: 'user'}, [invalid[1]]), {...original, role: 'user'});
});

test('projection applies compatible edits while preserving assistant identity and non-text content', () => {
  const source = session(message([
    {type: 'text', text: 'before', citations: ['cite-1']},
    {type: 'tool-call', id: 'tool-1', name: 'lookup'},
    {type: 'reasoning', text: 'reasoning before', signature: 'sig-1'},
  ]));
  appendPluginRecord(source, RECORD_TYPE, {
    version: 1,
    targets: [
      {seq: 0, blockIndex: 0, kind: 'text', text: 'after'},
      {seq: 0, blockIndex: 2, kind: 'reasoning', text: 'reasoning after'},
    ],
  });
  const result = projected(source);
  assert.equal(result.id, 'answer-1');
  assert.deepEqual(result.source, {kind: 'model', provider: 'fixture', model: 'fixture'});
  assert.deepEqual(result.attachments, [{id: 'attachment-1', name: 'trace.json'}]);
  assert.deepEqual(result.toolCalls, [{id: 'tool-1', name: 'lookup'}]);
  assert.deepEqual(result.content, [
    {type: 'text', text: 'after', citations: ['cite-1']},
    {type: 'tool-call', id: 'tool-1', name: 'lookup'},
    {type: 'reasoning', text: 'reasoning after', signature: 'sig-1'},
  ]);
});

test('sequential plugin records keep the later edit', () => {
  const source = session();
  appendPluginRecord(source, RECORD_TYPE, {version: 1, targets: [{seq: 0, blockIndex: 0, kind: 'text', text: 'first'}]});
  appendPluginRecord(source, RECORD_TYPE, {version: 1, targets: [{seq: 0, blockIndex: 0, kind: 'text', text: 'last'}]});
  assert.equal(source.deriveMessages()[0].content[0].text, 'last');
});

test('future, missing, and compressed assistant sequences do not get projected', () => {
  const future = session();
  appendPluginRecord(future, RECORD_TYPE, {
    version: 1,
    targets: [
      {seq: 2, blockIndex: 0, kind: 'text', text: 'future'},
      {seq: 999, blockIndex: 0, kind: 'text', text: 'missing'},
    ],
  });
  assert.equal(projected(future).content[0].text, 'before');

  const compressed = session();
  compressed.append('developer/message', {
    turn: 1,
    message: {id: 'summary', role: 'developer', source: {kind: 'compaction'}, content: [{type: 'text', text: 'summary'}]},
  }, {surfaceOp: {op: 'replace', startSeq: 0, endSeq: 0}, sourceEventSeqs: [0]});
  appendPluginRecord(compressed, RECORD_TYPE, {
    version: 1,
    targets: [{seq: 0, blockIndex: 0, kind: 'text', text: 'must not apply'}],
  });
  const events = compressed.snapshotEvents();
  const surface = foldSurface(events, [projection]);
  assert.deepEqual(surface.nodes, [1]);
  assert.equal(surface.projectedMessages.size, 0);
});

test('unknown versions and malformed records are rejected instead of applied', () => {
  const source = session();
  assert.throws(() => appendPluginRecord(source, RECORD_TYPE, {
    version: 2,
    targets: [{seq: 0, blockIndex: 0, kind: 'text', text: 'bad'}],
  }), /unsupported message edit record version/);

  const missingTargets = session();
  assert.throws(() => appendPluginRecord(missingTargets, RECORD_TYPE, {version: 1}), /targets must be an array/);

  const invalidTarget = session();
  assert.throws(() => appendPluginRecord(invalidTarget, RECORD_TYPE, {
    version: 1,
    targets: [{seq: 'not-a-seq', blockIndex: 0, kind: 'text', text: 'bad'}],
  }), /invalid target/);
});

