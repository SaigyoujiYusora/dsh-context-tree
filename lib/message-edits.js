const MESSAGE_KINDS = new Set(['text', 'reasoning']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeSeq(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function blockKind(block) {
  if (!isRecord(block)) return undefined;
  if (block.type === 'text') return 'text';
  if (block.type === 'reasoning' || block.type === 'thinking') return 'reasoning';
  return undefined;
}

function validTarget(target, content) {
  if (!isRecord(target)
    || !isSafeSeq(target.blockIndex)
    || typeof target.text !== 'string'
    || !MESSAGE_KINDS.has(target.kind)) return false;
  if (Object.hasOwn(target, 'seq') && !isSafeSeq(target.seq)) return false;
  const block = content[target.blockIndex];
  return blockKind(block) === target.kind;
}

/** Apply block-local edits without mutating the source message. */
export function applyTargetsToMessage(message, targets) {
  if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) return message;
  if (!Array.isArray(targets)) return message;

  let content = message.content;
  let changed = false;
  for (const target of targets) {
    if (!validTarget(target, content)) continue;
    if (content[target.blockIndex].text === target.text) continue;
    if (!changed) content = [...content];
    content[target.blockIndex] = {...content[target.blockIndex], text: target.text};
    changed = true;
  }
  return changed ? {...message, content} : message;
}

function readPayload(event) {
  const payload = event?.data;
  if (!isRecord(payload)) throw new TypeError('message edit record data must be an object');
  if (payload.version !== 1) throw new Error(`unsupported message edit record version: ${String(payload.version)}`);
  if (!Array.isArray(payload.targets)) throw new TypeError('message edit record targets must be an array');
  return payload.targets;
}

function eventAt(context, seq) {
  const baseSeq = context.baseSeq ?? 0;
  const index = seq - baseSeq;
  const event = context.events[index];
  return event?.seq === seq ? event : undefined;
}

function validProjectionTarget(target, event, context) {
  if (target.seq >= event.seq) return false;
  if (!context.nodes.includes(target.seq)) return false;
  const source = eventAt(context, target.seq);
  return source?.type === 'assistant/message'
    && source.data.message.role === 'assistant';
}

function assertTargetShape(target) {
  if (!isRecord(target)
    || !isSafeSeq(target.seq)
    || !isSafeSeq(target.blockIndex)
    || typeof target.text !== 'string'
    || !MESSAGE_KINDS.has(target.kind)) {
    throw new TypeError('message edit record contains an invalid target');
  }
}

/** Create the pure DSH Session message projection for one record type. */
export function createMessageProjection(recordType) {
  return {
    type: recordType,
    project(event, context) {
      const targets = readPayload(event);
      const grouped = new Map();
      for (const target of targets) {
        assertTargetShape(target);
        if (!validProjectionTarget(target, event, context)) continue;
        const list = grouped.get(target.seq) ?? [];
        list.push(target);
        grouped.set(target.seq, list);
      }

      const projected = new Map();
      for (const [seq, edits] of grouped) {
        const source = eventAt(context, seq);
        const original = context.messages?.get(seq) ?? source.data.message;
        const message = applyTargetsToMessage(original, edits);
        if (message !== original) projected.set(seq, message);
      }
      return projected;
    },
  };
}

