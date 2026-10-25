const MESSAGE_ROLES = new Set(["user", "assistant"]);
const ROOT_KEY = "@root";

export function buildBranchNavigation(sources, currentId) {
  const records = collectSources(sources);
  const byId = new Map(records.map((record) => [record.id, record]));
  const current = String(currentId);
  if (!byId.has(current)) return { user: {}, assistant: {}, tree: null };

  const parentById = buildParentMap(records, byId);
  removeParentCycles(parentById);
  const messagesById = new Map();
  const factsById = new Map();
  for (const record of records) {
    const facts = normalizeEvents(record.events);
    factsById.set(record.id, facts);
    messagesById.set(
      record.id,
      Array.isArray(record.messages)
        ? normalizeMessages(record.messages)
        : extractMessagesFromEvents(facts),
    );
  }

  const descriptorById = new Map();
  for (const record of records) {
    const parentId = parentById.get(record.id);
    if (!parentId) continue;
    const explicit = normalizeBranchDescriptor(
      record.branch,
      record,
      parentId,
      byId,
    );
    if (explicit) {
      descriptorById.set(record.id, explicit);
      continue;
    }
    const inferred = inferLegacyBranch(
      record,
      byId.get(parentId),
      parentId,
      factsById.get(record.id) ?? [],
      messagesById.get(parentId) ?? [],
    );
    if (inferred) descriptorById.set(record.id, inferred);
  }

  const family = collectFamily(current, parentById, records);
  const familySet = new Set(family);
  const familyRecords = records.filter((record) => familySet.has(record.id));
  const sessionOrder = stableSessionOrder(familyRecords);
  const processingOrder = parentFirstOrder(family, parentById, records);
  const paths = new Map();
  for (const id of processingOrder) {
    if (!familySet.has(id)) continue;
    const path = (messagesById.get(id) ?? []).map((message) =>
      entryFromMessage(message, id),
    );
    const parentId = parentById.get(id);
    if (parentId && paths.has(parentId)) {
      inheritPrefixIdentity(path, paths.get(parentId));
    }
    const descriptor = descriptorById.get(id);
    const hasExplicitMessages = Array.isArray(byId.get(id)?.messages);
    if (
      path.length === 0 &&
      !hasExplicitMessages &&
      descriptor &&
      parentId &&
      paths.has(parentId)
    ) {
      const parentPath = paths.get(parentId);
      const targetIndex = parentPath.findIndex(
        (entry) =>
          entry.role === descriptor.role &&
          entry.turn === descriptor.turn,
      );
      if (targetIndex >= 0) {
        paths.set(
          id,
          parentPath.slice(0, targetIndex).map((entry) => ({ ...entry })),
        );
      }
    }
    const branchIndex = descriptor
      ? (paths.get(id) ?? path).findIndex(
          (entry) =>
            entry.role === descriptor.role &&
            entry.turn === descriptor.turn,
        )
      : -1;
    if (branchIndex >= 0) {
      markBranchEntry((paths.get(id) ?? path)[branchIndex], descriptor, id);
    }
    if (!paths.has(id)) paths.set(id, path);
  }

  const treeRoot = {
    children: [],
    sessionIds: [],
    terminalSessionIds: [],
  };
  const nodeByKey = new Map();
  const groupNodes = new Map();
  const displayIds = new Set();
  let generatedNodeNumber = 0;

  for (const id of processingOrder) {
    if (!familySet.has(id)) continue;
    const path = paths.get(id) ?? [];
    treeRoot.sessionIds.push(id);
    let parentNode = treeRoot;
    let parentKey = ROOT_KEY;
    if (path.length === 0) {
      treeRoot.terminalSessionIds.push(id);
      continue;
    }

    for (const entry of path) {
      const nodeKey = `${parentKey}\u0001${messageIdentity(entry)}`;
      let node = nodeByKey.get(nodeKey);
      if (!node) {
        node = {
          id: uniqueDisplayId(
            entry,
            nodeKey,
            displayIds,
            ++generatedNodeNumber,
          ),
          role: entry.role,
          turn: entry.turn,
          text: entry.text,
          nonText: entry.nonText,
          action: entry.action ?? null,
          sessionIds: [],
          terminalSessionIds: [],
          children: [],
          _key: nodeKey,
          _owner: entry.introducedBy,
        };
        nodeByKey.set(nodeKey, node);
        parentNode.children.push(node);
        const groupKey = `${entry.role}\u0000${entry.turn}\u0000${parentKey}`;
        const group = groupNodes.get(groupKey) ?? [];
        group.push(node);
        groupNodes.set(groupKey, group);
      }
      addUnique(node.sessionIds, id);
      entry.nodeKey = nodeKey;
      parentNode = node;
      parentKey = nodeKey;
    }
    addUnique(parentNode.terminalSessionIds, id);
  }

  const rank = new Map(sessionOrder.map((id, index) => [id, index]));
  const processingRank = new Map(
    processingOrder.map((id, index) => [id, index]),
  );
  sortSessionLists(treeRoot, rank);
  const navigation = buildNavigationMaps(
    paths.get(current) ?? [],
    groupNodes,
    rank,
    processingRank,
  );
  stripInternalTreeFields(treeRoot);
  return {
    user: navigation.user,
    assistant: navigation.assistant,
    tree: {
      currentId: current,
      sessionIds: sessionOrder,
      terminalSessionIds: treeRoot.terminalSessionIds,
      children: treeRoot.children,
    },
  };
}

