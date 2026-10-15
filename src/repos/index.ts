import { spawnSync } from "node:child_process";
import { matchesGlob, resolve, basename } from "node:path";
import { TextDecoder } from "node:util";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { repositoryEntries, type RepositoryEntry } from "../catalog.ts";
import { table, thousands } from "../commands/format.ts";

export type Category = "code" | "test" | "test data" | "docs" | "data" | "config";
export type Measures = { files: number; lines: number; tokens: number; markdown: number };
export type FileMeasure = Measures & { path: string; category: Category; domain: string };
export type RepoReport = { files: FileMeasure[]; categories: Record<Category, Measures>; folders: Map<string, Measures>; domains: Map<string, Measures>; gitMs: number; tokenMs: number; uniqueBlobs: number; bytes: number };
const CATEGORIES: Category[] = ["code", "test", "test data", "docs", "data", "config"];
const OVERRIDE_ORDER: Category[] = ["test data", "test", "docs", "data", "config", "code"];
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock", "uv.lock", "go.sum", "Gemfile.lock", "composer.lock"]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const ordinaryText = { allowedSpecial: new Set<string>(), disallowedSpecial: new Set<string>() };
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const comparePaths = (a: string, b: string): number => {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = compare(left[i], right[i]);
    if (order) return order;
  }
  return left.length - right.length;
};
const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_PREFIX: undefined };
const empty = (): Measures => ({ files: 0, lines: 0, tokens: 0, markdown: 0 });
const add = (to: Measures, from: Measures): void => { to.files += from.files; to.lines += from.lines; to.tokens += from.tokens; to.markdown += from.markdown; };

