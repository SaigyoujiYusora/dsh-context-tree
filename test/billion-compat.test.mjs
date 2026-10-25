import test from 'node:test';
import assert from 'node:assert/strict';
import { installBillionCompatibility, BILLION_STATE } from '../lib/billion-compat.js';
import { chooseAlignment } from '../lib/fork-alignment.js';
import { projectWire, identityHash } from '../lib/billion-wire.js';

const endpoint = 'https://model.example/v1/chat/completions';
const parent = 'session-parent', child = 'session-child';
const original = { model: 'fixture', messages: [
  { role: 'user', content: 'shared prompt' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
  { role: 'tool', tool_call_id: 'call-1', content: 'result' },
] };
const variant = () => ({ ...structuredClone(original), messages: [
  { role: 'user', content: [{ type: 'text', text: 'shared ' }, { type: 'text', text: 'prompt' }] },
  { ...structuredClone(original.messages[1]), content: ' ' },
  original.messages[2],
  { role: 'assistant', content: '', reasoning_content: 'private reasoning for the new tail' },
  { role: 'user', content: 'new branch tail' },
] });
const identities = projectWire(original).core.map(message => ({ identityHash: identityHash(message) }));
const snapshot = { protocolVersion: 2, orderedMessages: identities };
function fixture({ childExists = false, protocol = 2, failure = false, owned = true, phase = 'ready' } = {}) {
  const calls = [], forwarded = [];
  let reads = 0;
  const session = {
    id: child, header: { parentSession: parent, isSeeded: true },
    snapshotEvents: () => { reads++; return owned ? [{ type: 'plugin:dsh-context-tree/branch', data: { sessionId: child, parentId: parent, phase } }] : []; },
  };
  const ctx = { agents: { currentInitiator: () => ({ session }) } };
  const state = { origin: 'http://127.0.0.1:12345', beforeSend: async (_url, init) => { forwarded.push(init.body); return 'original hook'; } };
  const globals = { [BILLION_STATE]: state };
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    if (failure) throw Error('offline');
    if (url.endsWith('/manifest')) return Response.json({ capabilities: { fork: { protocolVersion: protocol } } });
    if (url.includes(encodeURIComponent(child)) && !childExists) return new Response('', { status: 404 });
    return Response.json(snapshot);
  };
  const dispose = installBillionCompatibility(ctx, { globals, fetchImpl, log() {} });
  return { ctx, state, globals, calls, forwarded, fetchImpl, dispose, reads: () => reads };
}

test('transport differences align before the original hook; new tail and source stay unchanged', async () => {
  const f = fixture(), body = variant(), before = JSON.stringify(body);
  const init = { body: before, headers: { 'content-length': '1' } };
  assert.equal(await f.state.beforeSend(endpoint, init), 'original hook');
  const aligned = JSON.parse(init.body);
  assert.deepEqual(aligned.messages.slice(0, 3), original.messages);
  assert.deepEqual(aligned.messages.slice(3), body.messages.slice(3));
  assert.equal(JSON.stringify(body), before);
  assert.equal(init.headers.has('content-length'), false);
  assert.equal(f.forwarded[0], init.body);
  f.dispose();
});

test('changed tool arguments cut the matching prefix', () => {
  const body = variant(); body.messages[1].tool_calls[0].function.arguments = '{"path":"changed"}';
  const result = chooseAlignment(body, identities, projectWire, identityHash);
  assert.equal(result.count, 1);
  assert.deepEqual(result.body.messages[1], body.messages[1]);
});

test('existing child snapshot is authoritative; unsupported protocol and network failure preserve body', async () => {
  const f = fixture({ childExists: true });
  await f.state.beforeSend(endpoint, { body: JSON.stringify(variant()) });
  assert.ok(f.calls.some(url => url.includes(child)));
  assert.ok(!f.calls.some(url => url.includes(parent)));
  f.dispose();
  for (const options of [{ protocol: 3 }, { failure: true }]) {
    const g = fixture(options), bytes = JSON.stringify(variant()), init = { body: bytes };
    await g.state.beforeSend(endpoint, init);
    assert.equal(init.body, bytes); assert.equal(g.forwarded.length, 1); g.dispose();
  }
});