function collectSources(sources) {
  if (!(sources instanceof Map)) return [];
  const records = [];
  for (const [key, value] of sources) {
    if (!value || typeof value !== "object") continue;
    const id = String(key);
    const header = value.header && typeof value.header === "object"
      ? value.header
      : {};
    records.push({
      ...value,
      id,
      header,
      events: Array.isArray(value.events) ? value.events : [],
      messages: Array.isArray(value.messages) ? value.messages : undefined,
    });
  }
  return records;
}

function buildParentMap(records, recordById) {
  const parents = new Map();
  for (const record of records) {
    const parent = record.header?.parentSession;
    if (parent == null || parent === "") continue;
    const parentId = String(parent);
    if (parentId === record.id || !recordById.has(parentId)) {
      continue;
    }
    parents.set(record.id, parentId);
  }
  return parents;
}

function removeParentCycles(parentById) {
  const done = new Set();
  const cycleNodes = new Set();

  for (const start of parentById.keys()) {
    if (done.has(start)) continue;
    const seenAt = new Map();
    const trail = [];
    let current = start;

    while (current && parentById.has(current) && !done.has(current)) {
      if (seenAt.has(current)) {
        const first = seenAt.get(current);
        for (let index = first; index < trail.length; index += 1) {
          cycleNodes.add(trail[index]);
        }
        break;
      }
      seenAt.set(current, trail.length);
      trail.push(current);
      current = parentById.get(current);
    }

    for (const id of trail) done.add(id);
  }

  for (const id of cycleNodes) parentById.delete(id);
}

function collectFamily(currentId, parentById, records) {
  const family = new Set([currentId]);
  const ancestors = new Set();
  const ancestorList = [];
  let cursor = currentId;
  while (parentById.has(cursor) && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    const parent = parentById.get(cursor);
    if (family.has(parent)) break;
    family.add(parent);
    ancestorList.push(parent);
    cursor = parent;
  }

  const children = new Map();
  for (const [child, parent] of parentById) {
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }

  const byId = new Map(records.map((record) => [record.id, record]));
  const visit = (parent) => {
    const childIds = children.get(parent) ?? [];
    childIds.sort((left, right) =>
      compareSessions(byId.get(left), byId.get(right)),
    );
    for (const child of childIds) {
      if (family.has(child)) continue;
      family.add(child);
      visit(child);
    }
  };
  visit(currentId);
  for (const ancestor of ancestorList) visit(ancestor);
  return [...family];
}

