import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ADAPTERS } from "../src/harnesses/index.ts";

// An invented OpenCode 2.2 store: session_v2 and session_message, with a reply's
// tool calls inside its content.
function schema2Store(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    create table session_v2 (id text primary key, parent_id text, slug text, directory text, path text, title text, version text,
      share_url text, summary_diffs text, metadata text, revert text, permission text, cost real, time_created integer, time_updated integer);
    create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
  `);
  const session = db.prepare("insert into session_v2 values (?, ?, 'slug', '/work/api', null, ?, '2.2.5', null, null, null, null, null, ?, ?, ?)");
  session.run("ses_root", null, "Fix the parser", 0.03, 1000, 9000);
  session.run("ses_child", "ses_root", "Run the tests", 0.01, 3000, 5000);
  const message = db.prepare("insert into session_message values (?, ?, ?, ?, ?, ?, ?)");
  const model = { id: "grok-4.7", providerID: "xai", variant: "medium" };
  const tokens = { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } };
  const at = (created: number, completed: number) => ({ created, ran: created, completed });
  message.run("msg_1", "ses_root", "user", 1, 1000, 1000, JSON.stringify({ time: { created: 1000 }, text: "fix the parser", files: [], agents: [] }));
  message.run("msg_2", "ses_root", "assistant", 2, 1100, 6000, JSON.stringify({
    time: { created: 1100, completed: 6000 }, agent: "build", model, finish: "tool-calls", cost: 0.02, tokens,
    content: [
      { type: "reasoning", text: "plan" },
      { type: "tool", id: "call_bash", name: "bash", state: { status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "ok" }] }, time: at(2000, 2500) },
      { type: "tool", id: "call_read", name: "read", state: { status: "error", input: { filePath: "/work/api/missing.ts" }, error: { message: "not found" } }, time: at(2600, 2700) },
      { type: "tool", id: "call_task", name: "task", state: { status: "completed", input: {}, metadata: { sessionId: "ses_child" } }, time: at(3000, 5500) },
    ],
  }));
  message.run("msg_3", "ses_root", "assistant", 3, 6100, 7000, JSON.stringify({
    time: { created: 6100, completed: 7000 }, agent: "build", model, finish: "stop", cost: 0.01, tokens, content: [{ type: "text", text: "done" }],
  }));
  message.run("msg_4", "ses_root", "idle", 4, 7001, 7001, JSON.stringify({ time: { created: 7001 }, outcome: "succeeded" }));
  message.run("msg_5", "ses_child", "user", 1, 3000, 3000, JSON.stringify({ time: { created: 3000 }, text: "run the tests" }));
  message.run("msg_6", "ses_child", "assistant", 2, 3100, 5000, JSON.stringify({
    time: { created: 3100, completed: 5000 }, agent: "general", model, finish: "stop", cost: 0.01, tokens, content: [{ type: "text", text: "passed" }],
  }));
  db.close();
}

test("OpenCode reads a schema 2 store and cuts a fixture from it", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-opencode-"));
  try {
    const store = join(dir, "store.sqlite");
    schema2Store(store);
    assert.deepEqual(ADAPTERS.opencode.list([store]).map((r) => r.id), ["ses_root"]);

    const session = ADAPTERS.opencode.load("ses_root", [store]);
    assert.equal(session.harnessVersion, "2.2.5");
    assert.deepEqual(session.threads.map((t) => [t.id, t.parentId, t.agentType, t.spawnedByToolCallId]), [
      ["ses_root", null, null, null],
      ["ses_child", "ses_root", "general", "call_task"],
    ]);
    assert.deepEqual(session.turns.map((t) => [t.trigger, t.promptText, t.outcome, t.endedAt]), [
      ["prompt", "fix the parser", "completed", 7000],
      ["agent_message", "run the tests", "completed", 5000],
    ]);
    assert.deepEqual(session.modelCalls.map((c) => [c.model, c.effort, c.endedAt, c.usage.output]), [
      ["grok-4.7", "medium", 2000, 15],
      ["grok-4.7", "medium", 7000, 15],
      ["grok-4.7", "medium", 5000, 15],
    ]);
    assert.deepEqual(session.toolCalls.map((c) => [c.name, c.status, c.shellCategory !== null, c.spawnsThreadId, c.paths]), [
      ["bash", "ok", true, null, []],
      ["read", "failed", false, null, ["/work/api/missing.ts"]],
      ["task", "ok", false, "ses_child", []],
    ]);
    assert.equal(session.reportedCostUsd, 0.04);

    const out = join(dir, "fixture");
    ADAPTERS.opencode.cutFixture("ses_root", out, [store]);
    const cut = ADAPTERS.opencode.load("ses_root", [out]);
    assert.notEqual(cut.turns[0].promptText, "fix the parser");
    assert.deepEqual(cut.toolCalls.map((c) => [c.name, c.status, c.spawnsThreadId]), session.toolCalls.map((c) => [c.name, c.status, c.spawnsThreadId]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode skips a store without a session table it reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-opencode-"));
  try {
    const store = join(dir, "store.sqlite");
    new DatabaseSync(store).exec("create table session_v9 (id text)");
    assert.deepEqual(ADAPTERS.opencode.list([store]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
