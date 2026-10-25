import { useEffect, useMemo, useSyncExternalStore } from 'react'

// Use the host's registered ModelSelect component with a draft-only store.
// Selecting a model/effort here never changes the source session or host defaults.
export function BranchModelPicker({ directory, modelState, selection, onChange, locked }) {
  const entry = useSyncExternalStore(directory.picker.subscribe, directory.picker.getSnapshot)
  const draft = useMemo(() => {
    let snapshot = { ...modelState, current: selection, pending: null, retainedEffort: undefined }
    const listeners = new Set()
    return {
      getSnapshot: () => snapshot,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      update(next) { snapshot = next; for (const listener of listeners) listener() },
    }
  }, [directory])
  useEffect(() => { draft.update({ ...modelState, current: selection, pending: null, retainedEffort: undefined }) }, [draft, modelState, selection])
  if (!entry?.component) return <span className="ct-editorHelp">正在读取模型…</span>
  const NativeModelSelect = entry.component
  return <NativeModelSelect
    locked={locked}
    available={true}
    directory={draft}
    load={() => { void directory.load().catch(() => {}) }}
    select={async next => {
      draft.update({ ...draft.getSnapshot(), current: next, pending: null })
      onChange(next)
      return { ok: true }
    }}
    t={directory.picker.t}
    renderSlot={(_name, _props, options) => options?.fallback ?? null}
  />
}
