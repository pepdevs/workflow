import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ADAPTERS, grokSpawnedId } from "../src/harnesses/index.ts";
import { modelRows, run, sessionStatus } from "../src/cli.ts";

const variants = "test/fixture-variants/grok";
const load = (id: string, root = variants) => ADAPTERS.grok.load(id, [root]);

test("Grok Build reads the launch header and result from session files", () => {
  const parent = "test/fixture-variants/grok-launch-result";
  const root = join(parent, "grok");
  const headSha = "a".repeat(40);
  const session = ADAPTERS.grok.load("fixture-da1dfc3f5e31", [root]);
  assert.match(session.turns[0].promptText ?? "", /^\[wf run skill=implement parent=grok:parent-id\]/);
  assert.deepEqual(session.result, { status: "complete", pullRequest: "https://github.com/fixture/workflow/pull/12", headSha });
  const judged = modelRows([session], [{ pullRequest: session.result!.pullRequest!, headSha, verdict: "PASS", createdAt: new Date(session.modelCalls.at(-1)!.endedAt).toISOString() }])[0];
  assert.deepEqual([judged.harness, judged.model, judged.skill, judged.judged, judged.passed], ["grok", "grok-4.7", "implement", 1, 1]);
  const summary = String(run(["summary", "grok", session.id, "--root", root]));
  assert.match(summary, /Launched\s+by wf run, skill implement, from grok parent-id/);
  assert.match(summary, /Result\s+complete · https:\/\/github.com\/fixture\/workflow\/pull\/12/);
  const day = new Date(session.modelCalls[0].endedAt).toISOString().slice(0, 10);
  const models = String(run(["models", "-k", "implement", "-d", `${day}..${day}`, "--root", parent]));
  assert.match(models, /implement\s+grok\s+grok-4\.7\s+1\s+1/);
});

test("Grok Build aggregates retain reported charge and estimated context", () => {
  const rows: [unknown, string | undefined][] = [
    ["Subagent started in background.\nsubagent_id: child-123\ntype: general-purpose", "child-123"],
    ["subagent_id: fixture-123", "fixture-123"],
    ["description mentions child-123", undefined],
    [null, undefined],
  ];
  for (const [value, expected] of rows) assert.equal(grokSpawnedId(value), expected);
  const session = load("fixture-da1dfc3f5e31");
  assert.equal(session.turns[0].model, "grok-4.7");
  assert.equal(sessionStatus({ ...session, modelCalls: [], toolCalls: [] }, session.turns[0].startedAt + 100).model, "grok-4.7");
  const call = session.modelCalls[0];
  assert.equal(call.kind, "turn_aggregate");
  assert.equal(call.provider, "xai");
  assert.equal(call.model, "grok-4.7");
  assert.equal(call.reportedCostUsd, 118027600 / 1e10);
  assert.equal(session.reportedCostUsd, call.reportedCostUsd);
  if (call.kind === "turn_aggregate") {
    assert.equal(call.callCount, 2);
    assert.ok(call.contextObservation);
    assert.notEqual(call.contextObservation.tokens, call.usage.input + call.usage.cacheRead);
  }
});

test("Grok Build resumed turns and missing files load once", () => {
  const oneCallTurns = load("fixture-ca0c91c464a4");
  assert.ok(oneCallTurns.modelCalls.every((call) => call.kind === "turn_aggregate" && call.callCount === 1));
  const resumed = load("fixture-0e9c7bc9a9f0");
  assert.equal(resumed.turns.length, 3);
  assert.equal(resumed.modelCalls.length, 3);
  assert.equal(new Set(resumed.modelCalls.map((call) => call.turnId)).size, 3);
  const compacted = load("fixture-2a784357d051");
  assert.equal(compacted.modelCalls.length, 23);
  assert.equal(compacted.compactions.length, 1);
  assert.equal(compacted.compactions[0].preTokens, 401326);
  assert.equal(compacted.compactions[0].postTokens, 10242);
  assert.match(String(run(["summary", "grok", compacted.id, "--root", variants])), /1 compactions/);
  assert.match(String(run(["summary", "grok", compacted.id, "--root", variants])), /401,326 → 10,242 tokens · charge unreported/);
  assert.ok(compacted.turns.some((turn) => turn.outcome === "interrupted"));
  const old = load("fixture-155048ba3f8d");
  assert.equal(old.modelCalls.length, 0);
  assert.equal(old.reportedCostUsd, null);
  const incompleteSummary = String(run(["summary", "grok", old.id, "--root", variants]));
  assert.match(incompleteSummary, /Tokens\s+unknown/);
  assert.match(incompleteSummary, /Cost\s+unknown/);
  assert.match(incompleteSummary, /Turn time\s+unknown/);
  assert.equal(run(["cost", "grok", old.id, "--root", variants]), "Cost unknown: no turn usage recorded.");
  assert.equal(run(["turns", "grok", old.id, "--root", variants]), "Turns unknown: no turn timing recorded.");
  assert.equal(run(["time", "grok", old.id, "--root", variants]), "Time unknown: no turn timing recorded.");
  const withoutSignals = ADAPTERS.grok.list(["test/fixture-variants/grok-missing-signals"]);
  assert.equal(withoutSignals.length, 1);
  assert.equal(ADAPTERS.grok.load(withoutSignals[0].ref, ["test/fixture-variants/grok-missing-signals"]).modelCalls.length, 1);
});

