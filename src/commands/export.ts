// uc-20: agent sessions per day as JSON, for tools such as Career that keep the evidence.
// uc-21: the prompts of those sessions as JSON, for Overview.
import { type Session, type Turn, UNNAMED_MODELS } from "../model.ts";
import { branchesOf, callCost, launchOf, modelCounts, primaryModel, rootThread, rootTurnCalls, rootTurns, sum, turnCalls } from "../facts.ts";
import { ProvenanceCall } from "../repos/provenance.ts";
import { ADAPTER_OF, type Range, loadAll, parseWhen } from "./find.ts";
import { day } from "./format.ts";
import { toolFlagHistory } from "./status.ts";

// Raise when a field changes meaning or goes away; consumers check it before reading.
export const EXPORT_SCHEMA = 2;
export const PROMPTS_SCHEMA = 1;

type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number };

export type ExportRow = {
  day: string;
  harness: string;
  model: string | null;
  skill: string | null;
  repository: string | null;
  sessions: number;
  tokens: Tokens;
  // null when a call in the row has no price, such as a free stealth model.
  costUsd: number | null;
  wallSeconds: number;
};

// A placeholder name stands for no model; its tokens and cost still count, under null.
const named = (model: string | null) => (model === null || UNNAMED_MODELS.has(model) ? null : model);

const top = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

// The model with most turn calls in the root thread, or in any thread when the root has none.
// A session with no calls, such as a Grok Build turn that never logged usage, takes the
// model its root turns name, as wf status does.
function mainModel(s: Session): string | null {
  const root = rootThread(s);
  const count = (inRoot: boolean) => {
    const counts = new Map<string, number>();
    for (const c of s.modelCalls.filter((c) => c.purpose === "turn" && (!inRoot || c.threadId === root))) {
      for (const [model, n] of modelCounts(c)) if (named(model)) counts.set(model, (counts.get(model) ?? 0) + n);
    }
    return top(counts);
  };
  return count(true) ?? count(false) ?? named(rootTurns(s).findLast((t) => named(t.model ?? null))?.model ?? null);
}

const startOf = (s: Session) => {
  const times = [...rootTurns(s).map((t) => t.startedAt), ...s.modelCalls.map((c) => c.startedAt ?? c.endedAt)];
  return times.length ? Math.min(...times) : null;
};

const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Sessions grouped by the UTC day they started, harness, model, skill and repository.
// A session counts once, with its wall time, under its main model; tokens and cost
// go to the model of each call, so subagents on another model get their own row.
export function exportCommand(flags: Record<string, string>, base: string | undefined, now: number): string {
  const when: Range = parseWhen(flags.d ?? "30", now);
  const loaded = loadAll(base, when.from);
  const launchers = new Set(loaded.map((s) => launchOf(s)?.parent).filter((p) => p != null).map((p) => `${p!.harness}:${p!.id}`));
  const provenance = new ProvenanceCall();
  const rows = new Map<string, ExportRow>();
  const rowFor = (d: string, harness: string, model: string | null, skill: string | null, repository: string | null) => {
    const key = JSON.stringify([d, harness, model, skill, repository]);
    if (!rows.has(key)) rows.set(key, { day: d, harness, model, skill, repository, sessions: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsd: 0, wallSeconds: 0 });
    return rows.get(key)!;
  };
  for (const s of loaded) {
    const start = startOf(s);
    if (start === null || start < when.from || start >= when.to) continue;
    const harness = ADAPTER_OF[s.harness];
    const skill = launchOf(s)?.skill ?? (launchers.has(`${harness}:${s.id}`) ? "orchestrator" : null);
    const repository = provenance.repositoryName(s, base === undefined, start);
    const d = day(start);
    const main = rowFor(d, harness, mainModel(s), skill, repository);
    main.sessions += 1;
    main.wallSeconds += sum(rootTurns(s).map((t) => (t.endedAt ?? t.startedAt) - t.startedAt)) / 1000;
    for (const c of s.modelCalls) {
      const row = rowFor(d, harness, named(primaryModel(c)), skill, repository);
      const cost = callCost(c);
      row.costUsd = cost === null || row.costUsd === null ? null : row.costUsd + cost;
      // Estimated compaction tokens stay out of measured totals, as in wf summary.
      if (c.compaction?.estimated) continue;
      for (const k of Object.keys(row.tokens) as (keyof Tokens)[]) row.tokens[k] += c.usage[k];
    }
  }
  const order = (r: ExportRow) => [r.day, r.harness, r.model ?? "", r.skill ?? "", r.repository ?? ""].join("\0");
  // A call model with no tokens and no cost, such as a log's placeholder, adds nothing.
  const out = [...rows.values()]
    .filter((r) => r.sessions > 0 || r.costUsd !== 0 || sum(Object.values(r.tokens)) > 0)
    .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))
    .map((r) => ({ ...r, costUsd: r.costUsd === null ? null : round(r.costUsd), wallSeconds: Math.round(r.wallSeconds) }));
  const totals = {
    sessions: sum(out.map((r) => r.sessions)),
    tokens: Object.fromEntries((["input", "cacheRead", "cacheWrite", "output"] as const).map((k) => [k, sum(out.map((r) => r.tokens[k]))])),
    // Rows without a price add nothing; unpricedRows counts them.
    costUsd: round(sum(out.map((r) => r.costUsd ?? 0))),
    unpricedRows: out.filter((r) => r.costUsd === null).length,
    wallSeconds: sum(out.map((r) => r.wallSeconds)),
  };
  return JSON.stringify({ schema: EXPORT_SCHEMA, range: { from: iso(when.from), to: iso(when.to) }, rows: out, totals }, null, 2);
}

