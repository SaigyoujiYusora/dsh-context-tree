import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidebarTitleLoader } from '../src/sidebar-title-loader.js';

test('opening an empty session reuses finished and pending reads rather than rescanning history', async () => {
  const calls = [], requests = Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, updatedAt: 10 }));
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const loader = createSidebarTitleLoader({ rpc: { call: async (_path, _method, { ids }) => {
    calls.push(ids); await gate;
    return { ok: true, value: { titles: Object.fromEntries(ids.map(id => [id, { title: id === 's0' ? null : id, createdAt: 1 }])) } };
  } } });
  const first = loader.load(requests);
  const afterOpeningBlank = loader.load(requests.slice(1));
  resume();
  const [all, later] = await Promise.all([first, afterOpeningBlank]);
  assert.equal(all.s0.title, null);
  assert.equal(later.s8.title, 's8');
  assert.deepEqual(calls.flat(), requests.map(item => item.id));
  assert.ok(calls.every(ids => ids.length <= 4));
  await loader.load(requests);
  assert.equal(calls.length, 3);
  await loader.load([{ id: 's0', updatedAt: 11 }]);
  assert.equal(calls.length, 4);
  loader.dispose();
});

test('unreadable sessions can retry; confirmed absent titles remain cached', async () => {
  let count = 0;
  const loader = createSidebarTitleLoader({ rpc: { call: async () => {
    count++;
    return { ok: true, value: { titles: count === 1 ? {} : { empty: { title: null, createdAt: 1 } } } };
  } } });
  const request = [{ id: 'empty', updatedAt: 2 }];
  await loader.load(request); await loader.load(request); await loader.load(request);
  assert.equal(count, 2);
  loader.dispose();
});

test('disposing the sidebar aborts active reads and settles queued work', async () => {
  let calls = 0;
  const loader = createSidebarTitleLoader({ rpc: { call: async (_path, _method, _payload, signal) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } });
  const pending = loader.load(Array.from({ length: 10 }, (_, i) => ({ id: String(i), updatedAt: 1 })));
  const rejected = assert.rejects(pending);
  loader.dispose();
  await rejected;
  assert.equal(calls, 1);
  assert.deepEqual(await loader.load([{ id: 'late', updatedAt: 1 }]), {});
});
