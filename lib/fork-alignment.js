// Compatibility for Billion's v2 fork identity protocol.
// Align transport-only differences against an authoritative saved snapshot.
// Never merge separate messages, edit text, tool arguments, or persisted logs.
const MAX_RECIPES = 64;
const assistantKeys = new Set(['role', 'content', 'reasoning_content', 'tool_calls']);

export function normalizePrefix(body, mask, through = Infinity) {
  const messages = [], sourceIndices = [];
  for (const [index, original] of body.messages.entries()) {
    let message = original;
    if (index <= through && message && ['user', 'assistant'].includes(message.role)) {
      if ((mask & 1) && Array.isArray(message.content) && message.content.length > 1
        && message.content.every(part => part && part.type === 'text' && typeof part.text === 'string'
          && Object.keys(part).every(key => key === 'type' || key === 'text'))) {
        message = { ...message, content: message.content.map(part => part.text).join('') };
      }
      const blank = message.content == null || (typeof message.content === 'string' && message.content.trim() === '');
      if (message.role === 'assistant' && blank && Object.keys(message).every(key => assistantKeys.has(key))) {
        if ((mask & 2) && message.tool_calls?.length > 0 && message.content != null) message = { ...message, content: null };
        if ((mask & 4) && !message.tool_calls?.length && typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) continue;
      }
    }
    messages.push(message); sourceIndices.push(index);
  }
  return { body: { ...body, messages }, sourceIndices };
}

function prefixLength(core, identities, hash) {
  let i = 0;
  while (i < core.length && i < identities.length && hash(core[i]) === identities[i].identityHash) i++;
  return i;
}

export function chooseAlignment(body, identities, project, hash) {
  const raw = project(body).core;
  const baseline = prefixLength(raw, identities, hash);
  let best = { body, count: baseline, mask: 0, through: -1 };
  for (let mask = 1; mask < 8; mask++) {
    const candidate = normalizePrefix(body, mask);
    const projected = project(candidate.body);
    const count = prefixLength(projected.core, identities, hash);
    if (count <= best.count) continue;
    const wireIndex = projected.core[count - 1].wireIndex;
    const candidateIndex = projected.wireSourceIndices[wireIndex];
    const through = candidate.sourceIndices[candidateIndex];
    if (!Number.isSafeInteger(through)) continue;
    // Keep all unproven suffix messages byte-for-byte as supplied by the adapter.
    const bounded = normalizePrefix(body, mask, through).body;
    const boundedCount = prefixLength(project(bounded).core, identities, hash);
    if (boundedCount > best.count) best = { body: bounded, count: boundedCount, mask, through };
  }
  return { ...best, baseline, identities: identities.slice(0, best.count) };
}

export async function alignForkRequest({ base, parent, child, body, project, hash, fetchImpl, log, recipes = new Map(), signal }) {
  const key = JSON.stringify([base, child, body.model ?? null]);
  const cached = recipes.get(key);
  if (cached) {
    const next = cached.mask ? normalizePrefix(body, cached.mask, cached.through).body : body;
    if (prefixLength(project(next).core, cached.identities, hash) === cached.identities.length) return next;
    recipes.delete(key);
  }
  const snapshot = async id => {
    const timeout = AbortSignal.timeout(15000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl(`${base}/__bili/plugin/snapshot?conversationId=${encodeURIComponent(id)}`, { signal: requestSignal, redirect: 'error' });
    if (response.status === 404) return { absent: true };
    if (!response.ok) return {};
    const value = await response.json();
    return value.protocolVersion === 2 && Array.isArray(value.orderedMessages) && value.orderedMessages.every(row => /^[a-f0-9]{64}$/.test(row?.identityHash))
      ? { identities: value.orderedMessages } : {};
  };
  try {
    // Existing children own their state. Never replace it with a newer parent.
    let source = await snapshot(child);
    if (source.absent) source = await snapshot(parent);
    if (!source.identities?.length) return body;
    const selected = chooseAlignment(body, source.identities, project, hash);
    if (!selected.count) return body;
    if (recipes.size >= MAX_RECIPES) recipes.delete(recipes.keys().next().value);
    recipes.set(key, { mask: selected.mask, through: selected.through, identities: selected.identities });
    if (selected.mask) log?.(`fork wire alignment ${child}: exact prefix ${selected.baseline} -> ${selected.count}; mask=${selected.mask}, unchanged suffix retained`);
    return selected.body;
  } catch (error) {
    if (!signal?.aborted) log?.('fork wire alignment snapshot unavailable or timed out; preserving original body');
    return body;
  }
}

