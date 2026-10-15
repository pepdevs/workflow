import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryEntries, type RepositoryEntry } from "../catalog.ts";
import { launchOf } from "../facts.ts";
import type { Session } from "../model.ts";

export type Provenance = { repository: string; commit: string; name?: string; sha?: string; clone?: string; estimated?: boolean };
const catalogRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_PREFIX: undefined };

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class ProvenanceCall {
  private readonly worktrees = new Map<string, string[]>();
  private readonly commands = new Map<string, string | null>();
  private readonly commits = new Map<string, boolean>();
  private readonly entries: Record<string, RepositoryEntry>;

  constructor(entries: Record<string, RepositoryEntry> = repositoryEntries) {
    this.entries = entries;
  }

  private git(cwd: string, args: string[]): string | null {
    const key = JSON.stringify([cwd, args]);
    if (!this.commands.has(key)) {
      const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
      this.commands.set(key, result.status === 0 ? result.stdout.trim() : null);
    }
    return this.commands.get(key)!;
  }

  private paths(clone: string): string[] {
    if (!this.worktrees.has(clone)) {
      const output = this.git(clone, ["worktree", "list", "--porcelain"]);
      this.worktrees.set(clone, output?.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9)) ?? []);
    }
    return this.worktrees.get(clone)!;
  }

  private matches(cwd: string): string[] {
    return Object.entries(this.entries).filter(([, entry]) => {
      const clone = resolve(catalogRoot, entry.path);
      if (!existsSync(clone)) return false;
      // The directory or one of its parents matches, so dot folders inside a worktree match too.
      const dirs = [cwd];
      while (dirname(dirs.at(-1)!) !== dirs.at(-1)) dirs.push(dirname(dirs.at(-1)!));
      if (entry.worktrees?.some((pattern) => dirs.some((dir) => matchesGlob(dir, resolve(catalogRoot, pattern))))) return true;
      return this.paths(clone).some((path) => inside(path, cwd));
    }).map(([name]) => name);
  }

  prepare(sessions: readonly Session[], readClones: boolean): void {
    if (!readClones) return;
    const byClone = new Map<string, Set<string>>();
    for (const session of sessions) {
      const launch = launchOf(session);
      const cwd = session.cwd && isAbsolute(session.cwd) ? resolve(session.cwd) : null;
      const inferred = !launch?.repo && cwd ? this.matches(cwd) : [];
      const name = launch?.repo ?? (inferred.length === 1 ? inferred[0] : null);
      const entry = name ? this.entries[name] : undefined;
      const sha = launch?.commit ?? session.startGit?.commit;
      if (!entry || !sha || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) continue;
      const clone = resolve(catalogRoot, entry.path);
      if (!byClone.has(clone)) byClone.set(clone, new Set());
      byClone.get(clone)!.add(sha);
    }
    for (const [clone, shas] of byClone) {
      const missing = [...shas].filter((sha) => !this.commits.has(`${clone}:${sha}`));
      if (!missing.length) continue;
      const result = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: clone, env: gitEnv, encoding: "utf8", input: `${missing.join("\n")}\n` });
      const lines = result.status === 0 ? result.stdout.trim().split("\n") : [];
      missing.forEach((sha, i) => this.commits.set(`${clone}:${sha}`, lines[i] === `${sha} commit`));
    }
  }

  // The repository a session worked in, as its name without owner or path, from
  // evidence that outlives the directory: the launch header, the repository the
  // harness logged at start, then the catalog clone whose worktree or worktree
  // pattern holds the directory. A directory that still exists falls back to its
  // Git repository's origin, then its main checkout. Anything else is null, so a
  // folder name never stands in for a repository. Custom log roots skip Git reads.
  repositoryName(session: Session, readClones: boolean): string | null {
    const launch = launchOf(session);
    if (launch?.repo) return launch.repo.split("/").at(-1)!;
    const logged = repositoryOfRemote(session.startGit?.repository);
    if (logged) return logged;
    const cwd = session.cwd && isAbsolute(session.cwd) ? resolve(session.cwd) : null;
    if (!readClones || !cwd) return null;
    const matches = this.matches(cwd);
    if (matches.length === 1) return matches[0].split("/").at(-1)!;
    if (!existsSync(cwd)) return null;
    const origin = repositoryOfRemote(this.git(cwd, ["remote", "get-url", "origin"]) ?? undefined);
    if (origin) return origin;
    // A worktree shares the main checkout's Git directory, so it reports that checkout's name.
    const common = this.git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common) return null;
    return basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
  }

  resolve(session: Session, readClones: boolean, details = false): Provenance {
    const launch = launchOf(session);
    const cwd = session.cwd && isAbsolute(session.cwd) ? resolve(session.cwd) : null;
    const matches = readClones && !launch?.repo && cwd ? this.matches(cwd) : [];
    const inferred = matches.length === 1 ? matches[0] : null;
    const repository = launch?.repo ? `${launch.repo} (header)` : inferred ? `${inferred} (directory)` : `unknown (${!cwd ? "session directory missing" : !readClones ? "custom log root" : matches.length > 1 ? "directory matches multiple repositories" : "directory matches no repository"})`;
    const name = launch?.repo ?? inferred;
    const entry = name ? this.entries[name] : undefined;
    const clone = entry && readClones ? resolve(catalogRoot, entry.path) : null;
    const recorded = launch?.commit ?? session.startGit?.commit;
    if (recorded) {
      const source = launch?.commit ? "header" : "harness SHA";
      const valid = clone && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(recorded) && this.commitExists(clone, recorded);
      return { repository, commit: valid ? `${recorded} (${source})` : `unknown (${source} ${recorded}: ${clone ? "commit absent from clone" : "clone unavailable"})`, ...(details ? { name: name ?? undefined, sha: valid ? recorded : undefined, clone: valid ? clone! : undefined } : {}) };
    }
    const branch = session.startGit?.branch;
    if (clone && branch && Number.isFinite(session.startGit?.at)) {
      const ref = `refs/heads/${branch}`;
      if (this.git(clone, ["show-ref", "--verify", "--hash", ref])) {
        const sha = this.git(clone, ["rev-list", "-1", `--before=${new Date(session.startGit!.at).toISOString()}`, ref]);
        if (sha) return { repository, commit: `${sha} (branch at start, est.)`, ...(details ? { name: name ?? undefined, sha, clone, estimated: true } : {}) };
      }
      return { repository, commit: `unknown (branch ${branch} has no commit before session start)` };
    }
    return { repository, commit: `unknown (${!clone ? "clone unavailable" : branch ? "branch unavailable" : "no starting commit evidence"})` };
  }

  private commitExists(clone: string, sha: string): boolean {
    const key = `${clone}:${sha}`;
    if (!this.commits.has(key)) this.commits.set(key, this.git(clone, ["cat-file", "-t", sha]) === "commit");
    return this.commits.get(key)!;
  }
}

// The repository name in a remote URL (https, ssh or scp form), a local clone's
// absolute path, or an owner/name pair; null for anything else, such as a redacted placeholder.
function repositoryOfRemote(remote: string | undefined): string | null {
  const local = remote?.trim().match(/^(?:file:\/\/)?\/(?:[^/]+\/)*([\w.-]+?)(?:\.git)?\/?$/);
  if (local) return local[1];
  const match = remote?.trim().match(/^(?:[a-z+]+:\/\/[^/]+\/|[\w.-]+@[\w.-]+:|[\w.-]+\/)(?:[\w.-]+\/)*([\w.-]+?)(?:\.git)?\/?$/i);
  return match?.[1] ?? null;
}

export function sessionProvenance(session: Session, readClones: boolean, entries: Record<string, RepositoryEntry> = repositoryEntries, details = false): Provenance {
  return new ProvenanceCall(entries).resolve(session, readClones, details);
}
