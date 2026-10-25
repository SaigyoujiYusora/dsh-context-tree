import test from "node:test";
import assert from "node:assert/strict";
import { buildBranchNavigation } from "../lib/navigation.js";

function session(id, createdAt, messages, extra = {}) {
  return [
    id,
    {
      header: { id, createdAt, ...(extra.header ?? {}) },
      messages,
      events: extra.events ?? [],
      ...extra,
    },
  ];
}

function message(role, turn, text, extra = {}) {
  return { role, turn, text, nonText: false, ...extra };
}

function mapOf(...entries) {
  return new Map(entries);
}

function childByText(children, text) {
  return children.find((child) => child.text === text);
}

test("builds the root tree and retains every complete session path", () => {
  const sources = mapOf(
    session("root", 1, [
      message("user", 0, "hello", { messageId: "u0" }),
      message("assistant", 0, "world", { messageId: "a0" }),
    ]),
    session("later", 2, [
      message("user", 0, "hello", { messageId: "u0" }),
      message("assistant", 0, "world", { messageId: "a0" }),
      message("user", 1, "next", { messageId: "u1" }),
      message("assistant", 1, "answer", { messageId: "a1" }),
    ], { header: { parentSession: "root" } }),
  );

  const result = buildBranchNavigation(sources, "later");
  assert.deepEqual(result.tree.sessionIds, ["root", "later"]);
  assert.equal(result.tree.currentId, "later");
  assert.equal(result.tree.children.length, 1);
  assert.equal(result.tree.children[0].id, "u0");
  assert.deepEqual(result.tree.children[0].sessionIds, ["root", "later"]);
  assert.equal(result.tree.children[0].children[0].id, "a0");
  assert.equal(result.tree.children[0].children[0].children[0].id, "u1");
});

test("keeps a complete but intentionally truncated child path truncated", () => {
  const sources = mapOf(
    session("root", 1, [
      message("user", 0, "q"),
      message("assistant", 0, "a"),
      message("user", 1, "later"),
      message("assistant", 1, "later-a"),
    ]),
    session("cut", 2, [
      message("user", 0, "q"),
      message("assistant", 0, "a"),
    ], { header: { parentSession: "root" } }),
  );

  const result = buildBranchNavigation(sources, "cut");
  assert.equal(result.tree.children[0].children[0].children.length, 1);
  assert.deepEqual(result.tree.children[0].children[0].terminalSessionIds, ["cut"]);
});

test("creates an assistant regenerate group and selects a later descendant", () => {
  const sources = mapOf(
    session("root", 1, [
      message("user", 0, "question", { messageId: "u0" }),
      message("assistant", 0, "first", { messageId: "a0" }),
    ]),
    session("retry", 2, [
      message("user", 0, "question", { messageId: "u0" }),
      message("assistant", 0, "second", { messageId: "a-retry" }),
    ], {
      header: { parentSession: "root" },
      branch: { parentId: "root", role: "assistant", turn: 0, action: "regenerate" },
    }),
    session("retry-child", 3, [
      message("user", 0, "question", { messageId: "u0" }),
      message("assistant", 0, "second", { messageId: "a-retry" }),
      message("user", 1, "follow-up", { messageId: "u1" }),
      message("assistant", 1, "third", { messageId: "a1" }),
    ], { header: { parentSession: "retry" } }),
  );

  const result = buildBranchNavigation(sources, "retry-child");
  assert.deepEqual(result.assistant[0], {
    ids: ["root", "retry"],
    index: 1,
  });
  assert.equal(childByText(result.tree.children[0].children, "second").sessionIds.includes("retry"), true);
  assert.equal(result.tree.children[0].children[0].text, "first");
  assert.equal(result.tree.children[0].children[1].text, "second");
});

test("keeps user edits separate and truncates the old assistant context", () => {
  const sources = mapOf(
    session("root", 1, [
      message("user", 0, "old", { messageId: "u-old" }),
      message("assistant", 0, "old answer", { messageId: "a-old" }),
    ]),
    session("edited", 2, [
      message("user", 0, "new", { messageId: "u-new" }),
      message("assistant", 0, "new answer", { messageId: "a-new" }),
    ], {
      header: { parentSession: "root" },
      branch: { parentId: "root", role: "user", turn: 0, action: "edit-user" },
    }),
  );

  const result = buildBranchNavigation(sources, "edited");
  assert.deepEqual(result.user[0], { ids: ["root", "edited"], index: 1 });
  assert.equal(result.assistant[0], undefined);
  assert.equal(result.tree.children[0].text, "old");
  assert.equal(result.tree.children[1].text, "new");
  assert.equal(result.tree.children[1].children[0].text, "new answer");
});

test("handles cycles, missing parents, and empty session endpoints safely", () => {
  const sources = mapOf(
    session("root", 1, [message("user", 0, "root")]),
    session("empty", 2, [], {
      header: { parentSession: "root" },
      branch: { parentId: "root", role: "assistant", turn: 0, action: "regenerate" },
    }),
    session("orphan", 3, [message("user", 0, "orphan")], {
      header: { parentSession: "does-not-exist" },
    }),
    session("cycle-a", 4, [message("user", 0, "a")], {
      header: { parentSession: "cycle-b" },
    }),
    session("cycle-b", 5, [message("user", 0, "b")], {
      header: { parentSession: "cycle-a" },
    }),
  );

  const result = buildBranchNavigation(sources, "empty");
  assert.deepEqual(result.tree.sessionIds, ["root", "empty"]);
  assert.deepEqual(result.tree.terminalSessionIds, ["empty"]);
  assert.deepEqual(result.tree.children, [
    {
      id: "node-1",
      role: "user",
      turn: 0,
      text: "root",
      nonText: false,
      action: null,
      sessionIds: ["root"],
      terminalSessionIds: ["root"],
      children: [],
    },
  ]);

  assert.deepEqual(buildBranchNavigation(sources, "unknown"), {
    user: {},
    assistant: {},
    tree: null,
  });
});

