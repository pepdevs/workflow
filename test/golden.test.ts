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
for (const useCase of useCases) {
  const perSession = useCase.commands.filter((c) => c.includes("<session>"));
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
// launches a model, and `usage` reads providers.
for (const useCase of useCases) {
  const allSessions = useCase.commands.filter((c) => !c.includes("<session>") && !["archive", "run", "usage", "repo"].includes(c[0]));
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
