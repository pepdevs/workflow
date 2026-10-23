// Exercise the publication boundary against real, local Git objects, without a remote.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("publication audit scans outgoing trees independently of the checkout", () => {
  const scratch = mkdtempSync(join(tmpdir(), "workflow-public-check-"));
  const root = join(scratch, "repo");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (message = "Update fixture") => { git("add", "-A"); git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
  const audit = (revisions?: string) => spawnSync("python3", ["scripts/public-check.py", "--require-denylist", "--denylist", "../terms.json", ...(revisions ? [`--commits=${revisions}`] : [])], { cwd: root, env, encoding: "utf8" });
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(resolve("scripts/public-check.py"), join(root, "scripts/public-check.py"));
    writeFileSync(join(scratch, "terms.json"), JSON.stringify(["DUMMY_PRIVATE_AUDIT_TERM"]));
    const files = ["scripts/public-check.py", "export-allowlist.json", "public.txt", "removed.txt", "binary.dat", "link"];
    const manifest = { files: files.map((path) => ({ path, mode: path === "scripts/public-check.py" ? "0755" : "0644", ...(path === "binary.dat" ? { approvedBinary: "synthetic-git-bundle", binarySha256: createHash("sha256").update("Ready for publication.\n").digest("hex") } : {}) })) };
    writeFileSync(join(root, "export-allowlist.json"), JSON.stringify(manifest));
    for (const path of ["public.txt", "removed.txt", "binary.dat", "link"]) writeFileSync(join(root, path), "Ready for publication.\n");
    git("init", "-q", "--template=", "-b", "main");
    const base = commit("Initial fixture");
    assert.equal(audit().status, 0);
    assert.equal(audit(base).status, 0, "clean selected tree and approved binary pass");
    writeFileSync(join(root, "public.txt"), "DUMMY_PRIVATE_AUDIT_TERM\n");
    const privateHead = commit();
    assert.equal(audit(`${base}..${privateHead}`).status, 1, "current-file positive control");
    writeFileSync(join(root, "public.txt"), "Ready for publication.\n");
    const cleanHead = commit();
    const history = audit(`${base}..${cleanHead}`);
    assert.equal(history.status, 1, "clean HEAD must not hide private intermediate content");
    assert.match(history.stderr, /commit [a-f0-9]+ public\.txt:1: external private term/);
    git("checkout", "-q", base);
    assert.equal(audit(`${base}..${privateHead}`).status, 1, "pushed ref differs from clean checkout");
    assert.equal(audit(`${base}..${base}`).status, 0, "empty selection");
    assert.notEqual(audit("missing-object").status, 0, "unreadable revisions fail closed");
    git("checkout", "-q", "main");
    writeFileSync(join(root, "removed.txt"), "DUMMY_PRIVATE_AUDIT_TERM\n");
    commit();
    rmSync(join(root, "removed.txt"));
    manifest.files = manifest.files.filter((record: { path: string }) => record.path !== "removed.txt");
    writeFileSync(join(root, "export-allowlist.json"), JSON.stringify(manifest));
    const deleted = commit();
    assert.equal(audit().status, 0);
    assert.equal(audit(`${cleanHead}..${deleted}`).status, 1, "deleted historical file");
    writeFileSync(join(root, "unapproved.txt"), "Ready for publication.\n");
    const unapproved = commit();
    git("checkout", "-q", deleted);
    assert.match(audit(`${deleted}..${unapproved}`).stderr, /unapproved file: unapproved\.txt/);
    const blob = git("hash-object", "-w", "--stdin");
    // Construct hostile historical trees while the checkout remains clean.
    for (const [mode, oid, path, diagnostic] of [
      ["120000", blob, "link", /resource mode 120000 needs review/],
      ["160000", deleted, "link", /resource mode 160000 needs review/],
      ["100755", blob, "link", /approved file mode changed/],
      ["100644", blob, "binary.dat", /approved binary fingerprint changed/],
    ] as const) {
      git("read-tree", deleted);
      git("update-index", "--cacheinfo", `${mode},${oid},${path}`);
      const head = git("commit-tree", git("write-tree"), "-p", deleted, "-m", "Historical fixture");
      const result = audit(`${deleted}..${head}`);
      assert.equal(result.status, 1);
      assert.match(result.stderr, diagnostic);
    }
    const message = git("commit-tree", git("write-tree"), "-p", deleted, "-m", "DUMMY_PRIVATE_AUDIT_TERM");
    assert.match(audit(`${deleted}..${message}`).stderr, /message:1: external private term/);
    rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    assert.match(audit(`${deleted}..${message}`).stderr, /cannot read selected commit objects/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
