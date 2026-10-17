// Runs the commands of each use case in docs/use-cases.md on the fixtures and
// compares the output with test/golden/<use case>-<harness>.txt, or
// test/golden/<use case>.txt for a command over every session.
// WORKFLOW_GOLDEN_UPDATE=1 rewrites the files.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { ADAPTERS, HARNESS_NAMES } from "../src/harnesses/index.ts";
import { COMMAND_NAMES, run } from "../src/cli.ts";
import { repositoryEntries } from "../src/catalog.ts";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const update = process.env.WORKFLOW_GOLDEN_UPDATE === "1";

// Use case id and the `workflow ...` command lines under its heading.
const useCases = readFileSync("docs/use-cases.md", "utf8")
  .split(/^## /m)
  .slice(1)
  .map((section) => ({
    id: section.split(/\s/, 1)[0],
    commands: [...section.matchAll(/^wf (.+)$/gm)].map((m) => m[1].split(/\s+/)),
  }));

test("every CLI command serves a use case", () => {
  const named = new Set(useCases.flatMap((u) => u.commands.map((c) => c[0])));
  assert.deepEqual(COMMAND_NAMES.filter((c) => !named.has(c)), []);
});

test("every CLI command has its own help", () => {
  const overview = run(["help"]);
  assert.deepEqual(COMMAND_NAMES.filter((c) => run(["help", c]) === overview || !String(overview).includes(`  ${c} `)), []);
});

const expected = new Set<string>();
// `stop` signals live processes, so it has no golden file.
for (const useCase of useCases) {
  const perSession = useCase.commands.filter((c) => c.includes("<session>") && c[0] !== "stop");
  if (perSession.length === 0) continue;
  for (const harness of HARNESS_NAMES) {
    const file = `${useCase.id}-${harness}.txt`;
    expected.add(file);
    test(`${useCase.id} ${harness}`, () => {
      const root = `test/fixtures/${harness}`;
      const session = ADAPTERS[harness].list([root])[0].ref;
      const output = perSession
        .map((c) => {
          const [command, ...rest] = c;
          const args = rest.map((a) => (a === "<session>" ? session : a));
          return `$ wf ${c.join(" ")}\n${run([command, harness, ...args, "--root", root])}\n`;
        })
        .join("\n");
      if (update) writeFileSync(`test/golden/${file}`, output);
      assert.equal(output, readFileSync(`test/golden/${file}`, "utf8"));
    });
  }
}

// Commands over every session read all fixtures. `archive` writes, `run`
// launches a model, `usage` reads providers, and `repo` and `changes` read a clone.
for (const useCase of useCases) {
  const allSessions = useCase.commands.filter((c) => !c.includes("<session>") && !["archive", "run", "usage", "repo", "changes"].includes(c[0]));
  if (allSessions.length === 0) continue;
  const file = `${useCase.id}.txt`;
  expected.add(file);
  test(useCase.id, () => {
    const output = allSessions.map((c) => `$ wf ${c.join(" ")}\n${run([...c, "--root", "test/fixtures"])}\n`).join("\n");
    if (update) writeFileSync(`test/golden/${file}`, output);
    assert.equal(output, readFileSync(`test/golden/${file}`, "utf8"));
  });
}

test("uc-18 repository size", () => {
  const root = mkdtempSync("test/repo-golden-");
  const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_PREFIX: undefined };
  try {
    const clone = spawnSync("git", ["clone", "-q", "test/fixtures/repo.bundle", root], { env: gitEnv, encoding: "utf8" });
    assert.equal(clone.status, 0, clone.stderr);
    assert.equal(spawnSync("git", ["remote", "set-url", "origin", "git@github.com:fixture/repo.git"], { cwd: root, env: gitEnv }).status, 0);
    const command = ["repo", root, "-d", "2", "-n", "20"];
    const output = `$ wf repo <repo> -d 2 -n 20\n${run(command)}\n`;
    assert.match(output, /test data\s+2\s+2\s+6\s+24/);
    assert.match(output, /assets\s+1\s+0\s+0\s+0/);
    assert.match(output, /^total\s+13\s+13\s+71\s+76$/m);
    assert.match(output, /^README\.md\s+1\s+3\s+18\s+52$/m);
    assert.match(output, /^package-lock\.json\s+1\s+0\s+0\s+0$/m);
    assert.match(output, /^src\/duplicate\.txt\s+1\s+1\s+[1-9]\d*\s+0$/m);
    assert.match(output, /^test\/\s+3\s+/m);
    assert.match(output, /^  fixtures\/\s+1\s+/m);
    assert.match(output, /^  golden\/\s+1\s+/m);
    assert.match(output, /^test-other\/\s+1\s+/m);
    assert.ok(output.indexOf("  golden/") < output.indexOf("test-other/"));
    assert.doesNotMatch(output, /link\.ts|module\s+1/);
    assert.match(String(run(["repo", root, "missing-commit"])), /not a valid object name/i);
    assert.match(String(run(["repo", `${root}/missing-clone`])), /directory does not exist/);
    if (update) writeFileSync("test/golden/uc-18.txt", output);
    assert.equal(output, readFileSync("test/golden/uc-18.txt", "utf8"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uc-22 merged changes and the lines still theirs", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-changes-golden-"));
  const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_PREFIX: undefined };
  const git = (at: string, ...args: string[]) => {
    const env = { ...gitEnv, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (path: string, lines: string[]) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), lines.map((l) => `${l}\n`).join(""));
  };
  try {
    git("2020-01-01T00:00:00Z", "init", "-q", "-b", "main");
    git("2020-01-01T00:00:00Z", "remote", "add", "origin", "git@github.com:fixture/repo.git");
    write("src/a.ts", ["export const a = 1;", "export const b = 2;"]);
    git("2020-01-01T00:00:00Z", "add", ".");
    git("2020-01-01T00:00:00Z", "commit", "-qm", "Start");
    // A pull request branch adds code, a test and a lock file, and edits one line.
    git("2020-01-02T00:00:00Z", "checkout", "-q", "-b", "feat/one");
    write("src/b.ts", ["export const c = 3;", "export const d = 4;", "export const e = 5;", "export const f = 6;"]);
    write("test/b.test.ts", ["const c = 3;", "console.log(c);"]);
    write("package-lock.json", ["{}"]);
    write("src/a.ts", ["export const a = 10;", "export const b = 2;"]);
    git("2020-01-02T00:00:00Z", "add", ".");
    git("2020-01-02T00:00:00Z", "commit", "-qm", "Add b");
    git("2020-01-03T00:00:00Z", "checkout", "-q", "main");
    git("2020-01-03T00:00:00Z", "merge", "-q", "--no-ff", "feat/one", "-m", "Merge pull request #1 from fixture/feat/one");
    // Two of its lines are rewritten within the rework window, and one after it.
    write("src/b.ts", ["export const c = 30;", "export const d = 40;", "export const e = 5;", "export const f = 6;"]);
    git("2020-01-05T00:00:00Z", "commit", "-qam", "Rework b");
    write("src/b.ts", ["export const c = 30;", "export const d = 40;", "export const e = 50;", "export const f = 6;"]);
    git("2020-01-19T00:00:00Z", "commit", "-qam", "Late change");
    // A local branch merged five days before now is still pending.
    git("2020-01-20T00:00:00Z", "checkout", "-q", "-b", "fix/two");
    write("docs/two.md", ["# Two", "", "Notes."]);
    git("2020-01-20T00:00:00Z", "add", ".");
    git("2020-01-20T00:00:00Z", "commit", "-qm", "Add notes");
    git("2020-01-20T00:00:00Z", "checkout", "-q", "main");
    git("2020-01-20T00:00:00Z", "merge", "-q", "--no-ff", "fix/two", "-m", "Merge branch 'fix/two'");
    const now = Date.parse("2020-01-25T00:00:00Z");
    const output = `$ wf changes -d 2020-01-01.. <clone>\n${run(["changes", "-d", "2020-01-01..", root], now)}\n`.replace(/"[0-9a-f]{40}"/g, '"<sha>"');
    const doc = JSON.parse(output.split("\n").slice(1).join("\n"));
    assert.deepEqual(doc.changes.map((c: { branch: string }) => c.branch), ["feat/one", "fix/two"]);
    assert.deepEqual(doc.changes[0].added, { code: 5, test: 2 });
    assert.deepEqual(doc.changes[0].surviving, { code: 3, test: 2 });
    assert.equal(doc.changes[1].surviving, null);
    assert.throws(() => run(["changes", join(root, "missing")], now), /no such directory/);
    if (update) writeFileSync("test/golden/uc-22.txt", output);
    assert.equal(output, readFileSync("test/golden/uc-22.txt", "utf8"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repository table columns align with long names and empty sections", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-repo-alignment-"));
  const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_PREFIX: undefined };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const domain = "Example.Application.Server.WebApi.Tests.Integration";
  const folder = "Long nested folder with spaces";
  const file = "A very long filename that must remain complete in the largest files table.txt";
  try {
    git("clone", "-q", resolve("test/fixtures/repo.bundle"), ".");
    git("mv", "src", domain);
    mkdirSync(join(root, domain, folder));
    git("mv", `${domain}/duplicate.txt`, `${domain}/${folder}/${file}`);
    const tree = git("write-tree");
    for (const args of [["-d", "3", "-n", "20"], ["-d", "0", "-n", "0"]]) {
      const output = String(run(["repo", root, tree, ...args]));
      let ends: number[] = [];
      let rows = 0;
      for (const line of output.split("\n")) {
        if (line.startsWith("name ")) {
          ends = ["files", "lines", "tokens", "markdown"].map((header) => line.indexOf(header) + header.length);
        } else if (/\s+\d[\d,.K]*\s+\d[\d,.K]*\s+\d[\d,.K]*\s+\d[\d,]*$/.test(line)) {
          const cells = [...line.matchAll(/\S+/g)].slice(-4);
          assert.deepEqual(cells.map((cell) => cell.index + cell[0].length), ends, line);
          rows++;
        }
      }
      assert.ok(rows > 0);
      assert.ok(output.includes(domain));
      if (args[1] === "3") {
        assert.ok(output.includes(`  ${folder}/`));
        assert.ok(output.includes(`${domain}/${folder}/${file}`));
      } else {
        assert.doesNotMatch(output, new RegExp(file.replaceAll(".", "\\.")));
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uc-1 and uc-9 recorded, estimated and missing repository sizes", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-size-golden-"));
  const clone = join(root, "clone");
  const worktree = join(root, "worktree");
  const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_PREFIX: undefined };
  const adapters = Object.fromEntries(Object.entries(ADAPTERS).map(([name, adapter]) => [name, { list: adapter.list, load: adapter.load }]));
  const entries = { ...repositoryEntries };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(root, "clone", "-q", resolve("test/fixtures/repo.bundle"), clone);
    git(clone, "remote", "set-url", "origin", "git@github.com:fixture/repo.git");
    const sha = git(clone, "rev-parse", "HEAD");
    git(clone, "worktree", "add", "-q", "-b", "size-fixture", worktree, sha);
    for (const name of Object.keys(repositoryEntries)) delete repositoryEntries[name];
    repositoryEntries["fixture/repo"] = { ...entries["fixture/repo"], path: clone };

    const adapter = ADAPTERS.codex;
    const fixtureRoot = "test/fixtures/codex";
    const session = adapter.load(adapter.list([fixtureRoot])[0].ref, [fixtureRoot]);
    session.cwd = worktree;
    const first = session.turns.find((turn) => turn.threadId === session.id)!;
    first.promptText = "Repository size fixture";
    for (const current of Object.values(ADAPTERS)) current.list = () => [];
    adapter.list = () => [{ id: session.id, ref: session.id, updatedAt: Date.now() }];
    adapter.load = () => session;

    const cases = [
      ["recorded", { commit: sha, at: Date.now() }],
      ["estimated", { branch: "size-fixture", at: Date.now() + 60_000 }],
      ["missing object", { commit: "a".repeat(40), at: Date.now() }],
    ] as const;
    const output = cases.map(([label, startGit]) => {
      session.startGit = startGit;
      const summary = String(run(["summary", "codex", session.id, "--size"]));
      const lines = summary.split("\n").filter((line) => /^(Directory|Repository|Start commit|Code and docs)\s/.test(line));
      const listing = String(run(["ls", "codex", "-d", "2000-01-01..", "--size"]));
      return `${label}\n$ wf summary <session> --size\n${lines.join("\n")}\n$ wf ls codex --size\n${listing}`;
    }).join("\n\n").replaceAll(worktree, "<worktree>").replaceAll(sha, "<commit>") + "\n";
    assert.match(output, /recorded[\s\S]*Code and docs\s+52 tokens\n[\s\S]*\s52\n/);
    assert.match(output, /estimated[\s\S]*Code and docs\s+52 tokens est\.\n[\s\S]*\s52 est\.\n/);
    assert.match(output, /missing object[\s\S]*Code and docs\s+unknown\n[\s\S]*\sunknown\n/);
    session.startGit = { commit: sha, at: Date.now() };
    assert.match(String(run(["summary", "codex", session.id, "--size", "--root", fixtureRoot])), /Code and docs\s+unknown/);
    if (update) writeFileSync("test/golden/uc-9-size-cases.txt", output);
    assert.equal(output, readFileSync("test/golden/uc-9-size-cases.txt", "utf8"));
  } finally {
    for (const [name, original] of Object.entries(adapters)) {
      ADAPTERS[name as keyof typeof ADAPTERS].list = original.list;
      ADAPTERS[name as keyof typeof ADAPTERS].load = original.load;
    }
    for (const name of Object.keys(repositoryEntries)) delete repositoryEntries[name];
    Object.assign(repositoryEntries, entries);
    rmSync(root, { recursive: true, force: true });
  }
});

