// Link the CLI into an explicit directory, or the user's local bin directory.
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const { values } = parseArgs({ options: { "bin-dir": { type: "string" } } });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(values["bin-dir"] ?? join(homedir(), ".local", "bin"));
const target = join(directory, "wf");
const source = join(root, "src", "cli.ts");
mkdirSync(directory, { recursive: true });
try {
  const entry = lstatSync(target);
  if (!entry.isSymbolicLink()) throw new Error(`setup refuses to replace a regular file: ${target}`);
  if (resolve(directory, readlinkSync(target)) !== source) unlinkSync(target);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
if (!existsSync(target)) symlinkSync(source, target);
chmodSync(source, 0o755);
const hooks = spawnSync("git", ["-C", root, "config", "--local", "core.hooksPath", ".githooks"], { encoding: "utf8" });
if (hooks.error || hooks.status !== 0) throw new Error(hooks.error?.message || hooks.stderr || "setup needs a Git checkout to configure its pre-push check");
console.log(`Linked ${target}; add ${directory} to PATH.`);
