import { createHash } from 'node:crypto';

// Billion fork protocol v2 hashes these scalar identity fields. This module
// projects text/tool messages only; it neither renders nor writes summaries.
export function identityHash(message) {
  const fields = ['role', 'contentType', 'text', 'toolName', 'toolCallId', 'thinkingTokens', 'summaryOfBlockId'];
  return createHash('sha256').update(JSON.stringify([
    ...fields.map(key => message[key] ?? null), message.toolIsError === true,
  ])).digest('hex');
}

const isTextParts = parts => Array.isArray(parts) && parts.every(part =>
  typeof part === 'string' || (part?.type === 'text' && typeof part.text === 'string'));
const textOf = content => typeof content === 'string' ? content
  : isTextParts(content) ? content.map(part => typeof part === 'string' ? part : part.text).join('\n') : '';

function panel(text) {
  const value = text.trim();
  return (value.startsWith('[acp-cache]') && value.endsWith('[/acp-cache]'))
    || (value.startsWith('[acp-rule]') && value.endsWith('[/acp-rule]'))
    || (value.startsWith('╭') && value.includes('ACP Context Analysis')
      && value.endsWith('Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal.'))
    || (value.split('\n')[0] === '📊 ACP status' && value.split('\n').slice(1).every(line => !line || line.startsWith('  ')));
}

function cleanText(text) {
  // Presentation markers are absent from the proxy's saved identities.
  const cleaned = text.replace(/^\p{So}[ \t]?\[ACP\][^\n]*\n?/gmu, '');
  return cleaned === text || cleaned.trim() ? cleaned : ' ';
}

function splitReasoning(text) {
  const reasoning = [];
  let rest = text;
  while (true) {
    const match = /^(?:<think>\n([\s\S]+?)\n<\/think>|<thinking>\n([\s\S]+?)\n<\/thinking>|```thinking\n([\s\S]+?)\n```)(?:\n)?/.exec(rest);
    if (!match) break;
    reasoning.push(match[1] ?? match[2] ?? match[3]);
    rest = rest.slice(match[0].length);
  }
  return { reasoning: reasoning.join('\n'), text: rest };
}

export function projectWire(body) {
  const core = [], wireSourceIndices = [];
  const toolNames = new Map();
  for (const [index, original] of body.messages.entries()) {
    if (!original || !['system', 'developer', 'user', 'assistant', 'tool'].includes(original.role)) break;
    // An unsupported item is a hard prefix boundary, never silently skipped.
    if (original.content != null && typeof original.content !== 'string' && !isTextParts(original.content)) break;
    const role = original.role;
    let parts = original.content;
    if (['user', 'assistant'].includes(role)) {
      const joined = Array.isArray(parts) ? parts.map(part => typeof part === 'string' ? part : part.text).join('') : parts;
      if (role === 'user' && typeof joined === 'string' && panel(joined)) continue;
      parts = Array.isArray(parts) ? parts.map(part => typeof part === 'string' ? part : { ...part, text: cleanText(part.text) })
        : typeof parts === 'string' ? cleanText(parts) : parts;
    }
    const wireIndex = wireSourceIndices.length;
    wireSourceIndices.push(index);
    const add = (contentType, text, extra = {}) => core.push({ role, contentType, text, wireIndex, ...extra });
    if (role === 'system' || role === 'developer') {
      if (core.length) add('text', textOf(parts), { role: 'system' });
    } else if (role === 'user') {
      if (Array.isArray(parts)) {
        for (const part of parts) add('text', typeof part === 'string' ? part : part.text);
      } else add('text', textOf(parts));
    } else if (role === 'assistant') {
      const visible = textOf(parts);
      const split = original.reasoning_content ? { reasoning: original.reasoning_content, text: visible } : splitReasoning(visible);
      if (typeof split.reasoning === 'string' && split.reasoning) add('reasoning', split.reasoning);
      if (split.text) add('text', split.text);
      for (const tool of original.tool_calls ?? []) {
        if (!tool?.function || typeof tool.function.name !== 'string' || typeof tool.id !== 'string') return { core, wireSourceIndices };
        add('tool-call', tool.function.arguments ?? '', { toolName: tool.function.name, toolCallId: tool.id });
        toolNames.set(tool.id, tool.function.name);
      }
    } else {
      add('tool-result', textOf(parts), { toolName: original.name || toolNames.get(original.tool_call_id ?? ''), toolCallId: original.tool_call_id ?? '' });
    }
  }
  return { core, wireSourceIndices };
}
