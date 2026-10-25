import { useEffect, useMemo, useState } from 'react';
import { projectSidebar, projectStatuses } from './sidebar-tree.js';

const KEY = 'dsh-context-tree.sidebar-selection.v1';
function readRecord(key) {
  try { const value=JSON.parse(localStorage.getItem(key) ?? '{}');return value && typeof value==='object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}

export function wrapSidebar(NativeSidebar, connection) {
  return function TreeSidebar(props) {
    const raw = props.useSessions(state => state);
    const archived = props.useWorkspaces(state => state.archivedSessionIds);
    const [parents, setParents] = useState(() => readRecord(KEY + '.families'));
    const [selected, setSelected] = useState(() => readRecord(KEY));
    const identity = raw.ids.join('|');
    useEffect(() => {
      let disposed = false;
      const controller = new AbortController();
      connection.rpc.call('/dsh-context-tree', 'sidebar', {}, controller.signal).then(result => {
        if (!disposed && result?.ok) {
          setParents(result.value.parents);
          try { localStorage.setItem(KEY + '.families', JSON.stringify(result.value.parents)); } catch { /* Optional cold-start cache. */ }
        }
      }).catch(error => { if (!disposed) console.warn('context-tree sidebar grouping unavailable', error); });
      return () => { disposed=true;controller.abort(); };
    }, [identity]);
    const projected = useMemo(() => projectSidebar(raw, parents, selected, archived), [raw, parents, selected, archived]);
    useEffect(() => {
      const active = raw.ids.find(id => (raw.byId[id]?.retainedBy?.mainView ?? 0) > 0);
      const root = projected.rootOf[active];
      if (!root || (projected.families.get(root)?.length ?? 0) < 2 || selected[root] === active) return;
      const next = { ...selected, [root]: active };
      setSelected(next);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Session-only selection still works. */ }
    }, [raw, projected, selected]);
    const useTreeSessions = selector => selector(projected.list);
    const useTreeStatuses = selector => props.useSessionStatus(statuses => selector(projectStatuses(statuses, projected.families)));
    return <NativeSidebar {...props}
      useSessions={useTreeSessions}
      useSessionStatus={useTreeStatuses}
      open={id => props.open(projected.targets[id] ?? id)}
    />;
  };
}

export function installSidebarTree(ctx) {
  // DSH 0.2.1's slot API cannot shadow a component while borrowing its child
  // slots. Decorate the native entry to retain its renderSlot
  // ownership, injected hooks and store. Restore it on plugin disposal.
  ctx.slots.inject('sidebar.workspaces', () => {
    const original = ctx.slots.entriesOfSlot('sidebar.workspaces')[0];
    if (!original) throw new Error('context-tree sidebar requires the native workspace browser');
    const NativeSidebar = original.component;
    const TreeSidebar = wrapSidebar(NativeSidebar, ctx.connection);
    original.component = TreeSidebar;
    return () => { if (original.component === TreeSidebar) original.component = NativeSidebar; };
  });
}