function stableSessionOrder(records) {
  return [...records]
    .sort(compareSessions)
    .map((record) => record.id);
}

function compareSessions(left, right) {
  const leftTime = sessionTime(left);
  const rightTime = sessionTime(right);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.id.localeCompare(right.id);
}

function sessionTime(record) {
  if (!record) return Number.POSITIVE_INFINITY;
  const value = record.header?.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.POSITIVE_INFINITY;
}

function parentFirstOrder(family, parentById, records) {
  const familySet = new Set(family);
  const byId = new Map(records.map((record) => [record.id, record]));
  const children = new Map();
  for (const id of familySet) {
    const parent = parentById.get(id);
    if (!parent || !familySet.has(parent)) continue;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }

  const roots = [...familySet].filter(
    (id) => !parentById.has(id) || !familySet.has(parentById.get(id)),
  );
  roots.sort((left, right) =>
    compareSessions(byId.get(left), byId.get(right)),
  );

  const ordered = [];
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    ordered.push(id);
    const childIds = children.get(id) ?? [];
    childIds.sort((left, right) =>
      compareSessions(byId.get(left), byId.get(right)),
    );
    for (const child of childIds) visit(child);
  };
  for (const root of roots) visit(root);
  for (const id of [...familySet].sort()) visit(id);
  return ordered;
}

function normalizeBranchDescriptor(branch, record, parentId, recordById) {
  if (!branch || typeof branch !== "object") return null;
  const headerParent = record.header?.parentSession;
  if (
    headerParent == null ||
    String(branch.parentId) !== String(headerParent) ||
    !recordById.has(parentId)
  ) {
    return null;
  }

  const role = branch.role;
  const turn = normalizeTurn(branch.turn);
  if (!MESSAGE_ROLES.has(role) || turn == null) return null;

  return {
    parentId,
    role,
    turn,
    action: branch.action == null ? null : String(branch.action),
    source: "explicit",
  };
}

function inferLegacyBranch(record, parent, parentId, facts, parentMessages) {
  if (!parent) return null;
  const seed = inheritedCount(record);
  if (seed == null || seed < 0 || seed > facts.length) return null;

  const afterSeed = facts.slice(seed);
  const target = afterSeed.find((fact) => fact.turn != null);
  if (!target || target.turn == null) return null;
  const turn = target.turn;
  const parentAtTurn = parentMessages.filter((message) => message.turn === turn);
  const parentUser = parentAtTurn.find((message) => message.role === "user");
  const parentAssistant = [...parentAtTurn]
    .reverse()
    .find((message) => message.role === "assistant");

  const seedAssistant = facts
    .slice(0, seed)
    .filter((fact) => fact.role === "assistant" && fact.turn === turn)
    .pop();
  if (
    seedAssistant &&
    parentAssistant &&
    !sameContent(seedAssistant, parentAssistant)
  ) {
    return {
      parentId,
      role: "assistant",
      turn,
      action: "edit-assistant",
      source: "inferred",
    };
  }

  const firstUser = afterSeed.find((fact) => fact.role === "user");
  const hasAssistant = afterSeed.some(
    (fact) => fact.role === "assistant" && fact.turn === turn,
  );
  if (firstUser && parentUser) {
    return {
      parentId,
      role: sameContent(firstUser, parentUser) ? "assistant" : "user",
      turn,
      action: sameContent(firstUser, parentUser)
        ? "regenerate"
        : "edit-user",
      source: "inferred",
    };
  }

  if (!firstUser && hasAssistant && parentUser) {
    return {
      parentId,
      role: "assistant",
      turn,
      action: "regenerate",
      source: "inferred",
    };
  }

  return null;
}

function inheritedCount(record) {
  const candidates = [
    record.inheritedEventCount,
    record.header?.seedLength,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 0
    ) {
      return candidate;
    }
  }
  return null;
}