test("every golden file belongs to a use case", () => {
  expected.add("uc-18.txt");
  expected.add("uc-22.txt");
  expected.add("uc-9-size-cases.txt");
  expected.add("uc-20-repository-cases.txt");
  expected.add("uc-1-claude-job.txt");
  const stale = readdirSync("test/golden").filter((f) => !expected.has(f));
  if (update) for (const f of stale) rmSync(`test/golden/${f}`);
  else assert.deepEqual(stale, []);
});

test("uc-1 Claude job prefixes", () => {
  const root = mkdtempSync("test/job-prefix-");
  try {
    cpSync("test/job-fixtures/claude", `${root}/claude`, { recursive: true });
    const job = readdirSync(`${root}/claude/jobs`)[0];
    const prefix = job.slice(0, -1);
    const other = `${prefix}${job.endsWith("0") ? "1" : "0"}`;
    const output = run(["summary", job, "--root", root]);
    assert.match(String(output), /2 compactions/);
    assert.match(String(output), /376,930 → 8,896 tokens · \$0\.25 est\./);
    assert.match(String(run(["cost", job, "--root", root])), /377k\s+9k\s+\$0\.3 est\./);
    const golden = `$ wf summary ${job}\n${run(["summary", job, "--root", "test/job-fixtures"])}\n`;
    if (update) writeFileSync("test/golden/uc-1-claude-job.txt", golden);
    assert.equal(golden, readFileSync("test/golden/uc-1-claude-job.txt", "utf8"));
    assert.throws(() => run(["summary", "unknown-job", "--root", root]), /no session id starts with unknown-job/);
    mkdirSync(`${root}/claude/jobs/${other}`, { recursive: true });
    writeFileSync(`${root}/claude/jobs/${other}/state.json`, JSON.stringify({ resumeSessionId: "4d3082b6-f739-4197-a814-7b0865b2a577" }));
    assert.throws(() => run(["summary", prefix, "--root", root]), /matches 2 Claude Code jobs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Each path to uc-20's repository field, with a removed worktree read before and
// after its directory goes, and a placeholder model name.
test("uc-20 repository and model cases", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-export-cases-"));
  const clone = join(root, "clone");
  const other = join(root, "other");
  const outside = join(root, "outside");
  const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_PREFIX: undefined };
  const adapters = Object.fromEntries(Object.entries(ADAPTERS).map(([name, adapter]) => [name, { list: adapter.list, load: adapter.load }]));
  const entries = { ...repositoryEntries };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git(root, "clone", "-q", resolve("test/fixtures/repo.bundle"), clone);
    git(clone, "remote", "set-url", "origin", "git@github.com:fixture/repo.git");
    git(root, "clone", "-q", resolve("test/fixtures/repo.bundle"), other);
    git(other, "remote", "set-url", "origin", "https://github.com/fixture/other.git");
    git(root, "clone", "-q", resolve("test/fixtures/repo.bundle"), join(root, "local"));
    git(join(root, "local"), "remote", "remove", "origin");
    git(clone, "worktree", "add", "-q", "-b", "listed", join(root, "listed"));
    git(clone, "worktree", "add", "-q", "-b", "patterned", join(root, "clone-o1"));
    mkdirSync(outside);
    for (const name of Object.keys(repositoryEntries)) delete repositoryEntries[name];
    repositoryEntries["fixture/repo"] = { path: clone, worktrees: [join(root, "clone-*")] };

    const adapter = ADAPTERS.codex;
    const fixtureRoot = "test/fixtures/codex";
    const session = adapter.load(adapter.list([fixtureRoot])[0].ref, [fixtureRoot]);
    for (const current of Object.values(ADAPTERS)) current.list = () => [];
    adapter.list = () => [{ id: session.id, ref: session.id, updatedAt: Date.now() }];
    adapter.load = () => session;
    const first = session.turns.find((turn) => turn.threadId === session.id)!;
    first.promptText = "Export fixture";
    const exported = () => JSON.parse(String(run(["export", "-d", "2000-01-01.."]))).rows as { model: string | null; repository: string | null; sessions: number }[];
    const repository = (cwd: string, logged?: string) => {
      session.cwd = cwd;
      session.startGit = { ...(logged ? { repository: logged } : {}), at: Date.now() };
      return exported()[0].repository;
    };
    // The catalog's other clone held the name "repo" until the given time.
    const renamed = (until: string) => {
      repositoryEntries["fixture/former"] = { path: other, formerly: [{ name: "repo", until }] };
      try {
        return repository(clone);
      } finally {
        delete repositoryEntries["fixture/former"];
      }
    };

    const cases: [string, () => string | null][] = [
      ["catalog clone", () => repository(clone)],
      ["repository outside the catalog", () => repository(other)],
      ["repository without a remote", () => repository(join(root, "local"))],
      ["worktree listed by its clone", () => repository(join(root, "listed", "src"))],
      ["worktree before removal", () => repository(join(root, "clone-o1"))],
      ["worktree after removal", () => (git(clone, "worktree", "remove", join(root, "clone-o1")), repository(join(root, "clone-o1")))],
      ["removed directory with a logged repository URL", () => repository(join(root, "gone"), "https://github.com/fixture/logged.git")],
      ["directory outside Git", () => repository(outside)],
      ["missing directory without evidence", () => repository(join(root, "gone"))],
      ["redacted logged repository", () => repository(join(root, "gone"), "<text>")],
      ["session before its repository's rename", () => renamed("9999-01-01T00:00:00Z")],
      ["session after its repository's rename", () => renamed("2000-01-01T00:00:00Z")],
    ];
    const lines = cases.map(([label, read]) => `${label}: ${JSON.stringify(read())}`);
    const call = session.modelCalls[0];
    const model = call.model;
    call.model = "compaction";
    const placeholder = exported().filter((row) => row.model === null);
    call.model = model;
    lines.push(`placeholder model rows: ${placeholder.length}, sessions under null: ${placeholder.reduce((n, row) => n + row.sessions, 0)}`);
    const output = `$ wf export (one session per case)\n${lines.join("\n")}\n`;
    assert.match(output, /worktree before removal: "repo"\nworktree after removal: "repo"/);
    assert.match(output, /directory outside Git: null\nmissing directory without evidence: null/);
    assert.equal(placeholder.length, 1);
    if (update) writeFileSync("test/golden/uc-20-repository-cases.txt", output);
    assert.equal(output, readFileSync("test/golden/uc-20-repository-cases.txt", "utf8"));
  } finally {
    for (const [name, original] of Object.entries(adapters)) {
      ADAPTERS[name as keyof typeof ADAPTERS].list = original.list;
      ADAPTERS[name as keyof typeof ADAPTERS].load = original.load;
    }
    for (const name of Object.keys(repositoryEntries)) delete repositoryEntries[name];
    Object.assign(repositoryEntries, entries);
    rmSync(root, { recursive: true, force: true });
  }
});

// uc-21 on invented sessions: a session active on a later day than its start, a
// session without prompts, a launch task, a spawned subagent a later turn resumes,
// a Grok Build turn without usage, a Copilot aggregate outside its turns, unpriced
// calls inside and outside the prompts, a placeholder model and two prompts sharing
// a start time.
test("uc-21 prompt cases", () => {
  type Session = ReturnType<(typeof ADAPTERS)["pi"]["load"]>;
  type Call = Session["modelCalls"][number];
  const adapters = Object.fromEntries(Object.entries(ADAPTERS).map(([name, adapter]) => [name, { list: adapter.list, load: adapter.load }]));
  const at = (iso: string) => Date.parse(`2026-10-${iso}Z`);
  const usage = { input: 100_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1_000, reasoning: 0 };
  const call = (id: string, thread: string, turn: string | null, when: string, model = "claude-opus-5"): Call => ({
    id, threadId: thread, turnId: turn, provider: "anthropic", model, effort: null, startedAt: at(when), startInferred: false,
    endedAt: at(when) + 1_000, usage, stopReason: "end_turn", purpose: "turn", reportedCostUsd: null,
  });
  const thread = (id: string, parentId: string | null, spawnedByToolCallId: string | null = null) => ({ id, parentId, name: null, agentType: null, spawnedByToolCallId });
  const turn = (id: string, thread: string, trigger: Session["turns"][number]["trigger"], when: string, promptText: string | null = null): Session["turns"][number] => ({
    id, threadId: thread, trigger, promptText, startedAt: at(when), endedAt: at(when) + 60_000, outcome: "completed",
  });
  const spawn = (id: string, turnId: string, child: string, when: string): Session["toolCalls"][number] => ({
    id, threadId: "t", turnId, name: "Agent", category: "agent", shellCategory: null, command: null, origin: "model",
    startedAt: at(when), endedAt: at(when) + 1_000, status: "ok", spawnsThreadId: child, paths: [], lines: null, web: null, resultChars: null, resultLines: null, resultWords: null,
  });
  const session = (harness: Session["harness"], id: string, parts: Partial<Session>): Session => ({
    harness, id, title: null, cwd: null, harnessVersion: null, threads: [thread("t", null)], turns: [], modelCalls: [], toolCalls: [],
    skills: [], incidents: [], compactions: [], quotaReadings: [], reportedCostUsd: null, ...parts,
  });
  const header = "[wf run skill=implement parent=claude:orch]";
  const sessions: Session[] = [
    session("claude-code", "orch", { turns: [turn("o1", "t", "prompt", "12T09:00:00", "plan the work")], modelCalls: [call("o", "t", "o1", "12T09:00:10")] }),
    // Started on the 13th, prompted again on the 14th. Prompt l3 resumes the subagent l1 spawned.
    session("pi", "long", {
      threads: [thread("t", null), thread("sub", "t", "x")],
      turns: [
        turn("l1", "t", "prompt", "13T10:00:00", `${header}\nbuild it`),
        turn("sub1", "sub", "agent_message", "13T10:00:20"),
        turn("l2", "t", "command", "13T11:00:00", "/compact"),
        turn("l3", "t", "prompt", "14T08:00:00", "finish it"),
      ],
      modelCalls: [
        call("l1a", "t", "l1", "13T10:00:10"), call("s1", "sub", "sub1", "13T10:00:30"),
        call("l2a", "t", "l2", "13T11:00:10"),
        call("l3a", "t", "l3", "14T08:00:10", "unknown"), call("s2", "sub", "sub1", "14T08:00:30"),
      ],
      toolCalls: [spawn("x", "l1", "sub", "13T10:00:15"), spawn("y", "l3", "sub", "14T08:00:25")],
    }),
    session("pi", "quiet", { turns: [turn("q1", "t", "notification", "14T09:00:00")], modelCalls: [call("q", "t", "q1", "14T09:00:10", "mystery-model")] }),
    session("grok", "apart", { turns: [turn("g1", "t", "prompt", "14T10:00:00", "look")] }),
    session("copilot", "shutdown", { turns: [turn("c1", "t", "prompt", "14T11:00:00", "fix")], modelCalls: [call("c", "t", null, "14T11:30:00")] }),
    session("pi", "twins", {
      turns: [turn("w1", "t", "prompt", "14T12:00:00", "one"), turn("w2", "t", "prompt", "14T12:00:00", "two")],
      modelCalls: [call("w1a", "t", "w1", "14T12:00:10"), call("w2a", "t", "w2", "14T12:00:10"), call("w2b", "t", "w2", "14T12:00:20")],
    }),
  ];
  try {
    for (const current of Object.values(ADAPTERS)) current.list = () => [];
    for (const harness of ["claude", "pi", "grok", "copilot"] as const) {
      const mine = sessions.filter((s) => (harness === "claude" ? s.harness === "claude-code" : s.harness === harness));
      ADAPTERS[harness].list = () => mine.map((s) => ({ id: s.id, ref: s.id, updatedAt: at("14T12:00:00") }));
      ADAPTERS[harness].load = (ref: string) => mine.find((s) => s.id === ref)!;
    }
    type Prompt = { turn: string; at: string; model: string | null; costUsd: number | null; unpricedCalls: number; launch: boolean; text: string | null };
    type Row = { session: string; day: string; parent: string | null; harness: string; repository: string | null; skill: string | null; costUsd: number; unpricedCalls: number; prompts: Prompt[] };
    const prompts = (when: string) => JSON.parse(String(run(["prompts", "-d", when], at("16T00:00:00")))).sessions as Row[];
    const day = prompts("2026-10-14");
    assert.deepEqual(day.map((s) => [s.session, s.day]), [
      ["pi:long", "2026-10-13"], ["pi:quiet", "2026-10-14"], ["grok:apart", "2026-10-14"], ["copilot:shutdown", "2026-10-14"], ["pi:twins", "2026-10-14"],
    ]);

    const long = day[0];
    assert.equal(long.parent, "claude:orch");
    assert.equal(long.skill, "implement");
    assert.deepEqual(long.prompts.map((p) => [p.turn, p.launch, p.model, p.unpricedCalls]), [["l1", true, "claude-opus-5", 0], ["l3", false, null, 1]]);
    const [l1, l3] = long.prompts.map((p) => p.costUsd!);
    // l1 covers its call and the subagent's first call. l3 covers the resumed subagent's call, and its own call is unpriced.
    assert.ok(l1 > 0 && l3 > 0 && Math.abs(l1 - l3 * 2) < 0.001, `${l1} ${l3}`);
    assert.ok(l1 + l3 < long.costUsd, "the command turn belongs to no prompt");
    assert.equal(long.unpricedCalls, 1);

    assert.deepEqual([day[1].prompts, day[1].costUsd, day[1].unpricedCalls], [[], 0, 1]);
    assert.deepEqual(day[2].prompts.map((p) => [p.costUsd, p.unpricedCalls]), [[null, 0]]);
    // Copilot logs usage as one aggregate at shutdown, outside the turn.
    assert.deepEqual(day[3].prompts.map((p) => p.costUsd), [null]);
    assert.ok(day[3].costUsd > 0);
    const [w1, w2] = day[4].prompts;
    assert.deepEqual([w1.turn, w2.turn, w1.at === w2.at], ["w1", "w2", true]);
    assert.ok(Math.abs(w2.costUsd! - w1.costUsd! * 2) < 0.001, `${w1.costUsd} ${w2.costUsd}`);

    // Every session wf export counts on a day prints for that day.
    const exported = JSON.parse(String(run(["export", "-d", "2026-10-12..2026-10-15"], at("16T00:00:00")))).rows as { day: string; harness: string; repository: string | null; sessions: number }[];
    const all = prompts("2026-10-12..2026-10-15");
    const key = (r: { day: string; harness: string; repository: string | null }) => `${r.day} ${r.harness} ${r.repository}`;
    const counted = new Map<string, number>();
    for (const r of exported) counted.set(key(r), (counted.get(key(r)) ?? 0) + r.sessions);
    const printed = new Map<string, number>();
    for (const r of all) printed.set(key(r), (printed.get(key(r)) ?? 0) + 1);
    assert.deepEqual(printed, counted);
    assert.equal(all.find((s) => s.session === "claude:orch")!.skill, "orchestrator");
    assert.deepEqual(prompts("2026-10-12").map((s) => s.session), ["claude:orch"]);
  } finally {
    for (const [name, original] of Object.entries(adapters)) {
      ADAPTERS[name as keyof typeof ADAPTERS].list = original.list;
      ADAPTERS[name as keyof typeof ADAPTERS].load = original.load;
    }
  }
});
