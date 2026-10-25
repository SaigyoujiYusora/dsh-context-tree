import { alignForkRequest } from './fork-alignment.js';
import { identityHash, projectWire } from './billion-wire.js';

// Billion publishes this live state for its native fetch dispatcher. Decorating
// beforeSend avoids replacing fetch or modifying another package on disk.
export const BILLION_STATE = Symbol.for('billion-context.native-intercept-state');
const BRANCH_RECORD = 'plugin:dsh-context-tree/branch';

function localOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      ? url.origin : null;
  } catch { return null; }
}

function eligibleBody(url, init) {
  try {
    const target = new URL(url);
    if (!/\/chat\/completions\/?$/.test(target.pathname)
      || [...target.searchParams.keys()].some(key => /signature|credential/i.test(key))) return null;
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization');
    if (authorization && !/^(Bearer|Basic) /i.test(authorization)) return null;
    if ([...headers.keys()].some(key => /signature|x-amz-|x-sdk-date/i.test(key))) return null;
    const bytes = init?.body;
    const body = JSON.parse(typeof bytes === 'string' ? bytes
      : bytes instanceof Uint8Array || bytes instanceof ArrayBuffer ? new TextDecoder().decode(bytes) : 'null');
    if (!body || !Array.isArray(body.messages) || typeof body.model !== 'string'
      || 'system' in body || 'anthropic_version' in body || 'input' in body) return null;
    if (!body.tools?.length && (body.max_tokens ?? body.max_completion_tokens ?? Infinity) <= 200) return null;
    return body;
  } catch { return null; }
}

function branchOf(ctx, branches) {
  const session = ctx.agents.currentInitiator?.()?.session;
  const parent = session?.header?.parentSession;
  if (!session?.id || session.header.isSeeded !== true || typeof parent !== 'string' || parent === session.id) return null;
  const known = branches.get(session);
  if (known?.parent === parent && known.child === session.id) return known;
  const record = session.snapshotEvents().findLast(event => event.type === BRANCH_RECORD && event.data?.sessionId === session.id);
  // The first model call can start before followup()'s final ready marker.
  if (record?.data?.parentId !== parent || !['prepared', 'ready'].includes(record.data.phase)) return null;
  const branch = { child: session.id, parent };
  branches.set(session, branch);
  return branch;
}

export function installBillionCompatibility(ctx, { globals = globalThis, fetchImpl = (...args) => globalThis.fetch(...args), log = message => console.info(`[dsh-context-tree] ${message}`) } = {}) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globals, BILLION_STATE);
  // Another accessor owner or locked property must not be displaced.
  if (originalDescriptor && (!originalDescriptor.configurable || !('value' in originalDescriptor) || !originalDescriptor.writable)) {
    log('Billion compatibility unavailable: live state is owned by another accessor');
    return () => {};
  }
  let current = globals[BILLION_STATE], active = true;
  const restorations = new Map(), recipes = new Map(), manifests = new Map(), branches = new WeakMap();
  const capable = async (base, signal) => {
    const known = manifests.get(base);
    if (known && known.expires > Date.now()) return known.value;
    const response = await fetchImpl(`${base}/__bili/plugin/manifest`, { signal, redirect: 'error' });
    const value = response.ok && (await response.json())?.capabilities?.fork?.protocolVersion === 2;
    if (manifests.size >= 8) manifests.delete(manifests.keys().next().value);
    manifests.set(base, { value, expires: Date.now() + 60000 });
    return value;
  };
  const decorate = state => {
    if (!state || typeof state.beforeSend !== 'function' || restorations.has(state)) return;
    const original = state.beforeSend;
    const wrapped = async function (url, init) {
      if (active) {
        try {
          const base = localOrigin(state.origin), body = eligibleBody(url, init), branch = body && branchOf(ctx, branches);
          if (base && branch && !init.signal?.aborted) {
            const budget = ms => init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
            if (await capable(base, budget(5000))) {
              const signal = budget(30000);
              const aligned = await alignForkRequest({ base, ...branch, body, project: projectWire, hash: identityHash, fetchImpl, recipes, signal, log });
              if (active && !signal.aborted && aligned !== body) {
                init.body = JSON.stringify(aligned);
                if (init.headers != null) {
                  const headers = new Headers(init.headers);
                  headers.delete('content-length');
                  init.headers = headers;
                }
              }
            }
          }
        } catch { if (!init?.signal?.aborted) log('Billion alignment unavailable or timed out; preserving original request'); }
      }
      // The attributed recall step in Billion 0.1.204 only learns a boundary;
      // it does not replace the body. Native fork/incremental processing follows.
      return original.call(this, url, init);
    };
    state.beforeSend = wrapped;
    restorations.set(state, { original, wrapped });
    log('Billion fork compatibility attached');
  };
  const get = () => current;
  const restoreHooks = () => {
    for (const [state, { original, wrapped }] of restorations) {
      if (state.beforeSend === wrapped) state.beforeSend = original;
    }
    restorations.clear(); recipes.clear(); manifests.clear();
  };
  const set = value => { restoreHooks(); current = value; decorate(value); };
  const arm = () => {
    const descriptor = Object.getOwnPropertyDescriptor(globals, BILLION_STATE);
    if (descriptor?.get === get) return;
    if (descriptor && (!descriptor.configurable || !('value' in descriptor) || !descriptor.writable)) return;
    set(descriptor?.value);
    Object.defineProperty(globals, BILLION_STATE, { configurable: true, enumerable: descriptor?.enumerable ?? true, get, set });
  };
  arm();
  // Billion deletes the live slot when unloaded. Re-arm after that lifecycle
  // event; do not retain a stale state or replace another accessor owner.
  const watcher = setInterval(arm, 100);
  watcher.unref?.();
  return () => {
    active = false;
    clearInterval(watcher);
    restoreHooks();
    if (Object.getOwnPropertyDescriptor(globals, BILLION_STATE)?.get === get) {
      if (originalDescriptor) Object.defineProperty(globals, BILLION_STATE, { ...originalDescriptor, value: current });
      else if (current === undefined) delete globals[BILLION_STATE];
      else Object.defineProperty(globals, BILLION_STATE, { configurable: true, enumerable: true, writable: true, value: current });
    }
    recipes.clear(); manifests.clear(); restorations.clear();
  };
}
