// uc-22: what each merged branch added to a repository, and how much of it a
// later commit replaced. Reads only the local clone, as last fetched.
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { REWORK_DAYS, repositoryEntries } from "../catalog.ts";
import { categoryOf, isLockfile, type Category } from "./index.ts";
import { includedName, repositoryOfRemote } from "./provenance.ts";

export type Lines = Partial<Record<Category, number>>;

export type Change = {
  repository: string;
  pullRequest: string | null;
  branch: string;
  mergedAt: string;
  merge: string;
  commits: number;
  added: Lines;
  // When surviving was measured: the merge plus REWORK_DAYS; surviving is null until then.
  reworkAt: string;
  surviving: Lines | null;
};

const DAY = 86_400_000;
const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_PREFIX: undefined };

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// The branch a merge commit names: GitHub's "Merge pull request #N from owner/branch", or git's "Merge branch 'x'".
export function mergedBranch(subject: string): { pr: number | null; branch: string } | null {
  const pr = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject);
  if (pr) return { pr: Number(pr[1]), branch: pr[2]! };
  const local = /^Merge branch '([^']+)'/.exec(subject);
  return local ? { pr: null, branch: local[1]! } : null;
}

const add = (lines: Lines, category: Category, n: number) => { if (n) lines[category] = (lines[category] ?? 0) + n; };

// The changes merged into the clone's default branch in [from, to), oldest first.
export function changesOf(clone: string, from: number, to: number, now: number): Change[] {
  const dir = resolve(clone);
  const origin = git(dir, ["remote", "get-url", "origin"])?.trim();
  const repository = includedName(repositoryOfRemote(origin) ?? basename(dir));
  // owner/name on a GitHub host, from an SSH or HTTPS origin.
  const hosted = /(github\.com)[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin ?? "");
  const entry = Object.values(repositoryEntries).find((e) => resolve(e.path) === dir);
  const head = git(dir, ["rev-parse", "--abbrev-ref", "origin/HEAD"])?.trim();
  const ref = head && head !== "origin/HEAD" ? head : git(dir, ["rev-parse", "--verify", "-q", "origin/main"]) ? "origin/main" : "HEAD";
  const range = [...(Number.isFinite(from) ? [`--since=${new Date(from).toISOString()}`] : []), ...(Number.isFinite(to) ? [`--until=${new Date(to).toISOString()}`] : [])];
  const log = git(dir, ["log", "--first-parent", "--merges", "--format=%H%x09%P%x09%cI%x09%s", ...range, ref]) ?? "";
  const out: Change[] = [];
  for (const line of log.split("\n").filter(Boolean).reverse()) {
    const [merge, parents, mergedAt, subject] = line.split("\t") as [string, string, string, string];
    const [main, tip, ...more] = parents.split(" ");
    const named = mergedBranch(subject);
    if (!named || !main || !tip || more.length) continue;
    const at = Date.parse(mergedAt);
    if (at < from || at >= to) continue;
    const base = git(dir, ["merge-base", main, tip])?.trim();
    if (!base) continue;
    const commits = new Set((git(dir, ["rev-list", `${base}..${tip}`]) ?? "").split("\n").filter(Boolean));
    const files: { path: string; category: Category; added: number }[] = [];
    for (const row of (git(dir, ["diff", "--numstat", "--no-renames", base, tip]) ?? "").split("\n").filter(Boolean)) {
      const [plus, , path] = row.split("\t") as [string, string, string];
      // Binary files print - for their counts.
      if (plus === "-" || plus === "0" || isLockfile(path)) continue;
      files.push({ path, category: categoryOf(path, entry), added: Number(plus) });
    }
    const added: Lines = {};
    for (const f of files) add(added, f.category, f.added);
    const reworkAt = at + REWORK_DAYS * DAY;
    let surviving: Lines | null = null;
    if (reworkAt <= now) {
      surviving = {};
      const rev = git(dir, ["rev-list", "-1", "--first-parent", `--before=${new Date(reworkAt).toISOString()}`, ref])?.trim();
      for (const f of files) {
        // A file deleted or moved since keeps none of its lines.
        const blame = rev ? git(dir, ["blame", "-w", "--porcelain", rev, "--", f.path]) : null;
        let kept = 0;
        for (const header of blame?.match(/^[0-9a-f]{40} \d+ \d+/gm) ?? []) if (commits.has(header.slice(0, 40))) kept++;
        add(surviving, f.category, Math.min(kept, f.added));
      }
    }
    out.push({
      repository,
      pullRequest: hosted && named.pr !== null ? `https://${hosted[1]}/${hosted[2]}/pull/${named.pr}` : null,
      branch: named.branch,
      mergedAt: new Date(at).toISOString(),
      merge,
      commits: commits.size,
      added,
      reworkAt: new Date(reworkAt).toISOString(),
      surviving,
    });
  }
  return out;
}
