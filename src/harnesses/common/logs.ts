// Log files shared by every harness: the archive, file indexes and prompt markers.
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { webAction } from "../../catalog.ts";
import type { SessionResult, WebUse } from "../../model.ts";

export function resultFromReply(reply: string): SessionResult | null {
  const markers = [...reply.matchAll(/<!--\s*workflow-result:\s*([\s\S]*?)-->/g)];
  const raw = markers.at(-1)?.[1];
  if (!raw) return null;
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value?.schema !== 1 || !["complete", "checkpoint", "blocked"].includes(value.status)) return null;
  if (value.status === "blocked" && value.pullRequest === null && value.headSha === null) {
    return { status: "blocked", pullRequest: null, headSha: null };
  }
  if (typeof value.pullRequest !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(value.pullRequest)) return null;
  if (typeof value.headSha !== "string" || !/^[0-9a-fA-F]{40}$/.test(value.headSha)) return null;
  return { status: value.status, pullRequest: value.pullRequest, headSha: value.headSha.toLowerCase() };
}

// Raw harness logs copied by `workflow archive`, one directory per harness.
export const ARCHIVE_ROOT = process.env.WORKFLOW_ARCHIVE ?? join(homedir(), ".local", "share", "workflow", "archive");

export const archiveDir = (harness: string) => join(ARCHIVE_ROOT, harness);

// Files under the roots, keyed by path relative to their root. The first root
// holding a relative path wins, so the live copy of a file shadows the archived one.
export function unionFiles(roots: string[], keep: (rel: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const s = lstatSync(p);
        if (s.isDirectory()) walk(p);
        else if (s.isFile()) {
          const rel = relative(root, p);
          if (keep(rel) && !out.has(rel)) out.set(rel, p);
        }
      }
    };
    walk(root);
  }
  return out;
}

// A root session found without parsing it: what `load` takes, the session id,
// and when its log was last written.
export type SessionRef = { ref: string; id: string; updatedAt: number };

// Reuse each file index while loading sessions; each listing refreshes it.
export function cachedByRoots<T>(build: (roots: string[]) => T): (roots: string[], refresh?: boolean) => T {
  const cache = new Map<string, T>();
  return (roots, refresh = false) => {
    const key = roots.join("\0");
    if (refresh || !cache.has(key)) cache.set(key, build(roots));
    return cache.get(key)!;
  };
}

// Skill name from any text that names a SKILL.md path: the directory above it.
export function skillFromPath(text: string): string | null {
  const m = /([A-Za-z0-9_.-]+)\/SKILL\.md/.exec(text);
  return m ? m[1] : null;
}

export function turnTriggerFromText(text: string): "prompt" | "command" | "notification" {
  if (text.startsWith("<command-name>")) return "command";
  if (text.startsWith("<task-notification>")) return "notification";
  return "prompt";
}

