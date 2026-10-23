import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { ADAPTERS, LOGINS } from "../src/harnesses/index.ts";
import { archiveTree, getJson } from "../src/cli.ts";

test("Copilot fixture output rejects path-shaped identities and linked destinations", () => {
  const scratch = mkdtempSync(join(tmpdir(), "workflow-copilot-cut-"));
  const fixture = ADAPTERS.copilot.list(["test/fixtures/copilot"])[0];
  const original = readFileSync(fixture.ref, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const root = join(scratch, "input");
  const out = join(scratch, "output");
  const sibling = join(scratch, "sibling");
  const file = join(root, "session", basename(fixture.ref));
  try {
    mkdirSync(join(root, "session"), { recursive: true });
    mkdirSync(sibling);
    writeFileSync(join(sibling, basename(fixture.ref)), "sentinel");
    for (const id of ["../sibling", "nested/session", "..", ".", "/absolute", "windows\\path", "line\nbreak", 42]) {
      const events = structuredClone(original);
      events.find((event) => event.type === "session.start").data.sessionId = id;
      writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      assert.throws(() => ADAPTERS.copilot.cutFixture("session", out, [root]), /invalid Copilot fixture session id/, String(id));
      assert.equal(readFileSync(join(sibling, basename(fixture.ref)), "utf8"), "sentinel");
    }
    const events = structuredClone(original);
    events.find((event) => event.type === "session.start").data.sessionId = "safe-session";
    writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    mkdirSync(out);
    symlinkSync(sibling, join(out, "safe-session"));
    assert.throws(() => ADAPTERS.copilot.cutFixture("session", out, [root]));
    rmSync(join(out, "safe-session"));
    mkdirSync(join(out, "safe-session"));
    symlinkSync(join(sibling, basename(fixture.ref)), join(out, "safe-session", basename(fixture.ref)));
    assert.throws(() => ADAPTERS.copilot.cutFixture("session", out, [root]));
    assert.equal(readFileSync(join(sibling, basename(fixture.ref)), "utf8"), "sentinel");
    rmSync(join(out, "safe-session", basename(fixture.ref)));
    ADAPTERS.copilot.cutFixture("session", out, [root]);
    assert.equal(JSON.parse(readFileSync(join(out, "safe-session", basename(fixture.ref)), "utf8").split("\n")[0]).type, original[0].type);
    writeFileSync(join(out, "safe-session", "workspace.yaml"), `name: ${JSON.stringify("safe\x1b[2Jtitle")}\n`);
    const displayed = spawnSync(process.execPath, ["--import=./scripts/test-config.ts", "src/cli.ts", "summary", "copilot", "safe-session", "--root", out], { encoding: "utf8" });
    assert.equal(displayed.status, 0, displayed.stderr);
    assert.match(displayed.stdout, /safetitle/);
    assert.doesNotMatch(displayed.stdout, /\x1b/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("provider JSON bounds the stream before buffering and cancels on failure", async () => {
  const originalFetch = globalThis.fetch;
  const limit = 256 * 1024;
  try {
    for (const [chunkBytes, chunks] of [[limit + 1, 1], [64 * 1024, 6]]) {
      let cancelled = false;
      let reads = 0;
      globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads++ < chunks) controller.enqueue(new Uint8Array(chunkBytes).fill(32));
          else controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }));
      await assert.rejects(getJson("https://example.invalid", {}), /response too large/);
      assert.equal(cancelled, true);
      assert.ok(reads <= Math.floor(limit / chunkBytes) + 1, "stop consuming at the byte limit");
    }
    globalThis.fetch = async () => new Response(`{"value":"${"é".repeat(limit / 2)}"}`);
    await assert.rejects(getJson("https://example.invalid", {}), /response too large/, "bound bytes rather than UTF-16 characters");
    globalThis.fetch = async () => new Response(" ".repeat(limit - 2) + "{}");
    assert.deepEqual(await getJson("https://example.invalid", {}), {});
    globalThis.fetch = async () => new Response("bad json");
    await assert.rejects(getJson("https://example.invalid", {}), /malformed response/);
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("sensitive body")); } }));
    await assert.rejects(getJson("https://example.invalid", {}), /^Error: network error$/);
  } finally { globalThis.fetch = originalFetch; }
});

test("installed harness output is bounded without exposing its content", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workflow-output-limit-"));
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = scratch;
    for (const command of ["pi", "codex"]) writeFileSync(join(scratch, command), `#!${process.execPath}\nprocess.stdout.write('sensitive-body'.repeat(100000));\n`, { mode: 0o700 });
    await assert.rejects(LOGINS.piApiKey("fixture"), /^Error: pi output too large$/);
    await assert.rejects(LOGINS.codexRateLimits(), /^Error: codex app-server output too large$/);
    writeFileSync(join(scratch, "pi"), `#!${process.execPath}\nprocess.stdout.write('  fixture-value  ');\n`, { mode: 0o700 });
    assert.equal(await LOGINS.piApiKey("fixture"), "fixture-value");
    writeFileSync(join(scratch, "codex"), `#!${process.execPath}\n
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.id) console.log(JSON.stringify({ id: request.id, result: { fixture: true } }));
      });\n`, { mode: 0o700 });
    assert.deepEqual(await LOGINS.codexRateLimits(), { fixture: true });
  } finally { process.env.PATH = oldPath; rmSync(scratch, { recursive: true, force: true }); }
});

test("archive files are private at creation and preserve copy and shrink behavior", () => {
  const scratch = mkdtempSync(join(tmpdir(), "workflow-archive-mode-"));
  const live = join(scratch, "live");
  const target = join(scratch, "archive");
  const oldMask = process.umask(0);
  try {
    mkdirSync(live);
    writeFileSync(join(live, "session.log"), "original content");
    symlinkSync(live, join(live, "cycle"));
    symlinkSync(join(live, "session.log"), join(live, "alias.log"));
    assert.deepEqual(archiveTree(live, target, () => true), { files: 1, copied: 1, shrunk: 0 });
    assert.equal(statSync(target).mode & 0o777, 0o700);
    assert.equal(statSync(join(target, "session.log")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(target, "session.log"), "utf8"), "original content");
    writeFileSync(join(live, "session.log"), "short");
    assert.deepEqual(archiveTree(live, target, () => true), { files: 1, copied: 0, shrunk: 1 });
    assert.equal(statSync(join(target, "session.log.shrunk-1")).mode & 0o777, 0o600);
    assert.deepEqual(archiveTree(live, target, () => true), { files: 1, copied: 0, shrunk: 0 });
    const sentinel = join(scratch, "sentinel");
    writeFileSync(sentinel, "keep");
    symlinkSync(sentinel, join(target, "linked.log"));
    writeFileSync(join(live, "linked.log"), "must not overwrite sentinel");
    assert.throws(() => archiveTree(live, target, () => true));
    assert.equal(readFileSync(sentinel, "utf8"), "keep");
  } finally { process.umask(oldMask); rmSync(scratch, { recursive: true, force: true }); }
});
