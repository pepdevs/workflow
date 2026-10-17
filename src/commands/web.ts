// uc-23: web searches and page reads per harness tool, and whether agents searched again.
import { WEB_LONG_CHAIN, WEB_REPHRASE_OVERLAP, webBackend } from "../catalog.ts";
import type { Session, ToolCall, WebUse } from "../model.ts";
import { ADAPTER_OF, type Range, loadAll, parseWhen } from "./find.ts";
import { day, pct, table } from "./format.ts";

// Raise when a field changes meaning or goes away; consumers check it before reading.
export const WEB_SCHEMA = 1;

type WebCall = ToolCall & { web: WebUse };

type Placed = { session: Session; harness: string; call: WebCall; chain: number; position: number };

// Web calls in a row in one thread and turn. Any other tool call by the model ends the chain.
function chainsOf(s: Session, when: Range): WebCall[][] {
  const chains: WebCall[][] = [];
  const byThread = new Map<string, ToolCall[]>();
  for (const t of s.toolCalls) if (t.origin === "model") byThread.set(t.threadId, [...(byThread.get(t.threadId) ?? []), t]);
  for (const calls of byThread.values()) {
    const ordered = calls.map((t, i) => ({ t, i })).sort((a, b) => (a.t.startedAt ?? Infinity) - (b.t.startedAt ?? Infinity) || a.i - b.i).map((x) => x.t);
    let open: WebCall[] | null = null;
    for (const t of ordered) {
      if (!t.web) { open = null; continue; }
      if (open === null || open[0].turnId !== t.turnId) chains.push((open = []));
      open.push(t as WebCall);
    }
  }
  const inRange = (t: ToolCall) => t.startedAt !== null && t.startedAt >= when.from && t.startedAt < when.to;
  return chains.map((c) => c.filter(inRange)).filter((c) => c.length > 0);
}

const words = (text: string | null) => new Set((text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));

// Share of a search's words that an earlier search also used.
function overlap(query: string | null, previous: string | null): number {
  const a = words(query), b = words(previous);
  if (a.size === 0 || b.size === 0) return 0;
  return [...a].filter((w) => b.has(w)).length / a.size;
}

function place(loaded: Session[], when: Range): Placed[] {
  const out: Placed[] = [];
  let next = 0;
  for (const s of loaded) {
    for (const chain of chainsOf(s, when)) {
      const id = next++;
      chain.forEach((call, position) => out.push({ session: s, harness: ADAPTER_OF[s.harness], call, chain: id, position }));
    }
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const key = (p: Placed) => `${p.harness}\0${p.call.name}`;

const groupBy = <T>(items: T[], by: (t: T) => string) => {
  const out = new Map<string, T[]>();
  for (const t of items) out.set(by(t), [...(out.get(by(t)) ?? []), t]);
  return out;
};

const median = (ns: number[]) => {
  if (ns.length === 0) return null;
  const s = [...ns].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Web calls per harness tool, then the chains each search tool started: how often the
// agent searched again before acting, reworded the same search, or read pages.
export function webCommand(flags: Record<string, string>, base: string | undefined, now: number): string {
  const when: Range = parseWhen(flags.d ?? "30", now);
  const placed = place(loadAll(base, when.from), when);
  if (placed.length === 0) return "No web calls in this window.";
  const sessions = (ps: Placed[]) => new Set(ps.map((p) => `${p.harness}:${p.session.id}`)).size;
  const calls = [...groupBy(placed, key)].sort((a, b) => b[1].length - a[1].length).map(([, ps]) => {
    const n = (action: string) => String(ps.filter((p) => p.call.web.action === action).length);
    return [ps[0].harness, ps[0].call.name, webBackend(ps[0].harness, ps[0].call.name), String(sessions(ps)), String(ps.length), n("search"), n("open"), n("find"), n("other"), pct(ps.filter((p) => p.call.status === "failed").length, ps.length)];
  });

  // A chain belongs to the tool of its first search; chains without a search stay out.
  const chains = [...groupBy(placed, (p) => String(p.chain)).values()];
  const searched = chains.flatMap((c) => {
    const searches = c.filter((p) => p.call.web.action === "search");
    return searches.length ? [{ owner: key(searches[0]), first: searches[0], all: c, searches }] : [];
  });
  const chainRows = [...groupBy(searched, (c) => c.owner)].sort((a, b) => b[1].length - a[1].length).map(([, cs]) => {
    const searches = cs.flatMap((c) => c.searches);
    const later = cs.flatMap((c) => c.searches.slice(1).map((p, i) => ({ p, previous: c.searches[i], earlier: c.searches.slice(0, i + 1) })));
    // A search that started before the one before it returned ran beside it, as Claude Code batches them.
    const parallel = later.filter(({ p, previous }) => previous.call.endedAt !== null && p.call.startedAt! < previous.call.endedAt);
    const again = later.filter((x) => !parallel.includes(x));
    const reworded = again.filter(({ p, earlier }) => earlier.some((e) => overlap(p.call.web.target, e.call.web.target) >= WEB_REPHRASE_OVERLAP));
    const opens = cs.map((c) => c.all.filter((p) => p.call.web.action !== "search").length);
    return [
      cs[0].first.harness, cs[0].first.call.name, String(cs.length), String(median(cs.map((c) => c.searches.length))), pct(parallel.length, searches.length), pct(again.length, searches.length),
      pct(reworded.length, searches.length), pct(cs.filter((c) => c.searches.length >= WEB_LONG_CHAIN).length, cs.length), pct(cs.filter((_, i) => opens[i] > 0).length, cs.length),
    ];
  });
  const days = placed.map((p) => p.call.startedAt!);
  return [
    `Web calls ${day(Math.min(...days))}..${day(Math.max(...days))}: ${plural(placed.length, "call")} in ${plural(sessions(placed), "session")}`,
    "",
    table(["harness", "tool", "backend", "sessions", "calls", "search", "open", "find", "other", "failed"], calls, [3, 4, 5, 6, 7, 8, 9]),
    "",
    table(["harness", "search tool", "chains", "median searches", "parallel", "searched again", "reworded", `${WEB_LONG_CHAIN}+ searches`, "read pages"], chainRows, [2, 3, 4, 5, 6, 7, 8]),
    "",
    "A chain is the web calls in a row in one thread and turn; any other tool call ends it.",
    "Parallel: searches that started before the search before them returned. Searched again: searches after the first",
    `of their chain that started once the search before returned. Reworded: those sharing ${Math.round(WEB_REPHRASE_OVERLAP * 100)}% or more of their words with an earlier search of the chain.`,
    "Read pages: chains that opened a page or searched inside one.",
  ].join("\n");
}

// Every web call in the range with its chain, for a benchmark that replays real queries.
export function webJson(flags: Record<string, string>, base: string | undefined, now: number): string {
  const when: Range = parseWhen(flags.d ?? "30", now);
  const placed = place(loadAll(base, when.from), when).sort((a, b) => a.call.startedAt! - b.call.startedAt! || a.chain - b.chain || a.position - b.position);
  const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  return JSON.stringify({
    schema: WEB_SCHEMA,
    range: { from: iso(when.from), to: iso(when.to) },
    calls: placed.map((p) => ({
      session: `${p.harness}:${p.session.id}`,
      at: new Date(p.call.startedAt!).toISOString(),
      harness: p.harness,
      tool: p.call.name,
      backend: webBackend(p.harness, p.call.name),
      action: p.call.web.action,
      target: p.call.web.target,
      status: p.call.status,
      chain: p.chain,
      position: p.position,
    })),
  }, null, 2);
}
