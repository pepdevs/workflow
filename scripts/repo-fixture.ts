// Build a small committed repository that exercises each repository-size boundary.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "wf-repo-fixture-"));
const output = "test/fixtures/repo.bundle";
const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_PREFIX: undefined };
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...gitEnv, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
try {
  git("init", "-q", "-b", "main");
  const sharedLockfileContent = "many tokens excluded by lockfile\n";
  const files: Record<string, string | Buffer> = {
    "README.md": "# Héllo 🌍\n\nSmall repository.\nExample: <|endoftext|>\n",
    "src/main.ts": "export const greeting = 'hello';\n",
    "src/empty.ts": "",
    "src/duplicate.txt": sharedLockfileContent,
    "test/main.test.ts": "import { greeting } from '../src/main';\nconsole.log(greeting);\n",
    "test/fixtures/guide.md": "# Fixture documentation\n",
    "test/golden/result.txt": "expected\n",
    "test-other/file.ts": "export const separate = true;\n",
    "notes/plan.txt": "domain override\n",
    "data/sample.json": "{\"value\":true}\n",
    "package.json": "{\"name\":\"fixture\"}\n",
    "package-lock.json": sharedLockfileContent,
    "assets/image.bin": Buffer.from([0, 1, 2, 255]),
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  symlinkSync("src/main.ts", join(root, "link.ts"));
  git("add", ".");
  git("commit", "-qm", "Fixture repository");
  const head = git("rev-parse", "HEAD");
  git("update-index", "--add", "--cacheinfo", `160000,${head},module`);
  git("commit", "-qm", "Add submodule entry");
  git("remote", "add", "origin", "git@github.com:fixture/repo.git");
  git("bundle", "create", join(process.cwd(), output), "HEAD");
  console.log(`${output}: ${git("rev-parse", "HEAD")}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
