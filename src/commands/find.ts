// Finding and loading sessions: id prefixes, time windows and amounts.
import { ADAPTERS, HARNESS_NAMES, findClaudeJobs, type HarnessName, type SessionRef } from "../harnesses/index.ts";
import { type Session } from "../model.ts";

export const DAY = 86_400_000;

export type Range = { from: number; to: number };

// A time window from `-d`: N days or N hours back from now, a UTC day
// (YYYY-MM-DD, or MM-DD in the current year), or `a..b` with either end open.
export function parseWhen(text: string, now: number): Range {
  const back = /^(\d+(?:\.\d+)?)(h?)$/.exec(text);
  if (back) return { from: now - Number(back[1]) * (back[2] ? DAY / 24 : DAY), to: Infinity };
  const day = (t: string) => {
    const full = /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : /^\d{2}-\d{2}$/.test(t) ? `${new Date(now).getUTCFullYear()}-${t}` : null;
    const ms = full === null ? NaN : Date.parse(`${full}T00:00Z`);
    if (Number.isNaN(ms)) throw new Error(`bad date ${t}: use N, Nh, YYYY-MM-DD, MM-DD, YYYY-MM-DDTHH:MM or a..b`);
    return ms;
  };
  // A bound with a time of day, such as a weekly reset, is that moment.
  const at = (t: string, end: boolean) => (t.includes("T") ? parseAt(t) : day(t) + (end ? DAY : 0));
  const [a, b] = text.includes("..") ? text.split("..") : [text, text];
  return { from: a ? at(a, false) : -Infinity, to: b ? at(b, true) : Infinity };
}

// A moment: YYYY-MM-DDTHH:MM in UTC, or with a Z or ±HH:MM offset.
export function parseAt(text: string): number {
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  if (Number.isNaN(ms)) throw new Error(`bad time ${text}: use YYYY-MM-DDTHH:MM (UTC) or add an offset such as +02:00`);
  return ms;
}

// A USD range from `-c`: a minimum, or `a..b` with either end open.
export function parseAmount(text: string): Range {
  const [a, b] = text.includes("..") ? text.split("..") : [text, ""];
  const num = (t: string, open: number) => {
    if (!t) return open;
    if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`bad amount ${t}: use N, a..b, ..b or a..`);
    return Number(t);
  };
  return { from: num(a, -Infinity), to: num(b, Infinity) };
}

export type Found = SessionRef & { harness: HarnessName; roots: string[] | undefined };

const harnessRoots = (base: string | undefined, harness: string) => (base === undefined ? undefined : [`${base}/${harness}`]);

// Root sessions of the given harnesses, without parsing them.
export function findSessions(base: string | undefined, harnesses: readonly HarnessName[] = HARNESS_NAMES): Found[] {
  return harnesses.flatMap((harness) => {
    const roots = harnessRoots(base, harness);
    return ADAPTERS[harness].list(roots).map((r) => ({ ...r, harness, roots }));
  });
}

// The session whose id starts with `prefix`, in any harness.
export function findByPrefix(prefix: string, base: string | undefined): Found {
  const sessions = findSessions(base);
  const hits = sessions.filter((f) => f.id.startsWith(prefix));
  const jobs = findClaudeJobs(prefix, base === undefined ? undefined : [`${base}/claude`]);
  if (jobs.length > 1) throw new Error(`${prefix} matches ${jobs.length} Claude Code jobs`);
  if (jobs.length === 1) {
    const transcript = sessions.find((f) => f.harness === "claude" && f.id === jobs[0]);
    if (!transcript) throw new Error(`Claude Code job ${prefix} transcript ${jobs[0]} is missing`);
    return transcript;
  }
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new Error(`no session id starts with ${prefix}`);
  throw new Error(`${prefix} matches ${hits.length} sessions: ${hits.slice(0, 5).map((f) => `${f.harness} ${f.id}`).join(", ")}`);
}

// Shortest prefix of at least 8 characters that no other id shares.
export function shortIds(ids: string[]): Map<string, string> {
  const sorted = [...new Set(ids)].sort();
  const common = (a = "", b = "") => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i;
  };
  return new Map(sorted.map((id, i) => [id, id.slice(0, Math.max(8, common(id, sorted[i - 1]) + 1, common(id, sorted[i + 1]) + 1))]));
}

export const ADAPTER_OF: Record<Session["harness"], HarnessName> = { codex: "codex", "claude-code": "claude", pi: "pi", opencode: "opencode", grok: "grok", copilot: "copilot" };

// Every root session of every harness. `base` holds one directory per harness,
// in the archive's layout, and replaces the default roots.
// Sessions whose log was last written before `since` are skipped.
export function loadAll(base: string | undefined, since = -Infinity): Session[] {
  const out: Session[] = [];
  for (const f of findSessions(base).filter((x) => x.updatedAt >= since)) {
    try {
      out.push(ADAPTERS[f.harness].load(f.ref, f.roots));
    } catch {}
  }
  return out;
}