// Programs whose file arguments a shell read names, and the options that take a value.
const SHELL_READERS = new Set(["cat", "sed", "nl", "head", "tail", "rg", "grep", "wc", "less", "bat"]);
const SEARCH_OPTIONS = ["-e", "-f", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-A", "-B", "-C", "-m", "--max-count"];
const VALUE_OPTIONS: Record<string, string[]> = { head: ["-n", "-c"], tail: ["-n", "-c"], sed: ["-e", "-f"], grep: SEARCH_OPTIONS, rg: SEARCH_OPTIONS };

// Files a shell command reads, and the line range when it reads one file with
// `sed -n 'a,bp'` or `head -n N`. Words holding `$`, globs or redirections are skipped.
export function shellReads(command: string): { paths: string[]; lines: string | null } {
  const paths: string[] = [];
  let lines: string | null = null;
  for (const line of command.split("\n")) {
    // Quoted words keep their operators; &&, ||, ; and | outside quotes end a command.
    const tokens = line.match(/'[^']*'|"(?:[^"\\]|\\.)*"|&&|\|\||[;|]|[^\s'";|&]+/g) ?? [];
    const segments: string[][] = [[]];
    for (const token of tokens) {
      if (/^(&&|\|\||[;|])$/.test(token)) segments.push([]);
      else segments.at(-1)!.push(token.replace(/^(['"])([^]*)\1$/, "$2"));
    }
    for (const words of segments) {
      const program = (words[0] ?? "").replace(/.*\//, "");
      if (!SHELL_READERS.has(program)) continue;
      const args: string[] = [];
      let expression = false;
      for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (/^\d*[<>]/.test(w)) { if (/^\d*[<>]+&?$/.test(w)) i++; continue; }
        if (VALUE_OPTIONS[program]?.includes(w)) {
          if (w === "-e") expression = true;
          if (w === "-n" && program === "head") lines = `1-${words[i + 1]}`;
          i++;
          continue;
        }
        const count = /^-n?(\d+)$/.exec(w);
        if (count && program === "head") { lines = `1-${count[1]}`; continue; }
        if (w.startsWith("-")) continue;
        args.push(w);
      }
      // sed, grep and rg take their script or pattern first unless -e gave it.
      if (["sed", "grep", "rg"].includes(program) && !expression) {
        const script = args.shift() ?? "";
        const range = /^(\d+)(?:,(\d+))?p$/.exec(script);
        if (program === "sed" && range) lines = `${range[1]}-${range[2] ?? range[1]}`;
      }
      paths.push(...args.filter((a) => a && !/[$`*?]/.test(a)));
    }
  }
  const unique = [...new Set(paths)];
  return { paths: unique, lines: unique.length === 1 ? lines : null };
}

// The range a read tool asked for, from a first line and a line count.
export function lineRange(offset: unknown, limit: unknown): string | null {
  const from = typeof offset === "number" && offset > 0 ? offset : 1;
  if (typeof limit !== "number" || limit <= 0) return typeof offset === "number" && offset > 1 ? `${from}-` : null;
  return `${from}-${from + limit - 1}`;
}

// Argument names that hold a file or folder across the harnesses' file tools.
const PATH_ARGS = ["file_path", "filePath", "path", "target_file", "target_directory", "notebook_path"];

// Argument names that hold a web call's query or URL across the harnesses' web tools.
const WEB_ARGS = ["query", "search_query", "url"];

// The action and query or URL of a call to a web tool `name`; null for other tools.
export function webUse(name: string, args: any): WebUse | null {
  const action = webAction(name);
  if (!action) return null;
  const target = args && typeof args === "object" ? WEB_ARGS.map((k) => args[k]).find((v) => typeof v === "string" && v !== "") : undefined;
  return { action, target: target ?? null };
}

// The paths and line range of one tool call, from its arguments or its shell command,
// and what it searched or opened when `name` is a web tool.
export function toolTarget(args: any, command: string | null, name: string): { paths: string[]; lines: string | null; web: WebUse | null } {
  const web = webUse(name, args);
  if (command) return { ...shellReads(command), web };
  if (!args || typeof args !== "object") return { paths: [], lines: null, web };
  const paths = PATH_ARGS.map((k) => args[k]).filter((p): p is string => typeof p === "string" && p !== "");
  if (Array.isArray(args.paths)) paths.push(...args.paths.filter((p: unknown): p is string => typeof p === "string"));
  const range = Array.isArray(args.view_range) && args.view_range.length === 2
    ? `${args.view_range[0]}-${args.view_range[1] === -1 ? "" : args.view_range[1]}`
    : lineRange(args.offset, args.limit);
  return { paths, lines: range, web };
}

// Text of a tool result: a string, or the text parts of an array.
function resultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "")).join("");
  return null;
}

export type ResultSize = { resultChars: number | null; resultLines: number | null; resultWords: number | null };

export const UNKNOWN_SIZE: ResultSize = { resultChars: null, resultLines: null, resultWords: null };

// What a loader reads beyond the session tree. Lines and words of each tool
// result cost a pass over its text, so only `workflow files` asks for them.
export type LoadOptions = { counts?: boolean };

// The characters that \s matches.
const isBlank = (c: number) => c === 32 || (c >= 9 && c <= 13) || (c >= 160 && /\s/.test(String.fromCharCode(c)));

// Where a line's text starts after a line number a read tool added, such as
// `12→`, `12<tab>` or `00012| `; `start` when the line has none.
function lineNumberEnd(text: string, start: number, stop: number): number {
  let i = start;
  while (i < stop && isBlank(text.charCodeAt(i))) i++;
  const digits = i;
  while (i < stop && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
  if (i === digits || i === stop) return start;
  const c = text.charCodeAt(i);
  if (c === 0x2192 || c === 9) return i + 1;
  if (c === 124 && i + 1 < stop && text.charCodeAt(i + 1) === 32) return i + 2;
  return start;
}

// Characters, lines and words of a tool result, in one pass over the text.
// When most lines start with a line number a read tool added, the numbers do
// not count as words.
export function textSize(text: string): ResultSize {
  if (!text) return { resultChars: 0, resultLines: 0, resultWords: 0 };
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  let lines = 0, numbered = 0, words = 0, bodyWords = 0;
  for (let start = 0; start <= end; ) {
    let stop = text.indexOf("\n", start);
    if (stop < 0 || stop > end) stop = end;
    const body = lineNumberEnd(text, start, stop);
    if (body > start) numbered++;
    let space = true, bodySpace = true;
    for (let i = start; i < stop; i++) {
      const blank = isBlank(text.charCodeAt(i));
      if (!blank && space) words++;
      space = blank;
      if (i < body) continue;
      if (!blank && bodySpace) bodyWords++;
      bodySpace = blank;
    }
    lines++;
    start = stop + 1;
  }
  return { resultChars: text.length, resultLines: lines, resultWords: numbered * 2 >= lines ? bodyWords : words };
}

// Characters of text in a tool result, without building the text.
function textChars(content: unknown): number | null {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) return content.reduce((n, b) => n + (typeof b === "string" ? b.length : typeof b?.text === "string" ? b.text.length : 0), 0);
  return null;
}

// A tool result's size; lines and words only when `counts` asks for them.
export function resultSize(content: unknown, counts = false): ResultSize {
  if (!counts) return { ...UNKNOWN_SIZE, resultChars: textChars(content) };
  const text = resultText(content);
  return text === null ? UNKNOWN_SIZE : textSize(text);
}
