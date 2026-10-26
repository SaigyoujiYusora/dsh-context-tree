// Sidebar-only projection. Never replace the shared Session registry.
export function projectSidebar(list, parents, selected = {}, archived = [], titles = {}) {
  const archivedSet = new Set(archived);
  const rootOf = {};
  const families = new Map();
  for (const id of list.ids) {
    let root = id;
    const seen = new Set([id]);
    while (!archivedSet.has(id) && parents[root] && list.byId[parents[root]] && !archivedSet.has(parents[root])) {
      const parent = parents[root];
      // A corrupt cycle must never hide rows. Cross-workspace branches stay separate.
      if (seen.has(parent)) { root = id; break; }
      if (list.byId[parent].cwd !== list.byId[id]?.cwd) break;
      seen.add(parent); root = parent;
    }
    rootOf[id] = root;
    if (!families.has(root)) families.set(root, []);
    families.get(root).push(id);
  }
  const byId = { ...list.byId };
  for (const id of list.ids) {
    const row = byId[id], saved = titles[id];
    // Native list summaries expose updatedAt, but not createdAt. Bind the
    // fallback to the requested list revision and reject an older lifecycle.
    const current = saved && row.updatedAt === saved.listUpdatedAt && row.updatedAt >= saved.createdAt;
    if (!row.blank && !row.title?.trim() && saved?.title?.trim() && current) byId[id] = { ...row, title: saved.title };
  }
  const targets = {};
  for (const [root, ids] of families) {
    if (ids.length < 2) continue;
    const active = ids.find(id => (list.byId[id]?.retainedBy?.mainView ?? 0) > 0);
    const remembered = ids.includes(selected[root]) && !archivedSet.has(selected[root]) ? selected[root] : root;
    targets[root] = active ?? remembered;
    const rows = ids.map(id => list.byId[id]);
    byId[root] = {
      ...byId[root],
      updatedAt: Math.max(...rows.map(row => row.updatedAt ?? 0)),
      running: rows.some(row => row.running),
      retainedBy: { ...byId[root].retainedBy, mainView: active ? 1 : 0 },
    };
    for (const id of ids) if (id !== root) delete byId[id];
  }
  return { list: { ...list, ids: list.ids.filter(id => byId[id]), byId }, rootOf, families, targets };
}

export function projectStatuses(statuses, families) {
  const next = new Map(statuses);
  for (const [root, ids] of families) {
    if (ids.length < 2) continue;
    const values = ids.map(id => statuses.get(id)).filter(Boolean);
    if (!values.length) continue;
    const busy = values.find(value => value.pendingKind) ?? values.find(value => value.running);
    next.set(root, { ...(busy ?? statuses.get(root) ?? values[0]), running: values.some(value => value.running) });
  }
  return next;
}
