// Keep title reads independent of React renders: opening an empty session can
// change the list while earlier cold-log reads are still in flight.
export function createSidebarTitleLoader(connection) {
  const cache = new Map(), queue = [];
  let running = false, disposed = false, controller;
  const pump = async () => {
    if (running || disposed) return;
    running = true;
    try {
      while (queue.length && !disposed) {
        const batch = queue.splice(0, 4);
        controller = new AbortController();
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
          const result = await connection.rpc.call('/dsh-context-tree', 'sidebar-titles', { ids: batch.map(item => item.id) }, signal);
          if (!result?.ok) throw new Error('Sidebar title read failed');
          for (const item of batch) {
            const value = result.value.titles[item.id];
            item.done = true;
            if (value === undefined) cache.delete(item.key); // Unreadable, not an unnamed session.
            item.resolve(value === undefined ? undefined : { ...value, listUpdatedAt: item.updatedAt });
          }
        } catch (error) {
          for (const item of batch) { cache.delete(item.key); item.reject(error); }
        }
        while (cache.size > 512) {
          const oldest = [...cache.values()].find(item => item.done);
          if (!oldest) break;
          cache.delete(oldest.key);
        }
        // Yield between batches instead of requesting the entire corpus at once.
        if (queue.length && !disposed) await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { running = false; }
  };
  return {
    async load(requests) {
      if (disposed) return {};
      const pending = requests.map(({ id, updatedAt }) => {
        const key = JSON.stringify([id, updatedAt]);
        let item = cache.get(key);
        if (!item) {
          item = { key, id, updatedAt, done: false };
          item.promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
          cache.set(key, item); queue.push(item);
        }
        return item.promise.then(value => [id, value]);
      });
      void pump();
      return Object.fromEntries((await Promise.all(pending)).filter(([, value]) => value !== undefined));
    },
    dispose() {
      disposed = true;
      controller?.abort();
      for (const item of queue.splice(0)) item.resolve(undefined);
      cache.clear();
    },
  };
}