function markBranchEntry(entry, descriptor, id) {
  if (!entry) return;
  entry.variantToken = `${id}:${descriptor.role}:${descriptor.turn}`;
  entry.introducedBy = id;
  entry.action = descriptor.action ?? null;
}

function inheritPrefixIdentity(path, parentPath) {
  const length = Math.min(path.length, parentPath.length);
  for (let index = 0; index < length; index += 1) {
    if (!sameContent(path[index], parentPath[index])) break;
    path[index].variantToken = parentPath[index].variantToken;
    if (parentPath[index].action != null) {
      path[index].action = parentPath[index].action;
    }
  }
}

function entryFromMessage(message, owner) {
  return {
    role: message.role,
    turn: message.turn,
    text: message.text,
    nonText: message.nonText,
    contentKey: message.contentKey,
    messageId: message.messageId,
    action: null,
    variantToken: null,
    introducedBy: owner,
  };
}

function normalizeEvents(events) {
  let currentTurn = null;
  return events.map((event, index) => {
    const type = String(event?.type ?? "").toLowerCase();
    const data = event?.data && typeof event.data === "object"
      ? event.data
      : {};
    if (type === "turn/start") {
      currentTurn = normalizeTurn(data.turn);
      return {
        index,
        role: null,
        turn: currentTurn,
        text: null,
        nonText: false,
        contentKey: null,
        messageId: null,
        kind: type,
        turnStart: true,
      };
    }

    let role = null;
    let turn = currentTurn;
    let content = null;
    let messageId = null;
    if (type === "user/message") {
      role = "user";
      turn = normalizeTurn(data.turn) ?? currentTurn;
      content = data.content;
      messageId = data.id ?? null;
    } else if (type === "assistant/message") {
      const message = data.message && typeof data.message === "object"
        ? data.message
        : {};
      role = "assistant";
      turn = normalizeTurn(data.turn) ?? currentTurn;
      content = message.content;
      messageId = message.id ?? data.id ?? null;
    }

    const text = textFromContent(content);
    const nonText = hasNonTextContent(content);
    return {
      index,
      role,
      turn,
      text,
      nonText,
      contentKey: data.contentKey ??
        (nonText && content != null ? JSON.stringify(content) : null),
      messageId,
      kind: type,
      turnStart: false,
    };
  });
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return text === "" ? null : text;
}

function hasNonTextContent(content) {
  return Array.isArray(content) && content.some((part) => part?.type !== "text");
}

function extractMessagesFromEvents(facts) {
  const byTurn = new Map();
  for (const fact of facts) {
    if (!MESSAGE_ROLES.has(fact.role) || fact.turn == null) continue;
    const list = byTurn.get(fact.turn) ?? [];
    list.push(fact);
    byTurn.set(fact.turn, list);
  }

  const turns = [...byTurn.keys()].sort((left, right) => left - right);
  const messages = [];
  for (const turn of turns) {
    const list = byTurn.get(turn) ?? [];
    const user = list.find((fact) => fact.role === "user");
    const assistants = list.filter(
      (fact) => fact.role === "assistant" && fact.text != null,
    );
    if (user) messages.push(normalizeFactAsMessage(user));
    if (assistants.length > 0) {
      messages.push(normalizeFactAsMessage(assistants[assistants.length - 1]));
    }
  }
  return messages;
}

function normalizeMessages(messages) {
  const normalized = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const role = raw.role;
    const turn = normalizeTurn(raw.turn);
    if (!MESSAGE_ROLES.has(role) || turn == null) continue;

    const text = typeof raw.text === "string" ? raw.text : "";
    const nonText = Boolean(raw.nonText);
    const contentKey = raw.contentKey != null
      ? String(raw.contentKey)
      : null;

    normalized.push({
      role,
      turn,
      text: text ?? "",
      nonText,
      contentKey,
      messageId: raw.messageId ?? raw.id,
    });
  }
  return normalized;
}

