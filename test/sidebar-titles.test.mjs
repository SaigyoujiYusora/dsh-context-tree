import test from 'node:test';
import assert from 'node:assert/strict';
import { readSidebarTitles } from '../lib/sidebar-titles.js';
import { projectSidebar } from '../src/sidebar-tree.js';

test('recovers saved titles for cold sessions including imported IDs without opening an Agent', async () => {
  let requested;
  const ctx = { sessionQuery: {
    listSessions: async () => ['session-old', 'import-old', 'blank', 'unreadable'].map(id => ({ header: { id } })),
    readTitleSnapshots: async ids => {
      requested = ids;
      return [
        { status: 'fulfilled', value: { session: { id: 'session-old', createdAt: 1 }, title: { title: 'Saved title' } } },
        { status: 'fulfilled', value: { session: { id: 'import-old', createdAt: 2 }, title: { title: 'Imported title' } } },
        { status: 'fulfilled', value: { session: { id: 'blank', createdAt: 3 } } },
        { status: 'rejected', reason: Error('unreadable') },
      ];
    },
  } };
  const result = await readSidebarTitles(ctx, { ids: ['session-old', 'import-old', 'blank', 'unreadable', 'unknown', 'session-old'] });
  assert.deepEqual(requested, ['session-old', 'import-old', 'blank', 'unreadable']);
  assert.deepEqual({ ...result.titles }, { 'session-old': { title: 'Saved title', createdAt: 1 }, 'import-old': { title: 'Imported title', createdAt: 2 } });
  await assert.rejects(readSidebarTitles(ctx, { ids: Array(65).fill('session-old') }), /Invalid/);
});

test('title fallback preserves live titles, blank rows, lifecycle boundaries and source state', () => {
  const rows = [
    { id: 'cold', createdAt: 1, cwd: 'test' },
    { id: 'renamed', createdAt: 1, cwd: 'test', title: 'New title' },
    { id: 'recreated', createdAt: 2, cwd: 'test' },
    { id: 'blank', createdAt: 1, cwd: 'test', blank: true },
    { id: 'unnamed', createdAt: 1, cwd: 'test' },
  ];
  const source = { ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])) };
  const before = structuredClone(source);
  const titles = Object.fromEntries(['cold', 'renamed', 'recreated', 'blank'].map(id => [id, { createdAt: 1, title: 'Saved title' }]));
  const result = projectSidebar(source, {}, {}, [], titles);
  assert.equal(result.list.byId.cold.title, 'Saved title');
  assert.equal(result.list.byId.renamed.title, 'New title');
  for (const id of ['recreated', 'blank', 'unnamed']) assert.equal(result.list.byId[id].title, undefined);
  assert.deepEqual(source, before);
});

test('a grouped root retains its recovered title', () => {
  const source = { ids: ['root', 'child'], byId: {
    root: { id: 'root', createdAt: 1, cwd: 'test' },
    child: { id: 'child', createdAt: 2, cwd: 'test', title: 'Child title' },
  } };
  const result = projectSidebar(source, { child: 'root' }, {}, [], { root: { createdAt: 1, title: 'Root title' } });
  assert.deepEqual(result.list.ids, ['root']);
  assert.equal(result.list.byId.root.title, 'Root title');
});

test('native summaries without createdAt recover only the requested list revision', () => {
  const source = { ids: ['old'], byId: { old: { id: 'old', updatedAt: 120, cwd: 'test' } } };
  const recovered = { old: { title: 'Persisted title', createdAt: 100, listUpdatedAt: 120 } };
  assert.equal(projectSidebar(source, {}, {}, [], recovered).list.byId.old.title, 'Persisted title');
  source.byId.old.updatedAt = 150;
  assert.equal(projectSidebar(source, {}, {}, [], recovered).list.byId.old.title, undefined);
  recovered.old.listUpdatedAt = 150;
  recovered.old.createdAt = 200;
  assert.equal(projectSidebar(source, {}, {}, [], recovered).list.byId.old.title, undefined);
});