test("Grok Build joins children once across resumes and log roots", () => {
  const root = mkdtempSync("test/grok-roots-");
  try {
    cpSync("test/fixtures/grok", `${root}/live`, { recursive: true });
    cpSync("test/fixtures/grok", `${root}/archive`, { recursive: true });
    const roots = [`${root}/live`, `${root}/archive`];
    const listed = ADAPTERS.grok.list(roots);
    assert.equal(listed.length, 2); // the golden session first, then the wf run session
    const parent = ADAPTERS.grok.load(listed[0].ref, roots);
    assert.equal(parent.threads.length, 29);
    assert.equal(parent.incidents.filter((i) => i.kind === "incomplete child coverage").length, 25);
    assert.equal(parent.turns.length, 12);
    assert.equal(parent.modelCalls.length, 11);
    assert.equal(parent.toolCalls.length, 336);
    assert.equal(parent.reportedCostUsd, 15.91638712);
    for (const thread of parent.threads.filter((t) => t.parentId)) {
      const tool = parent.toolCalls.find((t) => t.id === thread.spawnedByToolCallId);
      assert.equal(tool?.spawnsThreadId, thread.id);
      assert.equal(tool?.threadId, thread.parentId);
    }
    for (const rows of [parent.modelCalls, parent.toolCalls]) {
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
      assert.ok(rows.every((r) => parent.turns.some((t) => t.id === r.turnId)));
    }
    const resumedId = "fixture-801af23300df";
    const childDir = `${root}/live/%2Ffixture%2Fproject/${resumedId}`;
    const updated = new Date("2030-01-01T00:00:00Z");
    for (const file of readdirSync(childDir)) utimesSync(`${childDir}/${file}`, updated, updated);
    assert.equal(ADAPTERS.grok.list(roots)[0].updatedAt, updated.getTime());
    assert.equal(parent.modelCalls.filter((c) => c.threadId === resumedId).length, 1);
    assert.equal(parent.toolCalls.filter((c) => c.threadId === resumedId).length, 12);
    const standalone = ADAPTERS.grok.load(resumedId, roots);
    assert.equal(standalone.modelCalls.length, 3);
    assert.equal(standalone.toolCalls.length, 102);

    // A missing predecessor still leaves its inherited usage available in the resumed child.
    for (const dir of roots) rmSync(`${dir}/%2Ffixture%2Fproject/fixture-52f2d43f917c`, { recursive: true });
    ADAPTERS.grok.list(roots);
    const missingSource = ADAPTERS.grok.load(listed[0].ref, roots);
    assert.equal(missingSource.modelCalls.length, parent.modelCalls.length);
    assert.equal(missingSource.toolCalls.length, parent.toolCalls.length);
    assert.equal(missingSource.reportedCostUsd, parent.reportedCostUsd);
    assert.equal(missingSource.incidents.length, 26);

    // Summary ancestry alone cannot hide a child whose spawning parent is unavailable.
    for (const dir of roots) rmSync(`${dir}/${listed[0].ref}`, { recursive: true });
    const unlinked = ADAPTERS.grok.list(roots);
    assert.equal(unlinked.length, 3); // two orphaned children and the wf run session
    assert.ok(unlinked.some((s) => s.id === resumedId));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wf archive preserves a Grok Build root and its subagents", () => {
  const root = mkdtempSync("test/grok-archive-");
  try {
    const live = join(root, "home", relative(homedir(), ADAPTERS.grok.archive!.live));
    mkdirSync(join(live, ".."), { recursive: true });
    symlinkSync(join(process.cwd(), "test/fixtures/grok"), live);
    const archive = join(root, "archive");
    const result = spawnSync(process.execPath, ["src/cli.ts", "archive"], {
      encoding: "utf8", env: { ...process.env, HOME: join(process.cwd(), root, "home"), WORKFLOW_ARCHIVE: join(process.cwd(), archive) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /grok\s+([1-9]\d*)\s+\1\s+0/);
    const listed = ADAPTERS.grok.list([live]);
    assert.equal(listed.length, 2); // the golden session first, then the wf run session
    const fromLive = ADAPTERS.grok.load(listed[0].ref, [live]);
    const fromArchive = ADAPTERS.grok.load(listed[0].ref, [join(archive, "grok")]);
    assert.ok(fromLive.threads.length > 1);
    assert.deepEqual(fromArchive, fromLive);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
