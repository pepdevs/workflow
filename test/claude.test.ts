import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ADAPTERS } from "../src/harnesses/index.ts";
import { run } from "../src/cli.ts";

test("Claude Code compaction summaries start notification turns", () => {
  const root = mkdtempSync("test/claude-compact-");
  try {
    const id = "00000000-0000-4000-8000-000000000001";
    const record = (uuid: string, at: string, content: string, extra: object = {}) =>
      JSON.stringify({ type: "user", sessionId: id, uuid, timestamp: at, message: { role: "user", content }, ...extra });
    mkdirSync(join(root, "project"));
    writeFileSync(
      join(root, "project", `${id}.jsonl`),
      [
        record("u1", "2002-02-14T10:00:00.000Z", "Add the chart."),
        record("u2", "2002-02-14T11:00:00.000Z", "This session is being continued from a previous conversation.", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
        record("u3", "2002-02-14T11:05:00.000Z", "Merge it."),
      ].join("\n") + "\n",
    );
    const session = ADAPTERS.claude.load(id, [root]);
    assert.deepEqual(session.turns.map((t) => t.trigger), ["prompt", "notification", "prompt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude Code web calls carry their query or URL and form chains", () => {
  const root = mkdtempSync("test/claude-web-");
  try {
    const id = "00000000-0000-4000-8000-000000000002";
    const base = { sessionId: id, cwd: "/fixture" };
    const prompt = JSON.stringify({ ...base, type: "user", uuid: "u0", timestamp: "2002-02-14T10:00:00.000Z", message: { role: "user", content: "Find the sqlite options." } });
    const use = (n: number, at: string, calls: [string, object][]) => JSON.stringify({
      ...base, type: "assistant", uuid: `a${n}`, timestamp: at,
      message: { id: `m${n}`, model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: calls.map(([name, input], i) => ({ type: "tool_use", id: `t${n}${i}`, name, input })) },
    });
    const result = (n: number, at: string, count = 1) => JSON.stringify({
      ...base, type: "user", uuid: `r${n}`, timestamp: at,
      message: { role: "user", content: Array.from({ length: count }, (_, i) => ({ type: "tool_result", tool_use_id: `t${n}${i}`, content: "results" })) },
    });
    mkdirSync(join(root, "claude", "project"), { recursive: true });
    writeFileSync(join(root, "claude", "project", `${id}.jsonl`), [
      prompt,
      use(1, "2002-02-14T10:00:01.000Z", [["WebSearch", { query: "node sqlite DatabaseSync options" }], ["WebSearch", { query: "bun sqlite" }]]),
      result(1, "2002-02-14T10:00:05.000Z", 2),
      use(2, "2002-02-14T10:00:06.000Z", [["WebSearch", { query: "node sqlite DatabaseSync options docs" }]]),
      result(2, "2002-02-14T10:00:09.000Z"),
      use(3, "2002-02-14T10:00:10.000Z", [["WebFetch", { url: "https://nodejs.org/api/sqlite.html", prompt: "options" }]]),
      result(3, "2002-02-14T10:00:12.000Z"),
      use(4, "2002-02-14T10:00:13.000Z", [["Bash", { command: "ls" }]]),
      result(4, "2002-02-14T10:00:14.000Z"),
      use(5, "2002-02-14T10:00:15.000Z", [["WebSearch", { query: "other topic" }]]),
      result(5, "2002-02-14T10:00:17.000Z"),
    ].join("\n") + "\n");
    const session = ADAPTERS.claude.load(id, [join(root, "claude")]);
    assert.deepEqual(session.toolCalls.map((t) => t.web), [
      { action: "search", target: "node sqlite DatabaseSync options" },
      { action: "search", target: "bun sqlite" },
      { action: "search", target: "node sqlite DatabaseSync options docs" },
      { action: "open", target: "https://nodejs.org/api/sqlite.html" },
      null,
      { action: "search", target: "other topic" },
    ]);
    const calls = JSON.parse(String(run(["web", "-d", "2002-02-14", "--json", "--root", root]))).calls;
    assert.deepEqual(calls.map((c: any) => [c.tool, c.chain, c.position]), [["WebSearch", 0, 0], ["WebSearch", 0, 1], ["WebSearch", 0, 2], ["WebFetch", 0, 3], ["WebSearch", 1, 0]]);
    // Of four searches, one ran beside the first, one came after its results and rewords the first.
    assert.match(String(run(["web", "-d", "2002-02-14", "--root", root])), /claude\s+WebSearch\s+2\s+2\s+25%\s+25%\s+25%\s+50%\s+50%/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