test('native forks, nonlocal proxy, other protocols, signed requests and side tasks are untouched', async () => {
  for (const kind of ['native', 'remote', 'anthropic', 'signed', 'side', 'responses', 'abort']) {
    const f = fixture({ owned: kind !== 'native' });
    if (kind === 'remote') f.state.origin = 'https://remote.example';
    const body = variant();
    if (kind === 'anthropic') body.system = 'prompt';
    if (kind === 'side') body.max_tokens = 100;
    const bytes = JSON.stringify(body), init = { body: bytes };
    if (kind === 'signed') init.headers = { authorization: 'AWS4-HMAC-SHA256 credentials' };
    if (kind === 'abort') init.signal = AbortSignal.abort();
    await f.state.beforeSend(kind === 'responses' ? endpoint.replace('chat/completions', 'responses') : endpoint, init);
    assert.equal(init.body, bytes, kind); assert.equal(f.calls.length, 0, kind); f.dispose();
  }
});

test('plugin works when loaded before Billion; replacement and unload restore original hooks', async () => {
  const f = fixture(), initial = f.state.beforeSend;
  const replacementHook = async () => 'replacement';
  const replacement = { origin: f.state.origin, beforeSend: replacementHook };
  f.globals[BILLION_STATE] = replacement;
  assert.notEqual(replacement.beforeSend, replacementHook);
  f.dispose();
  assert.equal(replacement.beforeSend, replacementHook);
  assert.equal(f.globals[BILLION_STATE], replacement);
  assert.equal(Object.getOwnPropertyDescriptor(f.globals, BILLION_STATE).get, undefined);
  assert.notEqual(f.state.beforeSend, initial);
  const empty = {}, off = installBillionCompatibility(f.ctx, { globals: empty, fetchImpl: f.fetchImpl, log() {} });
  const late = { origin: replacement.origin, beforeSend: replacementHook };
  empty[BILLION_STATE] = late;
  assert.notEqual(late.beforeSend, replacementHook);
  off(); assert.equal(late.beforeSend, replacementHook);
});

test('unload does not overwrite a later hook owner; unsupported accessors remain untouched', () => {
  const f = fixture(), later = () => {};
  f.state.beforeSend = later; f.dispose(); assert.equal(f.state.beforeSend, later);
  const globals = {};
  const get = () => f.state;
  Object.defineProperty(globals, BILLION_STATE, { configurable: true, get });
  installBillionCompatibility(f.ctx, { globals, log() {} })();
  assert.equal(Object.getOwnPropertyDescriptor(globals, BILLION_STATE).get, get);
});

test('the first request works before ready, and branch provenance is read only once', async () => {
  const f = fixture({ phase: 'prepared' });
  for (let i = 0; i < 2; i++) {
    const init = { body: JSON.stringify(variant()) };
    await f.state.beforeSend(endpoint, init);
    assert.deepEqual(JSON.parse(init.body).messages.slice(0, 3), original.messages);
    assert.equal(init.headers, undefined);
  }
  assert.equal(f.reads(), 1);
  f.dispose();
});

test('Billion delete-and-reload lifecycle reattaches without resurrecting its old state', async () => {
  const f = fixture(), originalHook = async () => {};
  delete f.globals[BILLION_STATE];
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.globals[BILLION_STATE], undefined);
  const state = { origin: f.state.origin, beforeSend: originalHook };
  f.globals[BILLION_STATE] = state;
  assert.notEqual(state.beforeSend, originalHook);
  f.dispose(); assert.equal(state.beforeSend, originalHook);
});

test('distinct messages and unsupported media do not form a false common prefix', () => {
  const separate = { messages: [{ role: 'user', content: 'shared ' }, { role: 'user', content: 'prompt' }] };
  assert.equal(chooseAlignment(separate, identities, projectWire, identityHash).count, 0);
  const media = variant(); media.messages[0].content.push({ type: 'image_url', image_url: { url: 'data:fixture' } });
  assert.equal(chooseAlignment(media, identities, projectWire, identityHash).count, 0);
});