// Hundredths of a cent, so sums carry no floating point noise.
const round = (usd: number) => Math.round(usd * 1e4) / 1e4;

export type PromptRow = {
  turn: string;
  at: string;
  model: string | null;
  outcome: Turn["outcome"];
  // When the turn ended; null while it is open.
  endedAt: string | null;
  // The priced calls of the turn and the subagents it spawned; null when the
  // harness logged no usage for the turn.
  costUsd: number | null;
  unpricedCalls: number;
  // The turn carries the wf run launch header: an agent wrote it.
  launch: boolean;
  text: string | null;
};

export type PromptSession = {
  session: string;
  day: string;
  startedAt: string;
  parent: string | null;
  harness: string;
  repository: string | null;
  skill: string | null;
  model: string | null;
  // The priced calls; unpricedCalls counts the others, as unpricedRows in wf export.
  costUsd: number;
  unpricedCalls: number;
  // The branches its logs name, in order of first appearance.
  branches: string[];
  // The first time each repeated-command and failed-tool flag of wf status fired.
  flags: { kind: string; at: string; detail: string }[];
  prompts: PromptRow[];
};

// Harnesses that log usage apart from turns, so a turn without calls has unknown cost.
const USAGE_APART: ReadonlySet<Session["harness"]> = new Set(["grok", "copilot"]);

// The model with most calls in the turn's own thread, or the model the turn names.
function turnModel(s: Session, t: Turn): string | null {
  const counts = new Map<string, number>();
  for (const c of turnCalls(s, t, false)) for (const [model, n] of modelCounts(c)) if (named(model)) counts.set(model, (counts.get(model) ?? 0) + n);
  return top(counts) ?? named(t.model ?? null);
}

// The cost of the priced calls, and the count of the others.
const costOf = (calls: Session["modelCalls"]) => {
  const costs = calls.map(callCost);
  return { costUsd: round(sum(costs.filter((c) => c !== null))), unpricedCalls: costs.filter((c) => c === null).length };
};

// The sessions active in the range, each whole: started in it, or a root turn
// started in it. Prompts are root turns with trigger prompt, in turn order.
export function promptsCommand(flags: Record<string, string>, base: string | undefined, now: number): string {
  const when: Range = parseWhen(flags.d ?? "30", now);
  const loaded = loadAll(base, when.from);
  const launchers = new Set(loaded.map((s) => launchOf(s)?.parent).filter((p) => p != null).map((p) => `${p!.harness}:${p!.id}`));
  const provenance = new ProvenanceCall();
  const inRange = (ms: number) => ms >= when.from && ms < when.to;
  const sessions: PromptSession[] = [];
  for (const s of loaded) {
    const start = startOf(s);
    const turns = rootTurns(s);
    if (start === null || !(inRange(start) || turns.some((t) => inRange(t.startedAt)))) continue;
    const harness = ADAPTER_OF[s.harness];
    const launch = launchOf(s);
    const session = `${harness}:${s.id}`;
    const owned = rootTurnCalls(s);
    sessions.push({
      session,
      day: day(start),
      startedAt: new Date(start).toISOString(),
      parent: launch?.parent ? `${launch.parent.harness}:${launch.parent.id}` : null,
      harness,
      repository: provenance.repositoryName(s, base === undefined, start),
      skill: launch?.skill ?? (launchers.has(session) ? "orchestrator" : null),
      model: mainModel(s),
      ...costOf(s.modelCalls),
      branches: branchesOf(s),
      flags: toolFlagHistory(s).map((f) => ({ kind: f.kind, at: new Date(f.at).toISOString(), detail: f.detail })),
      prompts: turns.flatMap((t, i) => {
        if (t.trigger !== "prompt") return [];
        const calls = owned.get(t.id)!;
        return [{
          turn: t.id,
          at: new Date(t.startedAt).toISOString(),
          model: turnModel(s, t),
          outcome: t.outcome,
          endedAt: t.endedAt === null ? null : new Date(t.endedAt).toISOString(),
          ...(calls.length === 0 && USAGE_APART.has(s.harness) ? { costUsd: null, unpricedCalls: 0 } : costOf(calls)),
          launch: i === 0 && launch !== null,
          text: t.promptText,
        }];
      }),
    });
  }
  sessions.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.session < b.session ? -1 : 1));
  return JSON.stringify({ schema: PROMPTS_SCHEMA, range: { from: iso(when.from), to: iso(when.to) }, sessions }, null, 2);
}
