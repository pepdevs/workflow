import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ADAPTERS } from "../src/harnesses/index.ts";

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
