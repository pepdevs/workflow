// One table per pure function, with at least one row per value it returns.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ADAPTERS, lineRange, onlyWrittenSince, resultFromReply, shellReads, turnTriggerFromText, unquoteRunPrompt } from "../src/harnesses/index.ts";

test("unquoteRunPrompt", () => {
  const rows: [string, string, string][] = [
    ["wf run launch", '"[wf run skill=research parent=claude:c6c4]\ntask\n"', "[wf run skill=research parent=claude:c6c4]\ntask\n"],
    ["escaped inner quotes", '"search \\"GLM score\\" now"', 'search "GLM score" now'],
    ["one word stays quoted", '"word"', '"word"'],
    ["typed quotes stay", '"a" and "b"', '"a" and "b"'],
    ["plain prompt", "fix the build", "fix the build"],
    ["lone quote", '"', '"'],
  ];
  for (const [name, text, expected] of rows) assert.equal(unquoteRunPrompt(text), expected, name);
});

test("resultFromReply", () => {
  const good = '<!-- workflow-result: {"schema":1,"status":"complete","pullRequest":"https://github.com/fixture/workflow/pull/12","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"} -->';
  const blocked = '<!-- workflow-result: {"schema":1,"status":"blocked","pullRequest":null,"headSha":null} -->';
  const rows: [string, string, string | null][] = [
    ["valid", good, "complete"],
    ["blocked without PR", blocked, "blocked"],
    ["last marker wins", `${blocked}\n${good}`, "complete"],
    ["invalid last marker wins", `${good}\n<!-- workflow-result: broken -->`, null],
    ["malformed JSON", "<!-- workflow-result: broken -->", null],
    ["unsupported schema", good.replace('"schema":1', '"schema":2'), null],
    ["invalid PR URL", good.replace("github.com", "example.com"), null],
    ["short SHA", good.replace("a".repeat(40), "a".repeat(7)), null],
    ["no marker", "finished", null],
  ];
  for (const [name, reply, expected] of rows) assert.equal(resultFromReply(reply)?.status ?? null, expected, name);
});
import { terminalText, usd, eur, dur, table, categoryOf, planMatches, launchHeader, launchOf, gitLaunchInfo, repoFromRemote, parseRunCompletion, modelRows, modelTable, routeCounts, routesFrom, parseRouteEntry, run, summary, sessionProvenance, costCommand, filesCommand, turnsCommand, timeCommand, parentFromEnv, parseAmount, parseAt, parseChatGptUsage, parseClaudeUsage, parseCodexRateLimits, parseWhen, parseXaiBilling, parseZaiQuota, rankRoutes, readGithubEvaluations, usageCommand, windowPace, windowProjection, stepSpans, changedLines, parseReadings, readingLines, sessionStatus, statusPresentation, subagentStatus } from "../src/cli.ts";
import { checkMeasurement } from "../src/check.ts";
import { displayPath, CONTEXT_BUDGET, SIZE_BAND_M_MAX, SIZE_BAND_S_MAX, billingPeriods, classifyApiError, computeCostUsd, familyOf, modelName, SUBSCRIPTIONS, shellCategory, shellProgram, subscriptionOf, commandBranches, type Subscription, isRetired, routeList, ROUTE_RESERVED_PLANS } from "../src/catalog.ts";

