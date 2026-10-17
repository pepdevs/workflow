// Facts derived from the session model: costs, times, root turns, and the launch
// header `wf run` writes into a prompt.
import { isHarnessName, type HarnessName } from "./harnesses/index.ts";
import { aggregateCostParts, commandBranches, computeCostUsd } from "./catalog.ts";
import { type ModelCall, type Session, type ToolCall, type Turn } from "./model.ts";

// List price from the catalog, or null when a model has no price. Aggregates
// price each model's calls, because a harness may report its own rate card.
export const listCost = (c: ModelCall): number | null => {
  if (c.kind !== "turn_aggregate") return computeCostUsd(c.provider, c.model, c.usage);
  const p = aggregateCostParts(c.modelUsages);
  return p && p.input + p.cacheRead + p.cacheWrite + p.output;
};

// List price, else the harness's charge. A zero charge for a call that used
// tokens is a free offer, such as an OpenRouter stealth model, and gives no price.
export const callCost = (c: ModelCall): number | null => {
  const list = listCost(c);
  if (list !== null) return list;
  const used = c.usage.input + c.usage.cacheRead + c.usage.cacheWrite + c.usage.output > 0;
  return c.reportedCostUsd === 0 && used ? null : c.reportedCostUsd;
};

export const callCount = (c: ModelCall) => c.kind === "turn_aggregate" ? c.callCount : 1;

export const modelCounts = (c: ModelCall): [string, number][] => c.kind === "turn_aggregate"
  ? c.modelUsages.map((m) => [m.model, m.callCount]) : [[c.model, 1]];

export const primaryModel = (c: ModelCall): string => [...modelCounts(c)].sort((a, b) => b[1] - a[1])[0]?.[0] ?? c.model;

export const peakContext = (calls: ModelCall[]): { tokens: number | null; estimated: boolean } => {
  const observations = calls.filter((c) => c.purpose === "turn").map((c) => ({ tokens: contextOf(c), estimated: c.kind === "turn_aggregate" }));
  const known = observations.filter((o): o is { tokens: number; estimated: boolean } => o.tokens !== null);
  if (!known.length) return { tokens: null, estimated: false };
  const peak = Math.max(...known.map((o) => o.tokens));
  return { tokens: peak, estimated: observations.some((o) => o.estimated) };
};

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export const toolMs = (t: ToolCall) => (t.startedAt !== null && t.endedAt !== null ? t.endedAt - t.startedAt : 0);

export const callMs = (c: ModelCall) => c.kind === "turn_aggregate" ? c.apiDurationMs : c.startedAt !== null ? Math.max(0, c.endedAt - c.startedAt) : 0;

// An individual call's context, or an aggregate's separate observation.
export const contextOf = (c: ModelCall): number | null => c.kind === "turn_aggregate"
  ? c.contextObservation?.tokens ?? null : c.usage.input + c.usage.cacheRead + c.usage.cacheWrite;

// Threads spawned, directly or transitively, by tool calls of a turn.
export function spawnedThreads(s: Session, turn: Turn): Set<string> {
  const out = new Set<string>();
  const queue = s.toolCalls.filter((t) => t.turnId === turn.id && t.spawnsThreadId).map((t) => t.spawnsThreadId!);
  while (queue.length) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    queue.push(...s.threads.filter((t) => t.parentId === id).map((t) => t.id));
    queue.push(...s.toolCalls.filter((t) => t.threadId === id && t.spawnsThreadId).map((t) => t.spawnsThreadId!));
  }
  return out;
}

export function turnCalls(s: Session, turn: Turn, withSubagents: boolean): ModelCall[] {
  const threads = withSubagents ? spawnedThreads(s, turn) : new Set<string>();
  return s.modelCalls.filter((c) => c.turnId === turn.id || threads.has(c.threadId));
}

// Each call in at most one root turn: of the turns whose own or spawned threads
// hold it, the latest that started by the call's start, else the first. A subagent
// resumed by a later turn then counts its later calls there.
export function rootTurnCalls(s: Session): Map<string, ModelCall[]> {
  const turns = rootTurns(s);
  const reach = turns.map((t) => new Set(turnCalls(s, t, true)));
  const out = new Map<string, ModelCall[]>(turns.map((t) => [t.id, []]));
  for (const c of s.modelCalls) {
    const at = c.startedAt ?? c.endedAt;
    const holders = turns.filter((_, i) => reach[i]!.has(c));
    const owner = holders.findLast((t) => t.startedAt <= at) ?? holders[0];
    if (owner) out.get(owner.id)!.push(c);
  }
  return out;
}

export const rootThread = (s: Session) => s.threads.find((t) => t.parentId === null)!.id;

// The branches a session's logs name, in order of first appearance: each record's
// branch where the harness logs one per record, otherwise the branch at start,
// then the branches its shell commands, subagents included, create or push. HEAD names no branch.
export function branchesOf(s: Session): string[] {
  const logged = s.branches?.length ? s.branches : s.startGit?.branch ? [s.startGit.branch] : [];
  const commands = s.toolCalls.filter((t) => t.command).flatMap((t) => commandBranches(t.command!));
  return [...new Set([...logged, ...commands])].filter((b) => b !== "HEAD");
}

export const rootTurns = (s: Session) =>
  s.turns.filter((t) => t.threadId === rootThread(s)).sort((a, b) => a.startedAt - b.startedAt);

export function countBy<T>(xs: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

// The session title, or its first prompt without the launch header and skill line.
export const titleOf = (s: Session) =>
  (s.title ?? rootTurns(s).find((t) => t.promptText)?.promptText)?.replace(LAUNCH_HEADER, "").trim().replace(SKILL_LINE, "") || "-";

// `wf run -k` puts this line after the launch header.
export const skillLine = (skill: string) => `Use the installed ${skill} skill for this task.`;
const SKILL_LINE = /^Use the installed \S+ skill for this task\.\s*/;

// `wf run` puts this header on the first line of a session's prompt, so the
// harness log records which skill the session ran for, which session launched it,
// and the plan it worked on, as <owner/repo>#<number>. Git identity names
// the committed starting tree when the launch directory provides it.
export type LaunchInfo = { skill: string | null; parent: { harness: HarnessName; id: string } | null; plan?: string | null; repo?: string; commit?: string };

const LAUNCH_HEADER = /^\[wf run skill=(\S+) parent=(\S+)(?: plan=(\S+))?(?: repo=([\w.-]+\/[\w.-]+))?(?: commit=([0-9a-f]{40}|[0-9a-f]{64}))?\]/;

export function launchHeader(l: LaunchInfo): string {
  return `[wf run skill=${l.skill ?? "-"} parent=${l.parent ? `${l.parent.harness}:${l.parent.id}` : "-"}${l.plan ? ` plan=${l.plan}` : ""}${l.repo ? ` repo=${l.repo}` : ""}${l.commit ? ` commit=${l.commit}` : ""}]`;
}

export function launchOf(s: Session): LaunchInfo | null {
  const m = LAUNCH_HEADER.exec(rootTurns(s)[0]?.promptText ?? "");
  if (!m) return null;
  const [harness, ...id] = m[2].split(":");
  return { skill: m[1] === "-" ? null : m[1], parent: isHarnessName(harness) && id.length ? { harness, id: id.join(":") } : null, ...(m[3] ? { plan: m[3] } : {}), ...(m[4] ? { repo: m[4] } : {}), ...(m[5] ? { commit: m[5] } : {}) };
}