test("keeps an explicit empty messages path empty", () => {
  const sources = mapOf(
    session("root", 1, [
      message("user", 0, "q"),
      message("assistant", 0, "a"),
    ]),
    session("empty", 2, [], {
      header: { parentSession: "root" },
      branch: { parentId: "root", role: "assistant", turn: 0, action: "regenerate" },
    }),
  );

  const result = buildBranchNavigation(sources, "empty");
  assert.deepEqual(result.tree.terminalSessionIds, ["empty"]);
  assert.deepEqual(result.tree.children[0].terminalSessionIds, []);
  assert.deepEqual(result.tree.children[0].children[0].terminalSessionIds, ["root"]);
});

test("does not merge same-text retries and distinguishes content keys", () => {
  const sources = mapOf(
    session("root", 1, [
      message("user", 0, "q", { messageId: "u" }),
      message("assistant", 0, "same", { messageId: "a0", contentKey: "plain" }),
    ]),
    session("retry-a", 2, [
      message("user", 0, "q", { messageId: "u" }),
      message("assistant", 0, "same", { messageId: "a1", contentKey: "attachment-a" }),
    ], {
      header: { parentSession: "root" },
      branch: { parentId: "root", role: "assistant", turn: 0, action: "regenerate" },
    }),
    session("retry-b", 3, [
      message("user", 0, "q", { messageId: "u" }),
      message("assistant", 0, "same", { messageId: "a2", contentKey: "attachment-b" }),
    ], {
      header: { parentSession: "root" },
      branch: { parentId: "root", role: "assistant", turn: 0, action: "regenerate" },
    }),
  );

  const result = buildBranchNavigation(sources, "retry-b");
  assert.deepEqual(result.assistant[0], {
    ids: ["root", "retry-a", "retry-b"],
    index: 2,
  });
  assert.equal(result.tree.children[0].children.length, 3);
  assert.deepEqual(
    result.tree.children[0].children.map((node) => node.text),
    ["same", "same", "same"],
  );
});

test("groups nested same-point forks and hides groups after an early fork", () => {
  const sources = mapOf(
    session("root", 1, [
      message("user", 0, "q"),
      message("assistant", 0, "a"),
      message("user", 1, "later"),
      message("assistant", 1, "later-a"),
    ]),
    session("retry-1", 2, [
      message("user", 0, "q"),
      message("assistant", 0, "b"),
      message("user", 1, "later"),
      message("assistant", 1, "later-b"),
    ], {
      header: { parentSession: "root" },
      branch: { parentId: "root", role: "assistant", turn: 0, action: "regenerate" },
    }),
    session("retry-2", 3, [
      message("user", 0, "q"),
      message("assistant", 0, "c"),
      message("user", 1, "later"),
      message("assistant", 1, "later-c"),
    ], {
      header: { parentSession: "retry-1" },
      branch: { parentId: "retry-1", role: "assistant", turn: 0, action: "regenerate" },
    }),
    session("early", 4, [message("user", 0, "edited")], {
      header: { parentSession: "root" },
      branch: { parentId: "root", role: "user", turn: 0, action: "edit-user" },
    }),
  );

  const nested = buildBranchNavigation(sources, "retry-2");
  assert.deepEqual(nested.assistant[0], {
    ids: ["root", "retry-1", "retry-2"],
    index: 2,
  });
  assert.equal(nested.assistant[1], undefined);

  const early = buildBranchNavigation(sources, "early");
  assert.equal(early.assistant[1], undefined);
});

test("infers legacy regenerate and edit-user branches from seeded events", () => {
  const rootEvents = [
    { seq: 0, type: "turn/start", data: { turn: 0 } },
    {
      seq: 1,
      type: "user/message",
      data: {
        id: "u0",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "q" }],
      },
      surfaceOp: "append",
    },
    {
      seq: 2,
      type: "assistant/message",
      data: {
        turn: 0,
        step: 1,
        message: {
          id: "a0",
          role: "assistant",
          content: [{ type: "text", text: "a" }],
        },
        stream: [],
      },
      surfaceOp: "append",
    },
  ];
  const retryEvents = [
    ...rootEvents,
    {
      seq: 3,
      type: "assistant/message",
      data: {
        turn: 0,
        step: 1,
        message: {
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "b" }],
        },
        stream: [],
      },
      surfaceOp: "append",
    },
  ];
  const editEvents = [
    ...rootEvents,
    {
      seq: 3,
      type: "user/message",
      data: {
        id: "u1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "edited" }],
      },
      surfaceOp: "append",
    },
    {
      seq: 4,
      type: "assistant/message",
      data: {
        turn: 0,
        step: 1,
        message: {
          id: "a2",
          role: "assistant",
          content: [{ type: "text", text: "c" }],
        },
        stream: [],
      },
      surfaceOp: "append",
    },
  ];
  const sources = mapOf(
    session("root", 1, undefined, { events: rootEvents }),
    session("retry", 2, undefined, {
      header: { parentSession: "root" },
      inheritedEventCount: rootEvents.length,
      events: retryEvents,
    }),
    session("edit", 3, undefined, {
      header: { parentSession: "root" },
      inheritedEventCount: rootEvents.length,
      events: editEvents,
    }),
  );

  const retry = buildBranchNavigation(sources, "retry");
  assert.deepEqual(retry.assistant[0], { ids: ["root", "retry"], index: 1 });
  const edit = buildBranchNavigation(sources, "edit");
  assert.deepEqual(edit.user[0], { ids: ["root", "edit"], index: 1 });
});
