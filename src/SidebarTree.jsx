import { useEffect, useMemo, useRef, useState } from 'react';
import { projectSidebar, projectStatuses } from './sidebar-tree.js';
import { createSidebarTitleLoader } from './sidebar-title-loader.js';

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
    const [titles, setTitles] = useState({});
    const titleLoader = useRef(null);
    useEffect(() => {
      const loader = createSidebarTitleLoader(connection);
      titleLoader.current = loader;
      return () => { loader.dispose(); if (titleLoader.current === loader) titleLoader.current = null; };
    }, [connection]);
    const missingTitles = raw.ids.filter(id => !raw.byId[id].blank && !raw.byId[id].title?.trim());
    const titleIdentity = JSON.stringify(missingTitles.map(id => [id, raw.byId[id].updatedAt]));
    useEffect(() => {
      let disposed = false;
      const loader = titleLoader.current;
      const load = async () => {
        if (!loader) return;
        const recovered = await loader.load(missingTitles.map(id => ({ id, updatedAt: raw.byId[id].updatedAt })));
        if (!disposed) setTitles(previous => ({ ...previous, ...recovered }));
      };
      void load().catch(error => { if (!disposed) console.warn('context-tree title recovery unavailable', error); });
      return () => { disposed = true; };
    }, [titleIdentity, connection]);
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
    const projected = useMemo(() => projectSidebar(raw, parents, selected, archived, titles), [raw, parents, selected, archived, titles]);
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