function normalizeFactAsMessage(fact) {
  return {
    role: fact.role,
    turn: fact.turn,
    text: fact.text ?? "",
    nonText: Boolean(fact.nonText),
    contentKey: fact.contentKey != null ? String(fact.contentKey) : null,
    messageId: fact.messageId,
  };
}

function normalizeTurn(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value);
  }
  return null;
}

function deriveContentKey(text, nonText) {
  if (!nonText) return `text:${text ?? ""}`;
  return `nontext:text:${text ?? ""}`;
}

function sameContent(left, right) {
  if (!left || !right) return false;
  const contentEqual = left.contentKey != null && right.contentKey != null
    ? String(left.contentKey) === String(right.contentKey)
    : left.text === right.text && Boolean(left.nonText) === Boolean(right.nonText);
  return (
    left.role === right.role &&
    left.turn === right.turn &&
    contentEqual &&
    left.text === right.text &&
    Boolean(left.nonText) === Boolean(right.nonText)
  );
}

function messageIdentity(entry) {
  return JSON.stringify({
    role: entry.role,
    turn: entry.turn,
    text: entry.text,
    nonText: Boolean(entry.nonText),
    contentKey: entry.contentKey ?? deriveContentKey(entry.text, entry.nonText),
    variantToken: entry.variantToken ?? null,
  });
}

function uniqueDisplayId(entry, nodeKey, used, generatedNumber) {
  const preferred = entry.messageId != null && String(entry.messageId) !== ""
    ? String(entry.messageId)
    : `node-${generatedNumber}`;
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  const fallback = `${preferred}~${nodeKey}`;
  used.add(fallback);
  return fallback;
}

function buildNavigationMaps(currentPath, groupNodes, sessionRank, processingRank) {
  const selected = new Map();
  let parentKey = ROOT_KEY;

  for (const entry of currentPath) {
    const nodeKey = entry.nodeKey ?? `${parentKey}\u0001${messageIdentity(entry)}`;
    const groupKey = `${entry.role}\u0000${entry.turn}\u0000${parentKey}`;
    selected.set(`${entry.role}\u0000${entry.turn}`, {
      groupKey,
      nodeKey,
    });
    parentKey = nodeKey;
  }

  const result = { user: {}, assistant: {} };
  for (const [roleTurn, selection] of selected) {
    const [role, turnText] = roleTurn.split("\u0000");
    const group = groupNodes.get(selection.groupKey) ?? [];
    const ids = group
      .map((node) => node._owner)
      .filter((id, index, all) => id && all.indexOf(id) === index)
      .sort((left, right) => {
        const leftRank = processingRank.get(left) ?? Number.POSITIVE_INFINITY;
        const rightRank = processingRank.get(right) ?? Number.POSITIVE_INFINITY;
        if (leftRank !== rightRank) return leftRank - rightRank;
        return (sessionRank.get(left) ?? Number.POSITIVE_INFINITY) -
          (sessionRank.get(right) ?? Number.POSITIVE_INFINITY);
      });

    if (ids.length <= 1) continue;
    const selectedNode = group.find((node) => node._key === selection.nodeKey);
    const selectedOwner = selectedNode?._owner;
    const index = Math.max(0, ids.indexOf(selectedOwner));
    result[role][turnText] = { ids, index };
  }
  return result;
}

function sortSessionLists(root, rank) {
  const sort = (list) => {
    const unique = [...new Set(list)];
    unique.sort((left, right) =>
      (rank.get(left) ?? Number.POSITIVE_INFINITY) -
      (rank.get(right) ?? Number.POSITIVE_INFINITY),
    );
    list.splice(0, list.length, ...unique);
  };

  sort(root.sessionIds);
  sort(root.terminalSessionIds);
  const visit = (node) => {
    sort(node.sessionIds);
    sort(node.terminalSessionIds);
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
}

function stripInternalTreeFields(root) {
  const visit = (node) => {
    delete node._key;
    delete node._parentKey;
    delete node._owner;
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
}

function addUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}