test("Claude captures the first root record's branch once", () => {
  for (const initialBranch of [undefined, "initial-branch"]) {
    const dir = mkdtempSync(join(tmpdir(), "workflow-claude-start-"));
    const root = join(dir, "claude");
    const project = join(root, "project");
    const ref = join(project, "session.jsonl");
    const subagents = join(project, "session", "subagents");
    const record = (uuid: string, timestamp: string, gitBranch?: string) => ({
      type: "user", uuid, timestamp, ...(gitBranch ? { gitBranch } : {}), message: { role: "user", content: "prompt" },
    });
    try {
      mkdirSync(subagents, { recursive: true });
      const first = record("first", "2019-12-31T23:59:00Z", initialBranch);
      writeFileSync(ref, [first, record("later", "2020-01-01T00:01:00Z", "later-branch")].map((r) => JSON.stringify(r)).join("\n") + "\n");
      writeFileSync(join(subagents, "agent-child.jsonl"), JSON.stringify(record("child", "2020-01-01T00:02:00Z", "child-branch")) + "\n");
      assert.deepEqual(ADAPTERS.claude.load(ref, [root]).startGit, {
        ...(initialBranch ? { branch: initialBranch } : {}), at: Date.parse(first.timestamp),
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("Claude root turns stay apart when prompts share a promptId", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-claude-turns-"));
  const root = join(dir, "claude");
  const ref = join(root, "project", "session.jsonl");
  const prompt = (uuid: string, timestamp: string) => ({ type: "user", uuid, promptId: "shared", timestamp, message: { role: "user", content: `prompt ${uuid}` } });
  const reply = (id: string, timestamp: string) => ({
    type: "assistant", uuid: `r-${id}`, timestamp,
    message: { id, role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5 } },
  });
  try {
    mkdirSync(join(root, "project"), { recursive: true });
    const records = [prompt("first", "2020-01-01T00:00:00Z"), reply("m1", "2020-01-01T00:00:05Z"), prompt("second", "2020-01-01T01:00:00Z"), reply("m2", "2020-01-01T01:00:05Z")];
    writeFileSync(ref, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const s = ADAPTERS.claude.load(ref, [root]);
    assert.deepEqual(s.turns.map((t) => t.id), ["first", "second"]);
    assert.deepEqual(s.modelCalls.map((c) => [c.id, c.turnId]), [["m1", "first"], ["m2", "second"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session repository provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-provenance-"));
  const clone = join(dir, "clone");
  const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_PREFIX: undefined };
  try {
    execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "-q", "test/fixtures/repo.bundle", clone], { env });
    execFileSync("git", ["-C", clone, "switch", "-q", "-c", "fixture-main"], { env });
    const sha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim();
    const branch = execFileSync("git", ["-C", clone, "branch", "--show-current"], { env, encoding: "utf8" }).trim();
    const s = ADAPTERS.codex.load(ADAPTERS.codex.list(["test/fixtures/codex"])[0].ref, ["test/fixtures/codex"]);
    s.cwd = clone;
    s.startGit = { commit: sha, at: Date.now() + 60_000 };
    const entries = { "fixture/repo": { path: clone } };
    const first = s.turns.find((turn) => turn.threadId === s.id)!;
    first.promptText = "plain prompt";
    assert.deepEqual(sessionProvenance(s, true, entries), { repository: "fixture/repo (directory)", commit: `${sha} (harness SHA)` });
    first.promptText = `${launchHeader({ skill: null, parent: null, repo: "fixture/repo", commit: sha })}\nprompt`;
    assert.deepEqual(sessionProvenance(s, true, entries), { repository: "fixture/repo (header)", commit: `${sha} (header)` });
    first.promptText = `${launchHeader({ skill: null, parent: null, repo: "fixture/repo", commit: "a".repeat(40) })}\nprompt`;
    assert.match(sessionProvenance(s, true, entries).commit, /^unknown \(header .*commit absent from clone\)$/);
    first.promptText = "plain prompt";
    s.startGit = { branch, at: Date.now() + 60_000 };
    assert.equal(sessionProvenance(s, true, entries).commit, `${sha} (branch at start, est.)`);
    assert.match(sessionProvenance(s, false, entries).commit, /clone unavailable/);
    assert.match(sessionProvenance(s, true, { ...entries, "other/repo": { path: clone } }).repository, /matches multiple repositories/);
    s.cwd = join(dir, "elsewhere");
    assert.match(sessionProvenance(s, true, entries).repository, /matches no repository/);
    s.startGit = { commit: sha, at: Date.now() };
    const pattern = relative(process.cwd(), join(dir, "workflow-[0-9][0-9][0-9][0-9]-*"));
    const catalog = { "fixture/repo": { path: clone, worktrees: [pattern] } };
    const rows: [string, string, Record<string, { path: string; worktrees?: string[] }>, string][] = [
      ["removed worktree", join(dir, "workflow-0011-critique"), catalog, "fixture/repo (directory)"],
      ["removed worktree subdirectory", join(dir, "workflow-0011-critique", "src"), catalog, "fixture/repo (directory)"],
      ["ambiguous worktree", join(dir, "workflow-0011-critique"), { ...catalog, "other/repo": { path: clone, worktrees: [pattern] } }, "unknown (directory matches multiple repositories)"],
      ["unrelated repository", join(dir, "workflow-deprecated"), catalog, "unknown (directory matches no repository)"],
    ];
    for (const [label, cwd, repositories, expected] of rows) {
      s.cwd = cwd;
      const provenance = sessionProvenance(s, true, repositories);
      assert.equal(provenance.repository, expected, label);
      assert.equal(provenance.commit, expected.startsWith("fixture/repo") ? `${sha} (harness SHA)` : `unknown (harness SHA ${sha}: clone unavailable)`, label);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("commandBranches", () => {
  const rows: [string, string[]][] = [
    ["git checkout -b feat/x && git push -u origin feat/x", ["feat/x", "feat/x"]],
    ["git -C ../repo worktree add ../repo-1 -b fix/y origin/main", ["fix/y"]],
    ["git push --set-upstream origin \"docs/z\"", ["docs/z"]],
    ["git push origin HEAD:refs/heads/feat/q", ["feat/q"]],
    ["gh pr create --base main --head chore/w --title t", ["chore/w"]],
    ["git push origin --delete feat/x", []],
    ["git switch -c $BRANCH", []],
    ["git checkout main", []],
  ];
  for (const [command, branches] of rows) assert.deepEqual(commandBranches(command), branches, command);
});

test("shellProgram", () => {
  const rows: [string, string][] = [
    ["git status", "git"],
    ["/usr/bin/git log", "git"],
    ["cd repo && npm test", "npm"],
    ["FOO=1 node script.ts", "node"],
    ["export A=1; echo hi | rg x", "rg"],
    ["for f in *.md; do wc -l $f; done", "wc"],
    ["if true; then gh pr list; fi", "gh"],
    ["timeout 30 curl -s http://x", "curl"],
    ["sudo -n systemctl restart x", "systemctl"],
    ["echo only", "echo"],
    ["", ""],
  ];
  for (const [command, program] of rows) assert.equal(shellProgram(command), program, command);
});

test("shellCategory", () => {
  const rows: [string, string][] = [
    ["git diff", "vcs"],
    ["gh pr view 9", "forge"],
    ["rg -n TODO src", "search"],
    ["sed -n 1,20p file", "read"],
    ["sed -i s/a/b/ file", "file_write"],
    ["npm run check", "build_test"],
    ["python3 - <<EOF", "script"],
    ["ssh example-host uptime", "remote"],
    ["pkill node", "process"],
    ["mkdir -p out", "filesystem"],
    ["sqlite3 db.sqlite .tables", "database"],
    ["codex exec task", "agent_cli"],
    ["workflow supervise", "workflow"],
    ["hostname", "other"],
  ];
  for (const [command, category] of rows) assert.equal(shellCategory(command), category, command);
});

const usage = (u: Partial<Record<"input" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "output" | "reasoning", number>>) => ({
  input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, ...u,
});

test("shellReads", () => {
  const rows: [string, string[], string | null][] = [
    ["sed -n '80,200p' src/cli.ts", ["src/cli.ts"], "80-200"],
    ["sed -n 5p a.ts", ["a.ts"], "5-5"],
    ["cat a.md b.md", ["a.md", "b.md"], null],
    ["cd repo && head -n 40 README.md", ["README.md"], "1-40"],
    ["head -20 x.ts | nl", ["x.ts"], "1-20"],
    ["rg -n 'foo bar' src test", ["src", "test"], null],
    ["grep -e x -A 2 file.txt", ["file.txt"], null],
    ["cat \"$F\" 2>/dev/null", [], null],
    ["cat > out.txt <<'EOF'", [], null],
    ["git diff src/a.ts", [], null],
    ["wc -l src/*.ts", [], null],
    ["grep -n \"a \\|b\" src/x.ts | head", ["src/x.ts"], null],
    ["cat a.ts a.ts", ["a.ts"], null],
  ];
  for (const [command, paths, lines] of rows) assert.deepEqual(shellReads(command), { paths, lines }, command);
});

test("filesCommand", () => {
  type Session = Parameters<typeof filesCommand>[0];
  const at = Date.parse("2026-09-20T12:00Z");
  const read = (id: string, thread: string, turn: string, ago: number, chars: number, extra: { name?: string; paths?: string[]; command?: string; category?: string } = {}) => ({
    id, threadId: thread, turnId: turn, name: extra.name ?? "Read", category: extra.category ?? (extra.command ? "shell" : "file_read"),
    shellCategory: extra.command ? "read" : null, command: extra.command ?? null, origin: "model" as const,
    startedAt: at - ago * 1000, endedAt: at - ago * 1000 + 1, status: "ok" as const, spawnsThreadId: null,
    paths: extra.paths ?? ["/repo/src/a.ts"], lines: null, web: null, resultChars: chars, resultLines: Math.round(chars / 36.6), resultWords: Math.round(chars / 6.1),
  });
  const usage = { input: 10_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 };
  const call = (turn: string | null, ago: number, purpose: "turn" | "compaction") => ({
    id: `c${ago}`, threadId: "t", turnId: turn, provider: "anthropic", model: "claude-opus-5", effort: null,
    startedAt: at - ago * 1000, startInferred: false, endedAt: at - ago * 1000, usage, stopReason: "end_turn", purpose, reportedCostUsd: null,
  });
  const turn = (id: string, thread: string, ago: number) => ({ id, threadId: thread, trigger: "prompt" as const, promptText: null, startedAt: at - ago * 1000, endedAt: at - ago * 1000 + 500, outcome: "completed" as const });
  const session: Session = {
    harness: "claude-code", id: "s", title: null, cwd: "/repo", harnessVersion: null,
    threads: [{ id: "t", parentId: null, name: null, agentType: null, spawnedByToolCallId: null }, { id: "a", parentId: "t", name: "explorer: find files", agentType: "explorer", spawnedByToolCallId: "spawn" }],
    turns: [turn("u1", "t", 900), turn("u2", "t", 500), turn("au", "a", 450)],
    modelCalls: [call("u1", 890, "turn"), call(null, 600, "compaction")],
    toolCalls: [
      read("r1", "t", "u1", 880, 3660),
      read("r2", "t", "u2", 490, 366),
      read("r3", "t", "u2", 480, 732, { name: "Bash", command: "cat src/a.ts skills/x/SKILL.md", paths: ["src/a.ts", "/repo/skills/x/SKILL.md"] }),
      { ...read("spawn", "t", "u2", 470, 0), name: "Agent", category: "agent", paths: [], resultChars: null, resultLines: null, resultWords: null, spawnsThreadId: "a" },
      read("r4", "a", "au", 440, 366, { paths: ["/repo/AGENTS.md"] }),
      { ...read("w1", "t", "u2", 430, 0), name: "Edit", category: "file_write", resultChars: null, resultLines: null, resultWords: null },
    ],
    skills: [], incidents: [], compactions: [], quotaReadings: [], reportedCostUsd: null,
  };
  const out = filesCommand(session);
  assert.match(out, /^Reads +4 calls, 3 files, 1k tokens; root thread 1k, 13% of peak context 10k$/m);
  assert.match(out, /^Repeats +2 reads of 1 file, 200 tokens; 1 after a compaction$/m);
  assert.match(out, /^1 +src\/a\.ts +3 +1,2×2 +120 +720 +1k +yes +1$/m);
  assert.match(out, /^1 +skills\/x\/SKILL\.md +root +1 +2 +10 +60 +100$/m);
  assert.match(out, /^2 +AGENTS\.md +explorer +1 +2 +10 +60 +100$/m);
  assert.match(out, /^ *1 +1 +root +src\/a\.ts +100 +600 +1k$/m);
  assert.equal(filesCommand({ ...session, toolCalls: [] }), "No file reads with a path in this session.");
});

test("displayPath", () => {
  const aliases = { $skills: ["~/.h/skills", "~/.g/skills"], $session: ["~/.h/state/{session}", "/tmp/h-*/*/{session}"] };
  const win = "C:\\Users\\jane.doe";
  const rows: [string, string | null, string, [string, string] | null][] = [
    ["/repo/src/a.ts", "/repo", "src/a.ts", null],
    ["/repo-2/a.ts", "/repo", "/repo-2/a.ts", null],
    ["/home/example/.h/skills/git/SKILL.md", "/repo", "$skills/git/SKILL.md", ["$skills", "~/.h/skills"]],
    ["/home/example/notes.md", null, "~/notes.md", null],
    ["/Users/example/x", null, "~/x", null],
    ["/tmp/h-1000/-home-p/s1/scratchpad/a.txt", null, "$session/scratchpad/a.txt", ["$session", "/tmp/h-1000/-home-p/s1"]],
    ["/tmp/h-1000/-home-p/s2/a.txt", null, "/tmp/h-1000/-home-p/s2/a.txt", null],
    [`${win}\\.h\\state\\s1\\plan.md`, `${win}\\repo`, "$session/plan.md", ["$session", "~/.h/state/s1"]],
    [`c:\\users\\jane.doe\\repo\\src\\a.ts`, `${win}\\repo`, "src/a.ts", null],
    [`${win}\\Documents\\a.md`, null, "~/Documents/a.md", null],
  ];
  for (const [path, cwd, shown, alias] of rows) assert.deepEqual(displayPath(path, cwd, "s1", aliases), { path: shown, alias }, path);
});

test("lineRange", () => {
  const rows: [unknown, unknown, string | null][] = [[80, 120, "80-199"], [undefined, 50, "1-50"], [300, undefined, "300-"], [undefined, undefined, null], [1, undefined, null]];
  for (const [offset, limit, range] of rows) assert.equal(lineRange(offset, limit), range, `${offset} ${limit}`);
});

test("computeCostUsd", () => {
  const rows: [string, string, ReturnType<typeof usage>, number | null][] = [
    ["anthropic", "claude-opus-5", usage({ input: 1e6, output: 1e6 }), 30],
    ["anthropic", "claude-opus-5", usage({ cacheRead: 1e6 }), 0.5],
    ["anthropic", "claude-opus-5", usage({ cacheWrite: 1e6 }), 6.25],
    ["anthropic", "claude-opus-5", usage({ cacheWrite: 1e6, cacheWrite1h: 1e6 }), 10],
    ["anthropic", "claude-haiku-4-5-20251001", usage({ input: 1e6 }), 1],
    ["anthropic", "claude-opus-5-5", usage({ cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 1e6 }), 8.2],
    ["openai-codex", "gpt-5.6-sol", usage({ input: 1e5 }), 0.4],
    ["openai", "gpt-5.6-sol", usage({ input: 272_000, output: 1e5 }), 3.088],
    ["openai", "gpt-5.6-sol", usage({ input: 272_001, output: 1e5 }), 5.176008],
    ["xai", "grok-4.6", usage({ cacheRead: 199_990 }), 0.099995],
    ["xai", "grok-4.6", usage({ cacheRead: 200_000 }), 0.2],
    ["zai-coding-plan", "glm-5.3-flash", usage({ output: 1e6 }), 0.5],
    ["openrouter", "x-ai/grok-4.6", usage({ input: 1e5 }), 0.2],
    ["openrouter", "grok-4.6", usage({ input: 1e5 }), 0.2],
    ["openrouter", "stealth/union-alpha", usage({ input: 1e6, cacheRead: 1e6, output: 1e6 }), null],
    ["openrouter", "stealth/unknown", usage({ input: 1e6 }), null],
  ];
  for (const [provider, model, u, cost] of rows) {
    const got = computeCostUsd(provider, model, u);
    assert.equal(got === null ? null : Math.round(got * 1e6) / 1e6, cost, `${provider}/${model}`);
  }
});

test("classifyApiError", () => {
  const rows: [string, number | null, string][] = [
    ["Not Found", 404, "model_unavailable"],
    ["You've hit your usage limit", null, "usage_limit"],
    ["Too many requests", 429, "rate_limit"],
    ["rate limit reached", null, "rate_limit"],
    ["Overloaded", null, "overloaded"],
    ["stream terminated", null, "stream_terminated"],
    ["Unable to connect to API", null, "connection"],
    ["unauthorized", null, "unauthorized"],
    ["Internal server error", null, "server_error"],
    ["something else", null, "other"],
  ];
  for (const [text, status, kind] of rows) assert.equal(classifyApiError(text, status), kind, text);
});

test("turnTriggerFromText", () => {
  const rows: [string, string][] = [
    ["fix the bug", "prompt"],
    ["<command-name>/clarify</command-name>", "command"],
    ["<task-notification>done</task-notification>", "notification"],
  ];
  for (const [text, trigger] of rows) assert.equal(turnTriggerFromText(text), trigger, text);
});

test("subscriptionOf", () => {
  const rows: [string, string, string | null, string | null][] = [
    ["openai", "2026-08-01", null, "Example OpenAI Basic"],
    ["openai", "2026-08-31T23:59Z", "plus", "Example OpenAI Basic"],
    ["openai", "2026-09-10", "prolite", "Example OpenAI Pro"],
    ["openai", "2026-09-10", null, "Example OpenAI Pro"],
    ["openai", "2026-09-10", "plus", "Example OpenAI Shared"],
    ["openai-codex", "2026-09-10", null, "Example OpenAI Shared"],
    ["zai", "2026-09-01", null, "Example Zai Basic"],
    ["zai-coding-plan", "2026-09-07", null, "Example Zai Pro"],
    ["openrouter", "2026-09-10", null, null],
    ["anthropic", "1999-01-01", null, null],
  ];
  for (const [provider, at, plan, name] of rows) assert.equal(subscriptionOf(provider, Date.parse(at), plan)?.name ?? null, name, `${provider} ${at} ${plan}`);
});

test("billingPeriods", () => {
  const plan = (from: string, to: string | null): Subscription => ({ name: "p", monthly: 10, currency: "USD", from, to, providers: [] });
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
  const rows: [Subscription, string, [string, string, number, boolean][]][] = [
    [plan("2026-07-11", null), "2026-09-01", [["2026-07-11T00:00", "2026-08-11T00:00", 1, false], ["2026-08-11T00:00", "2026-09-11T00:00", 1, true]]],
    [plan("2026-08-01", "2026-08-16T12:00Z"), "2026-09-20", [["2026-08-01T00:00", "2026-08-16T12:00", 0.5, false]]],
    [plan("2026-01-31T05:30Z", null), "2026-03-01", [["2026-01-31T05:30", "2026-02-28T05:30", 1, false], ["2026-02-28T05:30", "2026-03-31T05:30", 1, true]]],
    [plan("2026-09-01", null), "2026-08-01", []],
  ];
  for (const [sub, until, periods] of rows) {
    const got = billingPeriods(sub, Date.parse(until)).map((p) => [iso(p.start), iso(p.end), p.share, p.current]);
    assert.deepEqual(got, periods, `${sub.from} ${sub.to} ${until}`);
  }
});

test("parseWhen", () => {
  const now = Date.parse("2026-09-25T12:00Z");
  const rows: [string, string, string][] = [
    ["2", "2026-09-23T12:00", "open"],
    ["6h", "2026-09-25T06:00", "open"],
    ["2026-09-20", "2026-09-20T00:00", "2026-09-21T00:00"],
    ["09-20", "2026-09-20T00:00", "2026-09-21T00:00"],
    ["09-01..09-07", "2026-09-01T00:00", "2026-09-08T00:00"],
    ["09-01..", "2026-09-01T00:00", "open"],
    ["..09-07", "open", "2026-09-08T00:00"],
    ["2026-09-24T01:00+02:00..", "2026-09-23T23:00", "open"],
    ["2026-09-20T06:30..2026-09-21", "2026-09-20T06:30", "2026-09-22T00:00"],
  ];
  const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16) : "open");
  for (const [text, from, to] of rows) {
    const r = parseWhen(text, now);
    assert.deepEqual([iso(r.from), iso(r.to)], [from, to], text);
  }
  assert.throws(() => parseWhen("yesterday", now), /bad date/);
});

test("parseAt", () => {
  const rows: [string, string][] = [
    ["2026-09-23T23:00", "2026-09-23T23:00:00.000Z"],
    ["2026-09-24T01:00+02:00", "2026-09-23T23:00:00.000Z"],
    ["2026-09-23T23:00Z", "2026-09-23T23:00:00.000Z"],
  ];
  for (const [text, iso] of rows) assert.equal(new Date(parseAt(text)).toISOString(), iso, text);
  assert.throws(() => parseAt("thursday"), /bad time/);
});

test("windowProjection", () => {
  const rows: [number, number, number, number, [number, number, number] | null][] = [
    [222.2, 74, 10080, 25.5, [300.3, 1305.7, 51.2]],
    [218.1, 66, 10080, 133.4, [330.5, 1437.0, 10.8]],
    [50, 100, 10080, 100, [50, 217.4, 2.2]],
    [10, 0, 10080, 25.5, null],
  ];
  const round = (n: number) => Math.round(n * 10) / 10;
  for (const [cost, used, minutes, price, want] of rows) {
    const p = windowProjection(cost, used, minutes, price);
    assert.deepEqual(p && [round(p.window), round(p.month), round(p.multiplier)], want, `${cost} ${used}`);
  }
});

test("stepSpans", () => {
  const rows: [number[], number, [number, number][]][] = [
    [[0, 4, 10, 12, 21, 30], 10, [[0, 2], [2, 4]]],
    [[5, 5, 9], 10, []],
    [[40, 38, 50], 10, [[0, 2]]],
    [[], 10, []],
  ];
  for (const [used, step, want] of rows) assert.deepEqual(stepSpans(used, step), want, used.join(","));
});

test("recorded usage readings", () => {
  const at = Date.parse("2026-09-28T14:00Z");
  const resetsAt = Date.parse("2026-09-30T23:00Z");
  const window = (minutes: number | null, usedPercent: number | null) => ({ minutes, usedPercent, resetsAt });
  const usage = (provider: string, windows: ReturnType<typeof window>[], error: string | null = null) => ({ source: provider, provider, plan: null, planType: provider === "openai" ? "prolite" : null, windows, error });
  const lines = readingLines([usage("anthropic", [window(10080, 75), window(300, 12), window(null, 5)]), usage("openai", [window(10080, 66)]), usage("zai", [], "timeout")], at);
  assert.deepEqual(lines.map((l) => [l.provider, l.plan, l.windowMinutes, l.usedPercent]), [["anthropic", null, 10080, 75], ["anthropic", null, 300, 12], ["openai", "prolite", 10080, 66]]);
  const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n{"at":1}\n`;
  const recorded = parseReadings(text);
  assert.deepEqual(recorded.map((r) => [r.provider, r.windowMinutes, r.usedPercent, r.threadId]), [["anthropic", 10080, 75, "recorded"], ["anthropic", 300, 12, "recorded"], ["openai", 10080, 66, "recorded"]]);
  // Unchanged shares are skipped, a reset time a few seconds off is the same window, and a new share or window is kept.
  const next = readingLines([usage("anthropic", [{ ...window(10080, 75), resetsAt: resetsAt + 5_000 }, window(300, 20)]), usage("openai", [{ ...window(10080, 0), resetsAt: resetsAt + 7 * 86_400_000 }])], at + 900_000);
  assert.deepEqual(changedLines(recorded, next).map((l) => [l.provider, l.windowMinutes, l.usedPercent]), [["anthropic", 300, 20], ["openai", 10080, 0]]);
});

test("subscriptions keep two plans on one provider apart in their weekly windows", () => {
  const pro = SUBSCRIPTIONS.find((s) => s.name === "Example Anthropic")!;
  const saved = pro.to;
  const readings = parseReadings(readFileSync("test/fixtures/usage-readings.jsonl", "utf8")).filter((reading) => reading.provider === "anthropic");
  const middle = new Date((readings[0].at + readings.at(-1)!.at) / 2).toISOString();
  pro.to = middle;
  SUBSCRIPTIONS.unshift({ name: "Example Anthropic Upgrade", monthly: 200, currency: "EUR", from: middle, to: null, providers: ["anthropic"] });
  try {
    const out = String(run(["subscriptions", "--weeks", "--root", "test/fixtures"])).split("Per weekly window")[1];
    assert.match(out, /^Example Anthropic\s+20\d\d-\d\d-\d\d/m);
    assert.match(out, /^Example Anthropic Upgrade\s+20\d\d-\d\d-\d\d/m);
  } finally {
    SUBSCRIPTIONS.shift();
    pro.to = saved;
  }
});

test("parseAmount", () => {
  const rows: [string, number, number][] = [
    ["5", 5, Infinity],
    ["1..5", 1, 5],
    ["..0.5", -Infinity, 0.5],
    ["2..", 2, Infinity],
  ];
  for (const [text, from, to] of rows) assert.deepEqual(parseAmount(text), { from, to }, text);
  assert.throws(() => parseAmount("five"), /bad amount/);
});

test("sessionStatus", () => {
  type Session = Parameters<typeof sessionStatus>[0];
  const min = 60_000;
  const at = Date.parse("2026-09-20T12:00Z");
  const usage = (context: number) => ({ input: context, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1_000, reasoning: 0 });
  const call = (ago: number, stopReason: string, context = 10_000) => ({
    id: `c${ago}`, threadId: "t", turnId: "u", provider: "anthropic", model: "claude-opus-5", effort: null,
    startedAt: at - ago * min - 1_000, startInferred: false, endedAt: at - ago * min, usage: usage(context),
    stopReason, purpose: "turn" as const, reportedCostUsd: null,
  });
  const tool = (ago: number, done: boolean, extra: { category?: string; command?: string; status?: "ok" | "failed" } = {}) => ({
    id: `x${ago}`, threadId: "t", turnId: "u", name: "Bash", category: extra.category ?? "shell",
    shellCategory: null, command: extra.command ?? null, origin: "model" as const,
    startedAt: at - ago * min, endedAt: done ? at - ago * min + 1_000 : null, status: extra.status ?? "ok", spawnsThreadId: null, paths: [], lines: null, web: null, resultChars: null, resultLines: null, resultWords: null,
  });
  const session = (calls: Session["modelCalls"], tools: ReturnType<typeof tool>[] = []): Session => ({
    harness: "claude-code", id: "s", title: null, cwd: null, harnessVersion: null,
    threads: [{ id: "t", parentId: null, name: null, agentType: null, spawnedByToolCallId: null }],
    turns: [{ id: "u", threadId: "t", trigger: "prompt", promptText: null, startedAt: at - 45 * min, endedAt: at - 45 * min, outcome: "unknown" }],
    modelCalls: calls, toolCalls: tools, skills: [], incidents: [], compactions: [], quotaReadings: [], reportedCostUsd: null,
  });
  const rows: [string, Session, string, string[]][] = [
    ["asked for tools, recent event", session([call(1, "tool_use")]), "working", []],
    ["asked for tools, quiet 12 minutes", session([call(12, "tool_use")]), "stuck", []],
    ["shell running 40 minutes", session([call(40, "tool_use")], [tool(40, false)]), "stuck", []],
    ["asking the person", session([call(20, "tool_use")], [tool(20, false, { category: "user_interaction" })]), "waiting", []],
    ["turn ended", session([call(1, "end_turn")]), "idle", []],
    ["call after the evaluation time", session([call(-5, "end_turn"), call(1, "tool_use")]), "working", []],
    ["same command repeated", session([call(1, "tool_use")], [2, 3, 4, 5].map((m) => tool(m, true, { command: "npm test" }))), "working", ["same command ×4: npm test"]],
    ["failing tools", session([call(1, "tool_use")], [2, 3, 4, 5, 6].map((m) => tool(m, true, { status: "failed" }))), "working", ["5 of the last 10 tool calls failed"]],
    ["context over budget", session([call(1, "tool_use", 250_000)]), "working", ["context 250k"]],
    ["hourly cost", session([{ ...call(1, "tool_use"), usage: { ...usage(10_000), output: 1_000_000 } }]), "working", ["$25.1 in the last hour"]],
    ["compactions", session([call(1, "tool_use"), ...[2, 3].map((ago) => ({ ...call(ago, "end_turn"), purpose: "compaction" as const, turnId: null }))]), "working", ["2 compactions in the last hour"]],
    ["incidents", { ...session([call(1, "tool_use")]), incidents: [{ turnId: "u", threadId: "t", at: at - min, kind: "connection", detail: "private error text" }] }, "working", ["connection ×1"]],
  ];
  for (const [name, s, state, flags] of rows) {
    const st = sessionStatus(s, at);
    assert.equal(st.state, state, name);
    assert.deepEqual(st.flags, flags, name);
    const kinds: Record<string, string> = { "same command repeated": "repeated command", "failing tools": "failed tools", "context over budget": "context budget", "hourly cost": "hourly cost", compactions: "compactions", incidents: "incidents" };
    assert.deepEqual(st.flagKinds, kinds[name] ? [kinds[name]] : [], name);
  }
  // A subagent call logged after the root thread's calls does not name the session's model.
  const withAgent = session([call(2, "tool_use"), call(1, "tool_use")]);
  withAgent.threads.push({ id: "a", parentId: "t", name: null, agentType: null, spawnedByToolCallId: null });
  withAgent.modelCalls.splice(1, 0, { ...call(5, "end_turn"), id: "sub", threadId: "a", model: "claude-sonnet-5" });
  withAgent.modelCalls.push({ ...call(3, "end_turn"), id: "sub2", threadId: "a", model: "claude-sonnet-5" });
  assert.equal(sessionStatus(withAgent, at).model, "claude-opus-5", "root model despite later-logged subagent calls");
});

test("subagentStatus", () => {
  type Session = Parameters<typeof subagentStatus>[0];
  const min = 60_000;
  const at = Date.parse("2026-09-20T12:00Z");
  const usage = { input: 10_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1_000, reasoning: 0 };
  const call = (thread: string, ago: number, stopReason: string, model = "claude-sonnet-5") => ({
    id: `${thread}${ago}`, threadId: thread, turnId: `${thread}u`, provider: "anthropic", model, effort: null,
    startedAt: at - ago * min - 1_000, startInferred: false, endedAt: at - ago * min, usage,
    stopReason, purpose: "turn" as const, reportedCostUsd: null,
  });
  const turn = (thread: string, ago: number, open = false) => ({ id: `${thread}u`, threadId: thread, trigger: "agent_message" as const, promptText: null, startedAt: at - ago * min, endedAt: open ? null : at - ago * min, outcome: "unknown" as const });
  const spawn = (id: string, thread: string, child: string, ago: number, done: boolean) => ({
    id, threadId: thread, turnId: `${thread}u`, name: "Agent", category: "agent", shellCategory: null, command: null, origin: "model" as const,
    startedAt: at - ago * min, endedAt: done ? at - min : null, status: "ok" as const, spawnsThreadId: child, paths: [], lines: null, web: null, resultChars: null, resultLines: null, resultWords: null,
  });
  const thread = (id: string, parentId: string | null, name: string | null = null) => ({ id, parentId, name, agentType: null, spawnedByToolCallId: null });
  const session = (threads: Session["threads"], turns: Session["turns"], calls: Session["modelCalls"], tools: Session["toolCalls"]): Session => ({
    harness: "claude-code", id: "s", title: null, cwd: null, harnessVersion: null,
    threads: [thread("t", null), ...threads], turns: [turn("t", 30), ...turns], modelCalls: [call("t", 1, "tool_use", "claude-opus-5"), ...calls], toolCalls: tools,
    skills: [], incidents: [], compactions: [], quotaReadings: [], reportedCostUsd: null,
  });
  const rows: [string, Session, [string, number, string, string][]][] = [
    ["spawn tool open", session([thread("a", "t", "explore")], [turn("a", 5)], [call("a", 2, "end_turn")], [spawn("x", "t", "a", 5, false)]), [["a", 1, "working", "claude-sonnet-5"]]],
    ["spawn tool ended", session([thread("a", "t")], [turn("a", 5)], [call("a", 2, "end_turn")], [spawn("x", "t", "a", 5, true)]), []],
    ["no spawn link, turn open", session([thread("a", "t")], [turn("a", 5, true)], [call("a", 2, "tool_use")], []), [["a", 1, "working", "claude-sonnet-5"]]],
    ["quiet 12 minutes", session([thread("a", "t")], [turn("a", 20)], [call("a", 12, "tool_use")], [spawn("x", "t", "a", 20, false)]), [["a", 1, "stuck", "claude-sonnet-5"]]],
    ["nested after its parent", session([thread("a", "t"), thread("b", "a")], [turn("a", 5), turn("b", 4)], [call("a", 3, "tool_use"), call("b", 2, "tool_use")], [spawn("x", "t", "a", 5, false), spawn("y", "a", "b", 4, false)]), [["a", 1, "working", "claude-sonnet-5"], ["b", 2, "working", "claude-sonnet-5"]]],
    ["spawned after the evaluation time", session([thread("a", "t")], [turn("a", -5)], [call("a", -6, "tool_use")], [spawn("x", "t", "a", -5, false)]), []],
  ];
  for (const [name, s, expected] of rows) {
    assert.deepEqual(subagentStatus(s, at).map((a) => [a.threadId, a.depth, a.state, a.model]), expected, name);
  }
});

test("statusPresentation", () => {
  type Row = Parameters<typeof statusPresentation>[0][number];
  const rows = (state: Row["state"], count: number, pids: number[] = [], running = "sleep 0:08:19") => Array.from({ length: count }, () => ({ state, pids, running }));
  const cases: [string, Row[], number, boolean, string, string[]][] = [
    ["running and ended", [...rows("working", 1, [1]), ...rows("ended", 7)], 11, true, "1 running (1 working), 7 ended without a process. 11 finished sessions hidden; wf ls -d1h lists them.", ["sleep 0:08:19", ...Array(7).fill("-")]],
    ["running only", rows("working", 1, [1]), 0, true, "1 running (1 working).", ["sleep 0:08:19"]],
    ["ended only", rows("ended", 7), 0, true, "0 running, 7 ended without a process.", Array(7).fill("-")],
    ["no listed rows", [], 11, true, "No active sessions. 11 finished sessions hidden; wf ls -d1h lists them.", []],
    ["live state order", [...rows("idle", 1, [1]), ...rows("working", 1, [2]), ...rows("waiting", 1, [3]), ...rows("stuck", 1, [4])], 0, true, "4 running (1 stuck, 1 waiting, 1 working, 1 idle).", Array(4).fill("sleep 0:08:19")],
    ["unknown processes", [...rows("working", 1, [1]), ...rows("ended", 7)], 0, false, "8 active sessions: 7 ended, 1 working.", Array(8).fill("sleep 0:08:19")],
  ];
  for (const [name, listed, hidden, processesKnown, header, running] of cases) {
    assert.deepEqual(statusPresentation(listed, hidden, processesKnown), { header, running }, name);
  }
});

test("onlyWrittenSince", () => {
  const p = { pid: 7, comm: "pi", cwd: "/w", startedAt: 10_000, startTicks: "1" };
  const ref = (id: string, updatedAt: number) => ({ ref: id, id, updatedAt });
  const rows: [string, ReturnType<typeof ref>[], string | null][] = [
    ["one written since start", [ref("old", 5_000), ref("new", 12_000)], "new"],
    ["written just before the /proc start time", [ref("new", 9_500)], "new"],
    ["none written since start", [ref("old", 5_000)], null],
    ["several written since start", [ref("a", 11_000), ref("b", 12_000)], null],
  ];
  for (const [name, refs, id] of rows) assert.equal(onlyWrittenSince(p, refs)?.id ?? null, id, name);
});

test("launch", () => {
  const o = { model: "m", prompt: "task", effort: null };
  const rows: [keyof typeof ADAPTERS, boolean, string][] = [
    ["claude", false, "claude -p task --model m --output-format json --tools Read,Grep,Glob,WebFetch,WebSearch --strict-mcp-config --allowedTools Read,Grep,Glob,WebFetch,WebSearch"],
    ["claude", true, "claude -p task --model m --output-format json --dangerously-skip-permissions"],
    ["codex", false, "codex exec --skip-git-repo-check --json -m m -s read-only task"],
    ["codex", true, "codex exec --skip-git-repo-check --json -m m --dangerously-bypass-approvals-and-sandbox task"],
    ["pi", false, "pi -p --mode json --model m --tools read,grep,find,ls task"],
    ["pi", true, "pi -p --mode json --model m task"],
    ["grok", false, "grok -p task -m m --output-format json --tools read_file,list_dir,grep --permission-mode plan"],
    ["grok", true, "grok -p task -m m --output-format json --always-approve --permission-mode bypassPermissions"],
    ["opencode", false, "opencode run --format json -m m --agent plan task"],
    ["opencode", true, "opencode run --format json -m m --auto task"],
  ];
  for (const [h, write, line] of rows) {
    const l = ADAPTERS[h].launch({ ...o, write });
    assert.equal([l.command, ...l.args].join(" "), line, `${h} ${write}`);
  }
  assert.deepEqual(ADAPTERS.grok.launch({ ...o, write: false, effort: "high" }).args.slice(-2), ["--reasoning-effort", "high"]);
});

test("result", () => {
  const rows: [keyof typeof ADAPTERS, string, string | null, string | null][] = [
    ["claude", '{"type":"result","session_id":"c1","result":"ok"}', "c1", "ok"],
    ["claude", "not json", null, null],
    ["codex", '{"type":"thread.started","thread_id":"x1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"first"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}', "x1", "ok"],
    ["pi", '{"type":"session","id":"p1"}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"t"},{"type":"text","text":"ok"}]}}', "p1", "ok"],
    ["pi", '{"type":"session","id":"p1"}', "p1", null],
    ["grok", '{"sessionId":"g1","text":"ok","stopReason":"end_turn"}', "g1", "ok"],
    ["grok", '{"sessionId":"g1","stopReason":"error"}', "g1", null],
    ["grok", "not json", null, null],
    ["opencode", '{"type":"step_start","sessionID":"s1"}\n{"type":"text","sessionID":"s1","part":{"text":"old"}}\n{"type":"step_start","sessionID":"s1"}\n{"type":"text","sessionID":"s1","part":{"text":"ok"}}', "s1", "ok"],
  ];
  for (const [h, stdout, id, reply] of rows) assert.deepEqual(ADAPTERS[h].result(stdout), { id, reply }, `${h} ${stdout.slice(0, 30)}`);
});

test("parseRunCompletion", () => {
  const rows: [Record<string, string>, ReturnType<typeof parseRunCompletion>][] = [
    [{}, null],
    [{ plan: "fixture/workflow#12" }, null],
    [{ "done-file": "report with spaces.md", "max-attempts": "1" }, { check: { kind: "file", value: "report with spaces.md" }, maxAttempts: 1 }],
    [{ "done-command": "test -f report.md && test -f findings.json", "max-attempts": "4" }, { check: { kind: "command", value: "test -f report.md && test -f findings.json" }, maxAttempts: 4 }],
  ];
  for (const [flags, expected] of rows) assert.deepEqual(parseRunCompletion(flags), expected);
  const invalid: Record<string, string>[] = [
    { "max-attempts": "2" },
    { "done-file": "REPORT.md" },
    { "done-command": "true" },
    { "done-file": "REPORT.md", "done-command": "true", "max-attempts": "2" },
    { "done-file": "", "max-attempts": "2" },
    { "done-command": "  ", "max-attempts": "2" },
    ...["0", "-1", "1.5", "NaN", "2abc", "Infinity", "9007199254740992"].map((count) => ({ "done-file": "REPORT.md", "max-attempts": count })),
  ];
  for (const flags of invalid) assert.throws(() => parseRunCompletion(flags), /wf run needs/);
  for (const args of [
    ["--done-file"], ["--done-command"], ["--max-attempts"],
    ["--done-file", "--max-attempts", "2"],
    ["--done-file", "REPORT.md", "--done-file", "OTHER.md", "--max-attempts", "2"],
    ["--done-file", "REPORT.md", "--done-command", "true", "--max-attempts", "2"],
    ["--done-file", "REPORT.md"], ["--max-attempts", "2"],
  ]) assert.throws(() => run(["run", "codex", "fake-model", "-i", "missing-task.md", ...args]), /wf run/);
});

test("launchOf", () => {
  type Session = Parameters<typeof launchOf>[0];
  const withPrompt = (promptText: string): Session => ({
    harness: "codex", id: "s", title: null, cwd: null, harnessVersion: null,
    threads: [{ id: "t", parentId: null, name: null, agentType: null, spawnedByToolCallId: null }],
    turns: [{ id: "u", threadId: "t", trigger: "prompt", promptText, startedAt: 0, endedAt: 0, outcome: "completed" }],
    modelCalls: [], toolCalls: [], skills: [], incidents: [], compactions: [], quotaReadings: [], reportedCostUsd: null,
  });
  const rows: [string, ReturnType<typeof launchOf>][] = [
    ["plain prompt", null],
    ["[wf run skill=critique parent=claude:c6c4]\ntask", { skill: "critique", parent: { harness: "claude", id: "c6c4" } }],
    ["[wf run skill=implement parent=claude:c6c4 plan=fixture/workflow#0007]\ntask", { skill: "implement", parent: { harness: "claude", id: "c6c4" }, plan: "fixture/workflow#0007" }],
    [`${launchHeader({ skill: "critique", parent: { harness: "claude", id: "c6c4" } })}\ntask`, { skill: "critique", parent: { harness: "claude", id: "c6c4" } }],
    [`${launchHeader({ skill: null, parent: null })}\ntask`, { skill: null, parent: null }],
    [`${launchHeader({ skill: "implement", parent: { harness: "claude", id: "c6c4" }, plan: "fixture/workflow#0007" })}\ntask`, { skill: "implement", parent: { harness: "claude", id: "c6c4" }, plan: "fixture/workflow#0007" }],
    [`${launchHeader({ skill: "implement", parent: null, repo: "fixture/workflow", commit: "a".repeat(40) })}\ntask`, { skill: "implement", parent: null, repo: "fixture/workflow", commit: "a".repeat(40) }],
    [`${launchHeader({ skill: "implement", parent: null, plan: "fixture/workflow#96", repo: "fixture/workflow", commit: "b".repeat(40) })}\ntask`, { skill: "implement", parent: null, plan: "fixture/workflow#96", repo: "fixture/workflow", commit: "b".repeat(40) }],
    [`${launchHeader({ skill: null, parent: null, repo: "fixture/workflow" })}\ntask`, { skill: null, parent: null, repo: "fixture/workflow" }],
    [`${launchHeader({ skill: null, parent: null, commit: "c".repeat(40) })}\ntask`, { skill: null, parent: null, commit: "c".repeat(40) }],
    ["[wf run skill=x parent=nowhere:1]", { skill: "x", parent: null }],
  ];
  for (const [prompt, launch] of rows) assert.deepEqual(launchOf(withPrompt(prompt)), launch, prompt);
});

test("repoFromRemote", () => {
  const rows: [string, string | null][] = [
    ["https://github.com/fixture/workflow.git", "fixture/workflow"],
    ["https://user:secret@github.com/fixture/workflow.git", "fixture/workflow"],
    ["git@github.com:fixture/workflow.git", "fixture/workflow"],
    ["ssh://git@github.com/fixture/workflow.git", "fixture/workflow"],
    ["/local/workflow", null],
    ["https://github.com/fixture/extra/workflow.git", null],
  ];
  for (const [remote, repo] of rows) assert.equal(repoFromRemote(remote), repo, remote);
});

test("gitLaunchInfo", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wf-launch-"));
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
  try {
    assert.deepEqual(gitLaunchInfo(cwd), {});
    git("init", "-q");
    assert.deepEqual(gitLaunchInfo(cwd), {});
    git("remote", "add", "origin", "https://user:secret@github.com/fixture/workflow.git");
    assert.deepEqual(gitLaunchInfo(cwd), { repo: "fixture/workflow" });
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "initial");
    const commit = git("rev-parse", "HEAD");
    assert.deepEqual(gitLaunchInfo(cwd), { repo: "fixture/workflow", commit });
    git("remote", "remove", "origin");
    assert.deepEqual(gitLaunchInfo(cwd), { commit });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parentFromEnv", () => {
  const openCode = (pid: number) => (pid === 7 ? "ses_1" : null);
  const rows: [Record<string, string>, ReturnType<typeof parentFromEnv>][] = [
    [{}, null],
    [{ GROK_SESSION_ID: "g1", CODEX_THREAD_ID: "x1" }, { harness: "grok", id: "g1" }],
    [{ CLAUDE_CODE_SESSION_ID: "c1" }, { harness: "claude", id: "c1" }],
    [{ CODEX_THREAD_ID: "x1", CLAUDE_CODE_SESSION_ID: "c1" }, { harness: "codex", id: "x1" }],
    [{ PI_SESSION_FILE: "/s/--w--/2026-09-26T06-03-25-018Z_01a0dc4f.jsonl", CLAUDE_CODE_SESSION_ID: "c1" }, { harness: "pi", id: "01a0dc4f" }],
    [{ OPENCODE_PID: "7", CLAUDE_CODE_SESSION_ID: "c1" }, { harness: "opencode", id: "ses_1" }],
    [{ OPENCODE_PID: "8", CLAUDE_CODE_SESSION_ID: "c1" }, { harness: "claude", id: "c1" }],
  ];
  for (const [env, parent] of rows) assert.deepEqual(parentFromEnv(env, openCode), parent, JSON.stringify(env));
});

test("routeList and isRetired", () => {
  assert.deepEqual(routeList("evaluate").slice(0, 3), ["codex gpt-6.1-sol", "claude claude-opus-5-5", "pi zai/glm-5.3"]);
  assert.deepEqual(routeList("unlisted"), ["claude claude-sonnet-5-5", "codex gpt-6.1-sol", "pi zai/glm-5.3-flash"]);
  const rows: [string, boolean][] = [
    ["claude-opus-5-5", false], ["gpt-6.1-sol", false], ["gpt-6-sol", true], ["claude-haiku-4-5-20251001", true],
    ["gpt-5.6-sol", true], ["gpt-5.6-terra", true], ["stealth/union-alpha", false],
  ];
  for (const [model, retired] of rows) assert.equal(isRetired(model), retired, model);
});

test("parseRouteEntry", () => {
  const valid: [string, string, string][] = [
    ["codex gpt-6-sol", "openai", "gpt-6-sol"],
    ["pi zai/glm-5.3", "zai", "glm-5.3"],
    ["opencode zai-coding-plan/glm-5.3", "zai-coding-plan", "glm-5.3"],
  ];
  for (const [entry, provider, name] of valid) {
    const route = parseRouteEntry(entry);
    assert.deepEqual([route.provider, route.name], [provider, name], entry);
  }
  const invalid = ["codexgpt-6-sol", "unknown gpt-6-sol", "pi glm-5.3", "opencode /glm-5.3", "pi zai/", "codex "];
  for (const entry of invalid) assert.throws(() => parseRouteEntry(entry), (error: Error) =>
    error.message.includes(JSON.stringify(entry)) && error.message.includes("<harness> <model>"), entry);
});

test("route with an empty list and window", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-empty-route-"));
  const list = routeList("unlisted");
  const original = [...list];
  try {
    list.splice(0);
    const output = run(["route", "unlisted", "--root", root], Date.parse("2026-09-28T12:00:00Z"));
    assert.equal(typeof output, "string");
    assert.match(output as string, /No routes found in this window\./);
    assert.doesNotMatch(output as string, /wf run /);
  } finally {
    list.splice(0, list.length, ...original);
    rmSync(root, { recursive: true, force: true });
  }
});

test("modelName", () => {
  const rows: [string, string, string][] = [
    ["openrouter", "x-ai/grok-4.6", "grok-4.6"],
    ["openrouter", "z-ai/glm-5.3", "glm-5.3"],
    ["openrouter", "stealth/ox-alpha", "stealth/ox-alpha"],
    ["openrouter", "grok-4.6", "grok-4.6"],
    ["xai", "grok-4.6", "grok-4.6"],
    ["opencode", "x-ai/grok-4.6", "x-ai/grok-4.6"],
  ];
  for (const [provider, model, name] of rows) assert.equal(modelName(provider, model), name, `${provider}/${model}`);
});

test("familyOf", () => {
  const rows: [string, string][] = [
    ["claude-opus-5-5", "anthropic"],
    ["gpt-6-astra", "openai"],
    ["zai/glm-5.3-flash", "zai"],
    ["x-ai/grok-4.6", "xai"],
    ["stealth/union-alpha", "union-alpha"],
  ];
  for (const [model, family] of rows) assert.equal(familyOf(model), family, model);
});

test("rankRoutes", () => {
  type Route = Parameters<typeof rankRoutes>[0][number];
  const now = 1_000_000;
  const plan = { name: "p", monthly: 1, currency: "USD" as const, from: "2026-01-01", to: null, providers: [] };
  const route = (model: string, extra: Partial<Route> = {}): Route => ({
    harness: "codex", model, name: model, listPosition: null, plan, used: 10, usedFrom: "provider", pace: null, limitedUntil: null, independence: null, calls: 1, ...extra,
  });
  const rows: [string, Route[], string[]][] = [
    ["exhausted plan last", [route("a", { limitedUntil: now + 1 }), route("b")], ["b", "a"]],
    ["expired limit ranks again", [route("a", { limitedUntil: now - 1, used: 5 }), route("b")], ["a", "b"]],
    ["listed before unlisted", [route("a", { listPosition: null }), route("b", { listPosition: 2 })], ["b", "a"]],
    ["list order beats usage", [route("gpt-6-astra", { listPosition: 3, calls: 10 }), route("gpt-6-sol", { listPosition: 1 })], ["gpt-6-sol", "gpt-6-astra"]],
    ["ahead follows within margin", [route("ahead", { listPosition: 1, pace: 11 }), route("within", { listPosition: 2, pace: 10 })], ["within", "ahead"]],
    ["behind keeps list order", [route("within", { listPosition: 1, pace: 10 }), route("behind", { listPosition: 2, pace: -25 })], ["within", "behind"]],
    ["unknown keeps list order", [route("unknown", { listPosition: 1 }), route("behind", { listPosition: 2, pace: -25 })], ["unknown", "behind"]],
    ["unknown precedes ahead", [route("ahead", { listPosition: 1, pace: 11 }), route("unknown", { listPosition: 2 })], ["unknown", "ahead"]],
    ["exhaustion beats list position", [route("a", { listPosition: 1, limitedUntil: now + 1 }), route("b", { listPosition: 2 })], ["b", "a"]],
    ["exhaustion beats pace", [route("within", { listPosition: 2, pace: 0, limitedUntil: now + 1 }), route("ahead", { listPosition: 1, pace: 11 })], ["ahead", "within"]],
    ["exact author model beats list position", [route("a", { listPosition: 1, independence: "same_model" }), route("b", { listPosition: 2, independence: "distinct_model" })], ["b", "a"]],
    ["exact author model beats pace", [route("within", { listPosition: 2, pace: 0, independence: "same_model" }), route("ahead", { listPosition: 1, pace: 11 })], ["ahead", "within"]],
    ["exhaustion beats exact author model", [route("a", { limitedUntil: now + 1 }), route("b", { independence: "same_model" })], ["b", "a"]],
    ["listed same model follows unlisted other model", [route("a", { listPosition: 1, independence: "same_model" }), route("b")], ["b", "a"]],
    ["distinct family does not reorder list", [route("a", { listPosition: 1, independence: "distinct_model" }), route("b", { listPosition: 2, independence: "cross_family" })], ["a", "b"]],
    ["plan before per token", [route("a", { plan: null }), route("b")], ["b", "a"]],
    ["more used route first", [route("a"), route("b", { calls: 9 })], ["b", "a"]],
    ["pass rate does not reorder", [route("a", { listPosition: 1, verdict: { judged: 3, passed: 0, changes: 3 } }), route("b", { listPosition: 2, verdict: { judged: 3, passed: 3, changes: 0 } })], ["a", "b"]],
  ];
  for (const [name, routes, order] of rows) assert.deepEqual(rankRoutes(routes, now).map((r) => r.model), order, name);
});

test("Grok Build and Pi route against one Example Xai window", () => {
  type Session = Parameters<typeof routesFrom>[0][number];
  type PlanUsage = Parameters<typeof usageCommand>[0][number];
  const now = Date.parse("2026-09-27T12:00:00Z");
  const session = (harness: Session["harness"], provider: string, model: string): Session => ({
    harness, id: harness, title: null, cwd: null, harnessVersion: null,
    threads: [], turns: [], toolCalls: [], skills: [], incidents: [], compactions: [], quotaReadings: [], reportedCostUsd: null,
    modelCalls: [{ id: harness, threadId: harness, turnId: harness, provider, model, effort: null,
      startedAt: now - 1_000, startInferred: false, endedAt: now, usage: usage({ input: 100 }),
      stopReason: "end_turn", purpose: "turn", reportedCostUsd: null }],
  });
  const sessions = [session("grok", "xai", "grok-4.6"), session("pi", "xai", "grok-4.6"), session("codex", "openai", "gpt-6.1-sol")];
  const plan = subscriptionOf("xai", now)!;
  const reading = (provider: string, usedPercent: number): PlanUsage => ({
    source: provider, provider, plan: subscriptionOf(provider, now), planType: null, error: null,
    windows: [{ minutes: 10080, usedPercent, resetsAt: now + 3_600_000 }],
  });
  const usages = [reading("xai", 5), reading("openai", 10)];
  const listed = routesFrom([], "evaluate", [], now, usages);
  assert.deepEqual(listed.map((r) => [r.harness, r.model, r.calls, r.listPosition]), [
    ["codex", "gpt-6.1-sol", 0, 1], ["claude", "claude-opus-5-5", 0, 2], ["pi", "zai/glm-5.3", 0, 3],
  ]);
  assert.deepEqual(listed.filter((r) => r.harness === "codex").map((r) => [r.used, r.usedFrom]), [[10, "provider"]]);
  assert.deepEqual(listed.filter((r) => r.harness === "codex").map((r) => r.pace), [-89]);
  assert.equal(listed.find((r) => r.model === "zai/glm-5.3")?.pace, null);
  assert.equal(routesFrom([], "evaluate", [], now, [reading("openai", 10), reading("openai", 60)])
    .find((r) => r.model === "gpt-6.1-sol")?.pace, -39);
  assert.equal(routesFrom([], "evaluate", [], now, [{ ...reading("openai", 10), windows: [{ minutes: 300, usedPercent: 10, resetsAt: now + 3_600_000 }] }])
    .find((r) => r.model === "gpt-6.1-sol")?.pace, null);
  assert.equal(rankRoutes(listed, now)[0].model, "gpt-6.1-sol");
  const routes = routesFrom(sessions, "implement", [], now, usages);
  assert.deepEqual(routes.filter((r) => r.plan === plan).map((r) => [r.harness, r.model]), [["pi", "xai/grok-4.6"], ["grok", "grok-4.6"]]);
  assert.equal(rankRoutes(routes, now)[0].model, "gpt-6.1-sol");
  assert.equal(usageCommand(usages, {}, now).match(/Example Xai\s+7d/g)?.length, 1);
  assert.deepEqual(ADAPTERS.grok.launch({ model: routes.find((r) => r.harness === "grok")!.model, prompt: "task", write: false, effort: null }).args.slice(2, 4), ["-m", "grok-4.6"]);

  usages[0] = reading("xai", 100);
  const exhausted = rankRoutes(routesFrom(sessions, "implement", [], now, usages), now);
  assert.equal(exhausted[0].model, "gpt-6.1-sol");
  assert.deepEqual(exhausted.filter((r) => r.plan === plan).map((r) => [r.harness, r.used, r.limitedUntil]), [
    ["pi", 100, now + 3_600_000], ["grok", 100, now + 3_600_000],
  ]);
  const reserved = [...ROUTE_RESERVED_PLANS];
  const rows: [string[], string, boolean][] = [
    [[], "implement", true],
    [[plan.name], "implement", false],
    [[plan.name], "evaluate", false],
    [[plan.name], "unlisted", false],
    [["Another plan"], "implement", true],
  ];
  try {
    usages[0] = reading("xai", 5);
    const observed = [...sessions, session("opencode", "xai", "grok-4.6"), session("pi", "openrouter", "grok-4.6")];
    for (const [names, skill, included] of rows) {
      ROUTE_RESERVED_PLANS.splice(0, ROUTE_RESERVED_PLANS.length, ...names);
      const available = routesFrom(observed, skill, [], now, usages);
      assert.equal(available.filter((r) => r.plan === plan).length, included ? 3 : 0, `${names} ${skill}`);
      assert.ok(available.some((r) => r.model === "openrouter/grok-4.6" && r.plan === null));
      assert.ok(available.some((r) => r.harness === "codex"));
    }
  } finally {
    ROUTE_RESERVED_PLANS.splice(0, ROUTE_RESERVED_PLANS.length, ...reserved);
  }
  const retired = session("codex", "openai", "gpt-5.6-sol");
  assert.equal(routesFrom([retired], "evaluate", [], now, usages).some((r) => r.name === "gpt-5.6-sol"), false);
});

// Provider responses with invented values, in the shapes each endpoint returns.
test("provider usage parsers", () => {
  const at = Date.parse("2026-09-01T00:00Z");
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(0, 16));
  const flat = (u: { planType: string | null; windows: { minutes: number | null; usedPercent: number | null; resetsAt: number | null }[] }) =>
    [u.planType, ...u.windows.map((w) => `${w.minutes} ${w.usedPercent} ${iso(w.resetsAt)}`)];
  const rows: [string, () => ReturnType<typeof flat>, (string | null)[]][] = [
    ["codex app-server, seconds", () => flat(parseCodexRateLimits({ rateLimits: { planType: "prolite", primary: { usedPercent: 26, windowDurationMins: 10080, resetsAt: 1788330000 }, secondary: null } })), ["prolite", "10080 26 2026-09-02T06:20"]],
    ["codex app-server, unknown plan", () => flat(parseCodexRateLimits({ rateLimits: { planType: "unknown", primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1788330000 } } })), [null, "300 5 2026-09-02T06:20"]],
    ["chatgpt, reset after seconds", () => flat(parseChatGptUsage({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 3600 }, secondary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: 1788927600 } } }, at)), ["plus", "300 10 2026-09-01T01:00", "10080 30 2026-09-09T04:20"]],
    ["claude, absent windows skipped", () => flat(parseClaudeUsage({ five_hour: { utilization: 15, resets_at: "2026-09-02T06:00:00.000Z" }, seven_day: { utilization: 55, resets_at: "2026-09-08T00:00:00.000Z" }, seven_day_opus: null })), [null, "300 15 2026-09-02T06:00", "10080 55 2026-09-08T00:00"]],
    ["zai, units 3 and 6", () => flat(parseZaiQuota({ code: 200, data: { level: "pro", limits: [{ unit: 3, percentage: 20, nextResetTime: 1788330000000 }, { unit: 6, percentage: 35, nextResetTime: 1788927600000 }] } })), ["pro", "300 20 2026-09-02T06:20", "10080 35 2026-09-09T04:20"]],
    ["xai, weekly credits", () => flat(parseXaiBilling({ subscriptionTier: "SuperGrok", config: { creditUsagePercent: 45, currentPeriod: { start: "2026-08-30T00:00:00.000Z", end: "2026-09-06T00:00:00.000Z" } } })), ["SuperGrok", "10080 45 2026-09-06T00:00"]],
    ["xai, zero share omitted", () => flat(parseXaiBilling({ config: { currentPeriod: { start: "2026-08-30T00:00:00.000Z", end: "2026-09-06T00:00:00.000Z" } } })), [null, "10080 0 2026-09-06T00:00"]],
    ["xai, no period", () => flat(parseXaiBilling({ config: {} })), [null]],
    ["used share clamps to 100", () => flat(parseClaudeUsage({ five_hour: { utilization: 130, resets_at: "2026-09-02T06:00:00.000Z" } })), [null, "300 100 2026-09-02T06:00"]],
  ];
  for (const [name, parse, expected] of rows) assert.deepEqual(parse(), expected, name);
  assert.throws(() => parseZaiQuota({ code: 500 }), /malformed/);
  assert.throws(() => parseCodexRateLimits({}), /malformed/);
});

test("turn aggregates through commands and checks", () => {
  type Session = Parameters<typeof summary>[0];
  type Aggregate = Extract<Session["modelCalls"][number], { kind: "turn_aggregate" }>;
  const at = Date.parse("2026-09-27T12:00:00Z");
  const make = (id: string, models: { model: string; calls: number; input: number }[], context: number | null): Session => {
    const total = usage({ input: models.reduce((n, m) => n + m.input, 0), output: 300 });
    const aggregate: Aggregate = {
      kind: "turn_aggregate", id: "a", threadId: "t", turnId: "u", provider: "xai", model: models[0].model,
      effort: null, startedAt: null, startInferred: false, endedAt: at + 10_000, usage: total,
      stopReason: "stop", purpose: "turn", reportedCostUsd: 0.05, callCount: models.reduce((n, m) => n + m.calls, 0),
      apiDurationMs: 4_865, contextObservation: context === null ? null : { tokens: context, at: at + 9_000 },
      modelUsages: models.map((m, i) => ({ provider: "xai", model: m.model, callCount: m.calls,
        usage: usage({ input: m.input, output: i === 0 ? 300 : 0 }) })),
    };
    return {
      harness: "pi", id, title: null, cwd: null, harnessVersion: null,
      threads: [{ id: "t", parentId: null, name: null, agentType: null, spawnedByToolCallId: null }],
      turns: [{ id: "u", threadId: "t", trigger: "prompt", promptText: `${launchHeader({ skill: "implement", parent: null })}\nbuild`, startedAt: at, endedAt: at + 10_000, outcome: "completed" }],
      modelCalls: [aggregate], toolCalls: [], skills: [{ turnId: "u", threadId: "t", skill: "implement", mechanism: "tool" }],
      incidents: [], compactions: [], quotaReadings: [], reportedCostUsd: 0.05,
    };
  };
  // List price per average call: summed input above 200k keeps the standard rate, and the reported $0.05 stays secondary.
  const rows: [string, Session, string, string, string | null, number, string][] = [
    ["summed input above price threshold", make("a", [{ model: "grok-4.6", calls: 3, input: 210_000 }], 55_000), "55k est.", "55k est.", null, 3, "$0.4"],
    ["missing context", make("b", [{ model: "grok-4.6", calls: 2, input: 210_000 }], null), "unknown", "unknown", "unknown", 2, "$0.4"],
    ["mixed model", make("c", [{ model: "grok-4.6", calls: 2, input: 150_000 }, { model: "grok-4.7", calls: 1, input: 80_000 }], 52_000), "52k est.", "52k est.", null, 3, "$0.5"],
  ];
  for (const [name, s, summaryContext, tableContext, band, calls, cost] of rows) {
    const aggregate = s.modelCalls[0];
    assert.deepEqual(checkMeasurement(aggregate), [], name);
    const printed = summary(s);
    assert.match(printed, new RegExp(`Model calls\\s+${calls}`), name);
    assert.ok(printed.includes(`peak ${summaryContext}`), name);
    assert.ok(printed.includes("budget classification unknown"), name);
    assert.ok(printed.includes(`computed ${cost} est. · reported by harness $0.1`), name);
    assert.match(turnsCommand(s), new RegExp(`\\s${calls}\\s`), name);
    assert.ok(costCommand(s).includes(cost), name);
    assert.ok(timeCommand(s).includes("0:00:05"), name);
    const row = modelRows([s])[0];
    assert.equal(row.model, "grok-4.6", name);
    assert.equal(row.band, band, name);
    assert.equal(row.overBudget, null, name);
    assert.ok(modelTable([row], false).includes(tableContext), name);
    const routes = routesFrom([s], "implement", [], at + 11_000, null);
    assert.equal(sessionStatus(s, at + 11_000).flagKinds.includes("context budget"), false, name);
    // Retired grok-4.7 calls leave the route table.
    if (name !== "mixed model") assert.equal(routes.reduce((n, r) => n + r.calls, 0), calls, name);
    if (name === "mixed model") assert.deepEqual(routes.filter((r) => r.calls).map((r) => [r.name, r.calls]), [["grok-4.6", 2]]);
  }
  const broken = { ...rows[0][1].modelCalls[0], kind: "turn_aggregate" as const, callCount: 4 } as Aggregate;
  assert.deepEqual(checkMeasurement(broken), ["aggregate call count mismatch"]);
});

test("modelRows", () => {
  type Session = Parameters<typeof modelRows>[0][number];
  const session = (id: string, prompt: string, skill: string | null, model: string, stop: string, outcome: "completed" | "unknown" | "interrupted", context: number): Session => ({
    harness: "claude-code", id, title: null, cwd: null, harnessVersion: null,
    threads: [{ id: "t", parentId: null, name: null, agentType: null, spawnedByToolCallId: null }],
    turns: [
      { id: "u1", threadId: "t", trigger: "prompt", promptText: prompt, startedAt: 0, endedAt: 60_000, outcome },
      { id: "u2", threadId: "t", trigger: "prompt", promptText: "more", startedAt: 120_000, endedAt: 180_000, outcome },
    ],
    modelCalls: [{ id: "c", threadId: "t", turnId: "u2", provider: "anthropic", model, effort: null, startedAt: 120_000, startInferred: false, endedAt: 180_000,
      usage: { input: context, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 }, stopReason: stop, purpose: "turn", reportedCostUsd: null }],
    toolCalls: [],
    skills: skill ? [{ turnId: "u1", threadId: "t", skill, mechanism: "tool" }, { turnId: "u2", threadId: "t", skill: "git", mechanism: "tool" }] : [],
    incidents: [], compactions: [], quotaReadings: [], reportedCostUsd: null,
  });
  const launched = (skill: string) => `${launchHeader({ skill, parent: null })}\ntask`;
  const rows = modelRows([
    session("a", launched("critique"), "evaluate", "claude-opus-5-5", "end_turn", "unknown", 250_000),
    session("b", launched("evaluate"), "evaluate", "claude-opus-5-5", "tool_use", "unknown", 100_000),
    session("c", launched("evaluate"), "evaluate", "claude-opus-5-5", "end_turn", "interrupted", 50_000),
    session("d", "task", "evaluate", "claude-opus-5-5", "end_turn", "completed", 10_000),
  ]).map((r) => [r.skill, r.sessions, r.finished, r.medianPeak, r.overBudget]);
  const expected = [
    // the launch skill wins over the skills the session used
    ["critique", 1, 1, 250_000, 1],
    // tool use and interruption leave a session unfinished; median of 100k
    // and 50k; d loaded evaluate without wf run and counts for no skill
    ["evaluate", 2, 0, 75_000, 0],
  ];
  assert.deepEqual(rows, expected);

  const pr = "https://github.com/fixture/workflow/pull/53";
  const head = "a".repeat(40);
  const builders = ["one", "two", "three", "unlinked"].map((id) => ({
    ...session(id, launched("implement"), "implement", "claude-opus-5-5", "end_turn", "completed", 100_000),
    result: id === "unlinked" ? null : { status: "complete" as const, pullRequest: pr, headSha: id === "three" ? "b".repeat(40) : head },
  }));
  const verdicts = [
    { pullRequest: pr, headSha: head, verdict: "CHANGES" as const, createdAt: "2026-09-21T12:00:00Z" },
    { pullRequest: pr, headSha: head, verdict: "PASS" as const, createdAt: "2026-09-21T11:00:00Z" },
    { pullRequest: pr, headSha: "b".repeat(40), verdict: "BLOCKED" as const, createdAt: "2026-09-21T13:00:00Z" },
    { pullRequest: pr, headSha: "c".repeat(40), verdict: "PASS" as const, createdAt: "2026-09-21T10:00:00Z" },
  ];
  const builder = modelRows(builders, verdicts)[0];
  assert.deepEqual([builder.sessions, builder.judged, builder.passed, builder.changes, builder.blocked], [4, 3, 2, 0, 1]);
  assert.equal(builder.band, "M");

  const sizes: Record<string, [number | null, boolean]> = {
    one: [10_000, false], two: [30_000, true], three: [null, false], unlinked: [20_000, false],
  };
  const sized = modelRows(builders, verdicts, (s) => ({
    provenance: { repository: "recorded", commit: "recorded", estimated: sizes[s.id][1] },
    tokens: sizes[s.id][0], gitMs: 0, tokenMs: 0,
  }))[0];
  assert.deepEqual(sized.repositorySize, { median: 20_000, measured: 3, estimated: true });
  assert.match(modelTable([sized], true), /20\.0K est\.\s+3\/4/);
  assert.equal(modelTable([builder], true).includes("code and docs"), false);
});

test("implement size bands", () => {
  type Session = Parameters<typeof modelRows>[0][number];
  type Verdict = "PASS" | "CHANGES" | "BLOCKED" | null;
  const pr = "https://github.com/fixture/workflow/pull/73";
  const session = (id: string, skill: string, model: string, context: number, verdict: Verdict): Session => ({
    harness: "claude-code", id, title: null, cwd: null, harnessVersion: null,
    threads: [{ id: "t", parentId: null, name: null, agentType: null, spawnedByToolCallId: null }],
    turns: [{ id: "u", threadId: "t", trigger: "prompt", promptText: `${launchHeader({ skill, parent: null })}\ntask`, startedAt: 0, endedAt: 1_000, outcome: "completed" }],
    modelCalls: [{
      id: "c", threadId: "t", turnId: "u", provider: "anthropic", model, effort: null, startedAt: 0, startInferred: false, endedAt: 1_000,
      usage: { input: context, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 },
      stopReason: "end_turn", purpose: "turn", reportedCostUsd: null,
    }],
    toolCalls: [], skills: [{ turnId: "u", threadId: "t", skill, mechanism: "tool" }],
    incidents: [], compactions: [], quotaReadings: [], reportedCostUsd: null,
    result: verdict ? { status: "complete", pullRequest: pr, headSha: id.padEnd(40, "a") } : null,
  });
  const peaks: [number, "S" | "M" | "L" | "over", Verdict][] = [
    [59_999, "S", "PASS"],
    [60_000, "M", "CHANGES"],
    [119_999, "M", null],
    [120_000, "L", "BLOCKED"],
    [200_000, "L", "PASS"],
    [200_001, "over", "CHANGES"],
  ];
  assert.deepEqual([SIZE_BAND_S_MAX, SIZE_BAND_M_MAX, CONTEXT_BUDGET], [60_000, 120_000, 200_000]);
  assert.equal(peaks[4][0], CONTEXT_BUDGET);
  assert.equal(peaks[5][0], CONTEXT_BUDGET + 1);
  const builds = peaks.map(([peak, , verdict], i) => session(`b${i}`, "implement", "claude-opus-5", peak, verdict));
  const others = [session("e0", "evaluate", "claude-haiku-4-5", 59_999, null), session("e1", "evaluate", "claude-haiku-4-5", 200_001, null)];
  const evaluations = builds.flatMap((s, i) => {
    const verdict = peaks[i][2];
    return verdict && s.result?.headSha ? [{ pullRequest: pr, headSha: s.result.headSha, verdict, createdAt: "2026-09-21T11:00:00Z" }] : [];
  });
  const rows = modelRows([...builds, ...others], evaluations);
  const order = { S: 0, M: 1, L: 2, over: 3 };
  const got = rows.filter((r) => r.skill === "implement").map((r) => [r.band, r.sessions, r.judged, r.passed, r.changes, r.blocked, r.overBudget, r.medianPeak]);
  got.sort((a, b) => order[a[0] as keyof typeof order] - order[b[0] as keyof typeof order]);
  const expected = [
    ["S", 1, 1, 1, 0, 0, 0, 59_999],
    ["M", 2, 1, 0, 1, 0, 0, (60_000 + 119_999) / 2],
    ["L", 2, 2, 1, 0, 1, 0, (120_000 + 200_000) / 2],
    ["over", 1, 1, 0, 1, 0, 1, 200_001],
  ];
  assert.deepEqual(got, expected);
  const evaluate = rows.filter((r) => r.skill === "evaluate");
  assert.equal(evaluate.length, 1);
  assert.equal(evaluate[0].band, null);
  assert.deepEqual([evaluate[0].sessions, evaluate[0].overBudget], [2, 1]);

  const counts = routeCounts(rows);
  assert.equal(counts.size, 1);
  const joined = counts.get("claude\0claude-opus-5");
  assert.deepEqual(joined, { judged: 5, passed: 2, changes: 2 });
  const bandMedians = rows.filter((r) => r.band).map((r) => r.medianPeak!);
  const mean = bandMedians.reduce((a, b) => a + b, 0) / bandMedians.length;
  const sortedPeaks = peaks.map((p) => p[0]).sort((a, b) => a - b);
  const trueMedian = (sortedPeaks[2] + sortedPeaks[3]) / 2;
  assert.notEqual(mean, trueMedian);
  assert.equal(Object.hasOwn(joined!, "medianPeak"), false);

  const printed = modelTable(rows, true);
  for (const band of ["S", "M", "L", "over"]) assert.match(printed, new RegExp(`implement\\s+${band}\\s+claude`));
  assert.match(printed, /evaluate\s+-\s+claude/);
  assert.equal(modelTable(rows.filter((r) => r.skill !== "implement"), false).includes("band"), false);
  const offline = modelTable(rows.filter((r) => r.skill === "implement"), false);
  assert.match(offline, /implement\s+over\s+claude/);
  assert.equal(offline.includes("judged"), false);

  const sizeCases: [string, number | null, boolean][] = [
    ["b0", 10_000, false], ["b1", 15_000, false], ["b2", 25_000, false],
    ["b3", null, false], ["b4", null, false], ["b5", null, false],
    ["e0", null, false], ["e1", null, false],
  ];
  const sizeOf = new Map(sizeCases.map(([id, tokens, estimated]) => [id, { provenance: { repository: "recorded", commit: "recorded", estimated }, tokens, gitMs: 0, tokenMs: 0 }]));
  const sized = modelRows([...builds, ...others], evaluations, (s) => sizeOf.get(s.id)!);
  const byBand = new Map(sized.filter((r) => r.skill === "implement").map((r) => [r.band, r.repositorySize]));
  assert.deepEqual(byBand.get("M"), { median: 20_000, measured: 2, estimated: false });
  assert.deepEqual(byBand.get("L"), { median: null, measured: 0, estimated: false });
  assert.deepEqual(sized.find((r) => r.skill === "evaluate")?.repositorySize, { median: null, measured: 0, estimated: false });
  assert.match(modelTable(sized, true), /implement\s+L\s+claude[^\n]*unknown\s+0\/2/);
});

test("readGithubEvaluations", async () => {
  const pr = "https://github.com/fixture/workflow/pull/53";
  const another = "https://github.com/fixture/workflow/pull/54";
  const head = "a".repeat(40);
  const marker = (url: string, sha = head, verdict = "PASS") => `<!-- workflow-evaluation: ${JSON.stringify({
    schema: 1, id: "00000000-0000-4000-8000-000000000002", issueUrl: "https://github.com/fixture/workflow/issues/49",
    pullRequest: url, headSha: sha, dependencies: [], verdict, findings: [],
  })} -->`;
  const node = (body: string, createdAt = "2026-09-21T11:00:00Z") => ({ body, createdAt });
  const page = (nodes: unknown[], more = false, cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: cursor } });
  const calls: string[] = [];
  const read = (query: string) => {
    calls.push(query);
    return JSON.stringify({ data: { repository: {
      p0: { comments: query.includes('after: "next"')
        ? page([node(marker(pr), "2026-09-21T10:00:00Z")])
        : page([node(marker(another)), node(marker(pr, "b".repeat(40))), node("<!-- workflow-evaluation: broken -->"), node("irrelevant")], true, "next") },
      ...(query.includes("p1:") ? { p1: { comments: page([node(marker(another))]) } } : {}),
    } } });
  };
  const found = await readGithubEvaluations([pr, another], async (query) => read(query));
  assert.equal(calls.length, 2);
  assert.deepEqual(found.map((v) => [v.pullRequest, v.headSha, v.verdict]), [[pr, "b".repeat(40), "PASS"], [another, head, "PASS"], [pr, head, "PASS"]]);
  assert.deepEqual(await readGithubEvaluations([pr, another], async () => JSON.stringify({
    data: { repository: { p0: { comments: page([node(marker(pr))]) }, p1: null } },
    errors: [{ type: "NOT_FOUND", path: ["repository", "p1"] }],
  })), [{ pullRequest: pr, headSha: head, verdict: "PASS", createdAt: "2026-09-21T11:00:00Z" }]);
  const failures: [string, () => Promise<string>][] = [
    ["missing gh", async () => { throw new Error("ENOENT"); }],
    ["authentication", async () => { throw new Error("401"); }],
    ["timeout", async () => { throw new Error("timeout"); }],
    ["malformed JSON", async () => "{"],
    ["partial GraphQL error", async () => JSON.stringify({ data: { repository: { p0: { comments: page([]) } } }, errors: [{ message: "partial" }] })],
  ];
  for (const [name, runner] of failures) await assert.rejects(readGithubEvaluations([pr], runner), /GitHub verdicts unavailable/, name);
});

test("windowPace", () => {
  const now = Date.UTC(2026, 8, 27), week = 7 * 1440, day = 86_400_000;
  const rows: [string, number, number, { pace: number; perDay: number }][] = [
    ["fresh window", 0, now + 7 * day, { pace: 0, perDay: 14 }],
    ["on pace at half", 50, now + 3.5 * day, { pace: 0, perDay: 14 }],
    ["behind with 3 days left", 44, now + 3 * day, { pace: -13, perDay: 19 }],
    ["ahead", 80, now + 3.5 * day, { pace: 30, perDay: 6 }],
    ["used up early", 100, now + day, { pace: 14, perDay: 0 }],
    ["reset passed", 30, now - 1000, { pace: -70, perDay: 0 }],
  ];
  for (const [name, used, resetsAt, expected] of rows) assert.deepEqual(windowPace(used, week, resetsAt, now), expected, name);
});

test("usageCommand keeps plans without the chosen window", () => {
  const now = Date.UTC(2026, 8, 27);
  const window = (minutes: number) => ({ minutes, usedPercent: 10, resetsAt: now + 3_600_000 });
  const usage = (name: string, windows: ReturnType<typeof window>[]) => ({ provider: "p", plan: { name }, windows }) as never;
  const usages = [usage("Both", [window(300), window(7 * 1440)]), usage("Weekly only", [window(7 * 1440)]), usage("None", [])];
  const rows: [string, RegExp[]][] = [
    ["5h", [/Both\s+5h\s+10%/, /Weekly only\s+-\s+-\s+-\s+no 5h window/, /None\s+-.*no 5h window/]],
    ["7d", [/Both\s+7d\s+10%/, /Weekly only\s+7d\s+10%/]],
    ["all", [/Both\s+5h/, /^\s+7d\s+10%/m, /None\s+-.*no windows reported/]],
  ];
  for (const [w, patterns] of rows) for (const pattern of patterns) assert.match(usageCommand(usages, { w }, now), pattern, `${w} ${pattern}`);
  // A weekly row with spend shows it, the full window and the multiplier; 5h rows and plans without spend show none.
  const priced = { provider: "anthropic", plan: subscriptionOf("anthropic", now), windows: [window(300), window(7 * 1440)] } as never;
  const text = usageCommand([priced, usage("Both", [window(7 * 1440)])], { w: "all" }, now, new Map([["Example Anthropic", 30]]));
  assert.match(text, /Example Anthropic\s+5h\s+10%\s+1:00:00\n/);
  assert.match(text, /\s+7d\s+10%.*\$30\.0\s+\$300\.0\s+\d+\.\dx/);
  assert.match(text, /Both\s+7d\s+10%\s+1:00:00\s+-?\d+\s+\d+%\/d\n/);
});

test("planMatches", () => {
  const rows: [string, string, boolean][] = [
    ["7", "fixture/workflow#0007", true],
    ["0007", "fixture/workflow#0007", true],
    ["workflow#7", "fixture/workflow#0007", true],
    ["fixture/workflow#0007", "fixture/workflow#0007", true],
    ["skills#7", "fixture/workflow#0007", false],
    ["flow#7", "fixture/workflow#0007", false],
    ["8", "fixture/workflow#0007", false],
    ["plan", "fixture/workflow#0007", false],
  ];
  for (const [query, plan, match] of rows) assert.equal(planMatches(query, plan), match, `${query} ${plan}`);
});


test("categoryOf", () => {
  const rows: [string, string][] = [
    ["src/main.ts", "code"],
    ["test/main.test.ts", "test"],
    ["lib/main.spec.ts", "test"],
    ["test/fixtures/guide.md", "test data"],
    ["tests/golden/result.txt", "test data"],
    ["README.md", "docs"],
    ["data/sample.json", "data"],
    ["package.json", "config"],
  ];
  for (const [path, expected] of rows) assert.equal(categoryOf(path), expected, path);
  assert.equal(categoryOf("notes/plan.txt", { path: "", categories: { data: ["notes/**"] } }), "data");
  assert.equal(categoryOf("test/fixtures/guide.md", { path: "", categories: { code: ["test/**"], "test data": ["test/fixtures/**"] } }), "test data");
});


test("money formatters", () => {
  const rows: [number | null, string, string][] = [
    [null, "-", "-"],
    [0, "$0.0", "€0.0"],
    [0.01, "<$0.1", "€0.0"],
    [0.05, "$0.1", "€0.1"],
    [12.34, "$12.3", "€12.3"],
    [1234.56, "$1,234.6", "€1,234.6"],
  ];
  for (const [value, dollars, euros] of rows) {
    assert.equal(usd(value), dollars);
    assert.equal(eur(value), euros);
  }
});

test("duration formatter", () => {
  const rows: [number | null, string][] = [
    [null, "-"], [-1, "-"], [0, "0:00:00"], [499, "0:00:00"],
    [500, "0:00:01"], [59_500, "0:01:00"], [3_599_500, "1:00:00"],
    [90_061_000, "25:01:01"], [360_000_000, "100:00:00"],
  ];
  for (const [value, expected] of rows) assert.equal(dur(value), expected);
});

test("table aligns money and duration columns", () => {
  assert.equal(table(["plan", "price", "wall"], [
    ["A", eur(9), dur(1000)], ["Long", eur(1234.56), dur(90_061_000)],
  ], [1, 2]), [
    "plan     price      wall",
    "----  --------  --------",
    "A         €9.0   0:00:01",
    "Long  €1,234.6  25:01:01",
  ].join("\n"));
});

test("usage reset countdowns", () => {
  const now = Date.UTC(2026, 8, 27);
  const rows: [number | null, string][] = [
    [null, "-"], [-1000, "0:00:00"], [0, "0:00:00"], [1000, "0:00:01"],
    [3_661_000, "1:01:01"], [90_061_000, "25:01:01"],
  ];
  for (const [remaining, expected] of rows) {
    const text = usageCommand([{ source: "fixture", provider: "test", plan: null, planType: null, error: null,
      windows: [{ minutes: 300, usedPercent: 10, resetsAt: remaining === null ? null : now + remaining }],
    }], { w: "all" }, now);
    assert.ok(text.trimEnd().endsWith(expected), text);
  }
});

test("terminal text removes escape sequences and cursor controls", () => {
  const rows = [
    ["plain\ntext\twith €", "plain\ntext\twith €"],
    ["before\x1b[2Jafter", "beforeafter"],
    ["\x1b]52;c;ZHVtbXk=\x07safe", "safe"],
    ["\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\", "link"],
    ["a\rb\bc\x00\x7f\x9bd", "abcd"],
  ];
  for (const [input, expected] of rows) assert.equal(terminalText(input), expected);
});