function git(cwd: string, args: string[], input?: string): Buffer {
  const result = spawnSync("git", args, { cwd, input, env: gitEnv, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`repo: ${result.error?.message || String(result.stderr).trim() || "Git read failed"}`);
  return result.stdout;
}

function glob(path: string, pattern: string): boolean {
  return matchesGlob(path, pattern) || (pattern.endsWith("/**") && path.startsWith(pattern.slice(0, -3) + "/"));
}

export function categoryOf(path: string, entry?: RepositoryEntry): Category {
  for (const category of OVERRIDE_ORDER) if (entry?.categories?.[category]?.some((pattern) => glob(path, pattern))) return category;
  const parts = path.split("/");
  const name = parts.at(-1)!;
  const testAt = parts.findIndex((p) => p === "test" || p === "tests");
  if (testAt >= 0 && parts.slice(testAt + 1, -1).some((p) => ["fixtures", "fixture-variants", "golden"].includes(p))) return "test data";
  if (testAt >= 0 || /(?:\.test\.|_test\.|\.spec\.)/.test(name)) return "test";
  if (name.endsWith(".md")) return "docs";
  if (parts[0] === "data") return "data";
  if (parts.length === 1 && (name.startsWith(".") || ["package.json", "tsconfig.json", "Cargo.toml", "pyproject.toml", "go.mod", "Makefile"].includes(name))) return "config";
  return "code";
}

export function measureRepository(directory: string, commit = "HEAD", selected?: ReadonlySet<Category>, blobCache = new Map<string, { lines: number; tokens: number; markdown: number }>()): RepoReport {
  const cwd = resolve(directory);
  const start = performance.now();
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).toString().trim();
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, env: gitEnv, encoding: "utf8" });
  const identity = remote.status === 0 ? /(?:github\.com[:/])([^/]+\/[^/.]+)(?:\.git)?\s*$/.exec(remote.stdout)?.[1] : undefined;
  const entry = identity ? repositoryEntries[identity] : undefined;
  const tree = git(root, ["ls-tree", "-rz", "--full-tree", commit]);
  const records = tree.toString().split("\0").filter(Boolean).flatMap((record) => {
    const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(record);
    return match && (match[1] === "100644" || match[1] === "100755") ? [{ oid: match[2], path: match[3] }] : [];
  });
  const oids = [...new Set(records.filter((r) => !LOCKFILES.has(basename(r.path)) && (!selected || selected.has(categoryOf(r.path, entry))) && !blobCache.has(r.oid)).map((r) => r.oid))];
  const batch = oids.length ? git(root, ["cat-file", "--batch"], oids.join("\n") + "\n") : Buffer.alloc(0);
  let offset = 0;
  const contents = new Map<string, Buffer>();
  for (const oid of oids) {
    const end = batch.indexOf(10, offset);
    if (end < 0) throw new Error("repo: incomplete Git batch response");
    const size = Number(batch.toString("utf8", offset, end).split(" ")[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`repo: missing blob ${oid}`);
    contents.set(oid, batch.subarray(end + 1, end + 1 + size));
    offset = end + 2 + size;
  }
  const gitMs = performance.now() - start;
  const tokenStart = performance.now();
  const textMeasures = blobCache;
  for (const [oid, buffer] of contents) {
    if (buffer.includes(0)) continue;
    let content: string;
    try { content = decoder.decode(buffer); } catch { continue; }
    const tokens = encode(content, ordinaryText).length;
    textMeasures.set(oid, { lines: content.split(/\r?\n/).filter((line) => line.trim().length > 0).length, tokens, markdown: [...content].length });
  }
  const tokenMs = performance.now() - tokenStart;
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, empty()])) as Record<Category, Measures>;
  const folders = new Map<string, Measures>();
  const domains = new Map<string, Measures>();
  const files = records.map(({ oid, path }) => {
    const category = categoryOf(path, entry);
    const domain = Object.entries(entry?.domains ?? {}).find(([, patterns]) => patterns.some((pattern) => glob(path, pattern)))?.[0] ?? (path.includes("/") ? path.split("/")[0] : ".");
    const measure = LOCKFILES.has(basename(path)) || (selected && !selected.has(category)) ? undefined : textMeasures.get(oid);
    const value: FileMeasure = { path, category, domain, files: 1, lines: measure?.lines ?? 0, tokens: measure?.tokens ?? 0, markdown: path.endsWith(".md") ? measure?.markdown ?? 0 : 0 };
    add(categories[category], value);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!folders.has(folder)) folders.set(folder, empty());
      add(folders.get(folder)!, value);
    }
    if (!domains.has(domain)) domains.set(domain, empty());
    add(domains.get(domain)!, value);
    return value;
  });
  return { files, categories, folders, domains, gitMs, tokenMs, uniqueBlobs: oids.length, bytes: [...contents.values()].reduce((n, b) => n + b.length, 0) };
}

const count = (n: number) => n.toLocaleString("en-US");

export function formatRepository(report: RepoReport, depth = 2, largest = 10): string {
  const row = (name: string, m: Measures) => [name, count(m.files), thousands(m.lines), thousands(m.tokens), count(m.markdown)];
  const render = (rows: string[][]) => table(["name", "files", "lines", "tokens", "markdown"], rows, [1, 2, 3, 4]);
  const total = empty();
  for (const category of CATEGORIES) add(total, report.categories[category]);
  const codeLines = report.categories.code.lines;
  const share = codeLines ? `${(100 * report.categories.test.lines / codeLines).toFixed(1)}%` : "n/a";
  const folders = [...report.folders].filter(([path]) => path.split("/").length <= depth).sort(([a], [b]) => comparePaths(a, b));
  const biggest = [...report.files].sort((a, b) => b.tokens - a.tokens || compare(a.path, b.path)).slice(0, largest);
  const domains = [...report.domains].sort(([a], [b]) => compare(a, b));
  const folderRow = ([path, measure]: [string, Measures]) => row(`${"  ".repeat(path.split("/").length - 1)}${basename(path)}/`, measure);
  return ["Repository size", "", "Categories", render([...CATEGORIES.map((c) => row(c, report.categories[c])), row("total", total)]), `test lines / code lines: ${share}`, "", "Domains", render(domains.map(([name, measure]) => row(name, measure))), "", `Folders (depth ${depth})`, render([row(".", total), ...folders.map(folderRow)]), "", "Largest files by tokens", render(biggest.map((file) => row(file.path, file)))].join("\n");
}
