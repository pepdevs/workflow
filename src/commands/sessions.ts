// uc-1 to uc-5 and uc-9: find sessions, and read one at a glance, by cost, turns, tools and time.
import { ADAPTERS, HARNESS_NAMES, isHarnessName, type HarnessName } from "../harnesses/index.ts";
import { aggregateCostParts, CONTEXT_BUDGET, costParts, shellProgram } from "../catalog.ts";
import { type ModelCall, type Session, type ToolCall } from "../model.ts";
import { type Found, findSessions, parseAmount, parseWhen, shortIds } from "./find.ts";
import { clock, dur, folderName, oneLine, pct, table, thousands, tok, usd } from "./format.ts";
import { type LaunchInfo, callCost, listCost, callCount, callMs, contextOf, countBy, launchOf, modelCounts, peakContext, rootThread, rootTurns, spawnedThreads, sum, titleOf, toolMs, turnCalls } from "../facts.ts";
import { sessionProvenance } from "../repos/provenance.ts";
import { SessionSizeCall } from "../repos/session-size.ts";

const TOKEN_LABELS: Record<string, string> = { input: "uncached input", cacheRead: "cache read", cacheWrite: "cache write", output: "output" };

export function summary(s: Session, readClones = false, withSize = false): string {
  const calls = s.modelCalls;
  const missingGrokUsage = s.harness === "grok" && calls.length === 0;
  const turnCallsOnly = calls.filter((c) => c.purpose === "turn");
  const measuredCalls = calls.filter((c) => !c.compaction?.estimated);
  const compactionCalls = calls.filter((c) => c.compaction);
  const u = measuredCalls.reduce(
    (a, c) => ({
      input: a.input + c.usage.input,
      cacheRead: a.cacheRead + c.usage.cacheRead,
      cacheWrite: a.cacheWrite + c.usage.cacheWrite,
      cacheWrite1h: a.cacheWrite1h + c.usage.cacheWrite1h,
      output: a.output + c.usage.output,
      reasoning: a.reasoning + c.usage.reasoning,
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 },
  );
  const computed = calls.map(listCost);
  const unpriced = computed.filter((c) => c === null).length;
  const totalIn = u.input + u.cacheRead + u.cacheWrite;
  const turns = rootTurns(s);
  const wall = sum(turns.map((t) => (t.endedAt ?? t.startedAt) - t.startedAt));
  const modelTotals = new Map<string, number>();
  for (const c of calls) for (const [m, n] of modelCounts(c)) modelTotals.set(m, (modelTotals.get(m) ?? 0) + n);
  const models = [...modelTotals].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} (${n})`).join(", ");
  const skills = countBy(s.skills, (k) => `${k.skill} [${k.mechanism}]`).map(([k, n]) => `${k} ×${n}`).join(", ");
  const incidents = countBy(s.incidents, (i) => i.kind).map(([k, n]) => `${k} ×${n}`).join(", ");
  const failed = s.toolCalls.filter((t) => t.status === "failed").length;
  const peak = (xs: ModelCall[]) => peakContext(xs);
  const peakText = (xs: ModelCall[]) => {
    const p = peak(xs);
    if (p.tokens === null) return "unknown";
    const observed = xs.find((c) => c.kind === "turn_aggregate" && c.contextObservation?.tokens === p.tokens);
    return `${tok(p.tokens)}${p.estimated ? ` est.${observed?.kind === "turn_aggregate" && observed.contextObservation ? ` at ${new Date(observed.contextObservation.at).toISOString().slice(0, 16)}` : ""}` : ""}`;
  };
  const root = rootThread(s);
  const over = turnCallsOnly.filter((c) => c.kind !== "turn_aggregate" && (contextOf(c) ?? 0) > CONTEXT_BUDGET);
  const overCost = sum(over.map((c) => callCost(c) ?? 0));
  const hasAggregate = calls.some((c) => c.kind === "turn_aggregate");
  const overText = hasAggregate ? `budget classification unknown for ${sum(turnCallsOnly.map(callCount))} calls` : `${over.length} of ${turnCallsOnly.length} calls above ${tok(CONTEXT_BUDGET)}, costing ${usd(overCost)} (${pct(overCost, sum(measuredCalls.map((c) => callCost(c) ?? 0)))})`;
  const compactions = calls.length - turnCallsOnly.length + s.compactions.length;
  const estimated = sum(compactionCalls.filter((c) => c.compaction?.estimated).map((c) => callCost(c) ?? 0));
  const size = withSize ? new SessionSizeCall().measure(s, readClones) : null;
  const provenance = size?.provenance ?? sessionProvenance(s, readClones);
  const compactionText = [...compactionCalls.map((c) => {
    const info = c.compaction!;
    const cost = callCost(c);
    return `${info.trigger} ${info.preTokens.toLocaleString("en-US")} → ${info.postTokens.toLocaleString("en-US")} tokens · ${cost === null ? "unpriced" : `${usd(cost)} est.`}`;
  }), ...s.compactions.map((c) => `${c.trigger} ${c.preTokens.toLocaleString("en-US")} → ${c.postTokens.toLocaleString("en-US")} tokens · charge unreported`)].join("; ");
  const rows: [string, string][] = [
    ["Session", `${s.harness} ${s.id}`],
    ["Title", s.title ?? "-"],
    ["Directory", s.cwd ?? "-"],
    ["Repository", provenance.repository],
    ["Start commit", provenance.commit],
    ...(size ? [["Code and docs", size.tokens === null ? "unknown" : `${thousands(size.tokens)} tokens${provenance.estimated ? " est." : ""}`] as [string, string]] : []),
    ["Version", s.harnessVersion ?? "-"],
    ["Launched", launchText(launchOf(s))],
    ...(s.result ? [["Result", `${s.result.status}${s.result.pullRequest ? ` · ${s.result.pullRequest} · ${s.result.headSha}` : " · no PR"}`] as [string, string]] : []),
    ["Threads", `${s.threads.length} (1 root, ${s.threads.length - 1} subagents)`],
    ["Turns", `${turns.length} in the root thread, ${s.turns.length - turns.length} in subagents`],
    ["Model calls", `${sum(calls.map(callCount))}`],
    ["Tool calls", `${s.toolCalls.length}, ${failed} failed`],
    ["Models", models || "-"],
    ["Tokens", missingGrokUsage ? "unknown" : `input ${tok(u.input)} · cache read ${tok(u.cacheRead)} (${pct(u.cacheRead, totalIn)} of input) · cache write ${tok(u.cacheWrite)} (1h ${tok(u.cacheWrite1h)}) · output ${tok(u.output)} (reasoning ${tok(u.reasoning)})`],
    ["Context", `peak ${peakText(turnCallsOnly.filter((c) => c.threadId === root))} in the root thread${s.threads.length > 1 ? `, ${peakText(turnCallsOnly.filter((c) => c.threadId !== root))} in subagents` : ""} · ${missingGrokUsage ? "budget classification unknown" : overText} · ${compactions} compactions`],
    ...(compactionText ? [["Compactions", compactionText] as [string, string]] : []),
    ["Cost", missingGrokUsage ? "unknown · reported by harness unknown" : `computed ${usd(sum(computed.map((c) => c ?? 0)))}${hasAggregate ? " est." : ""}${compactionCalls.some((c) => c.compaction?.estimated) ? ` (includes ${usd(estimated)} est. compactions)` : ""} · reported by harness ${usd(s.reportedCostUsd)} · ${unpriced} of ${calls.length} calls unpriced`],
    ["Turn time", s.harness === "grok" && turns.length === 0 ? "unknown wall in root turns; model time unknown" : `${dur(wall)} wall in root turns; across all threads: model ${calls.length ? dur(sum(calls.map(callMs))) : "unknown"}, tools ${dur(sum(s.toolCalls.filter((t) => t.category !== "user_interaction" && t.category !== "agent").map(toolMs)))}, waiting on subagents ${dur(sum(s.toolCalls.filter((t) => t.category === "agent").map(toolMs)))}, waiting on user ${dur(sum(s.toolCalls.filter((t) => t.category === "user_interaction").map(toolMs)))}`],
    ["Skills", skills || "-"],
    ["Incidents", incidents || "-"],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join("\n");
}

const launchText = (l: LaunchInfo | null) =>
  l ? `by wf run${l.skill ? `, skill ${l.skill}` : ""}${l.parent ? `, from ${l.parent.harness} ${l.parent.id}` : ""}${l.plan ? `, plan ${l.plan}` : ""}` : "-";

export function turnsCommand(s: Session): string {
  if (s.harness === "grok" && rootTurns(s).length === 0) return "Turns unknown: no turn timing recorded.";
  const rows = rootTurns(s).map((t, i) => {
    const own = turnCalls(s, t, false);
    const all = turnCalls(s, t, true);
    const tools = s.toolCalls.filter((x) => x.turnId === t.id);
    const skills = [...new Set(s.skills.filter((k) => k.turnId === t.id).map((k) => k.skill))].join(",");
    const models = [...new Set(own.flatMap((c) => modelCounts(c).map(([m]) => m)))].join(",");
    return [
      String(i + 1),
      clock(t.startedAt),
      t.trigger,
      oneLine(t.promptText, 42),
      models,
      String(sum(own.map(callCount))),
      String(tools.length),
      String(spawnedThreads(s, t).size),
      s.harness === "grok" && own.length === 0 ? "unknown" : usd(sum(own.map((c) => callCost(c) ?? 0))),
      s.harness === "grok" && all.length === 0 ? "unknown" : usd(sum(all.map((c) => callCost(c) ?? 0))),
      s.harness === "grok" && t.endedAt === null ? "unknown" : dur((t.endedAt ?? t.startedAt) - t.startedAt),
      t.outcome,
      skills,
    ];
  });
  return table(
    ["#", "start", "trigger", "prompt", "models", "calls", "tools", "subagents", "cost", "+subagents", "wall", "outcome", "skills"],
    rows,
    [0, 5, 6, 7, 8, 9, 10],
  );
}

export function costCommand(s: Session): string {
  if (s.harness === "grok" && s.modelCalls.length === 0) return "Cost unknown: no turn usage recorded.";
  let running = 0;
  const timeline = rootTurns(s).map((t, i) => {
    const calls = turnCalls(s, t, true);
    const c = sum(calls.map((x) => callCost(x) ?? 0));
    running += c;
    const u = (k: keyof ModelCall["usage"]) => sum(calls.map((x) => x.usage[k]));
    return [String(i + 1), clock(t.startedAt), String(sum(calls.map(callCount))), tok(u("input")), tok(u("cacheRead")), tok(u("cacheWrite")), tok(u("output")), tok(u("reasoning")), usd(c), usd(running)];
  });
  const total = sum(s.modelCalls.map((c) => callCost(c) ?? 0));
  const group = (key: (c: ModelCall) => string) => {
    const m = new Map<string, number>();
    for (const c of s.modelCalls) m.set(key(c), (m.get(key(c)) ?? 0) + (callCost(c) ?? 0));
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, usd(v), pct(v, total)]);
  };
  const threadName = (id: string) => {
    const t = s.threads.find((x) => x.id === id)!;
    return t.parentId === null ? "root" : oneLine(t.name ?? id, 40);
  };
  // Token cost components across the whole session.
  const parts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let aggregateCost = 0;
  const hasAggregate = s.modelCalls.some((c) => c.kind === "turn_aggregate");
  for (const c of s.modelCalls) {
    const p = c.kind === "turn_aggregate" ? aggregateCostParts(c.modelUsages) : costParts(c.provider, c.model, c.usage);
    if (!p) { if (c.kind === "turn_aggregate") aggregateCost += c.reportedCostUsd; continue; }
    for (const k of Object.keys(parts) as (keyof typeof parts)[]) parts[k] += p[k];
  }
  const top = [...s.modelCalls]
    .sort((a, b) => (callCost(b) ?? 0) - (callCost(a) ?? 0))
    .slice(0, 5)
    .map((c) => [clock(c.endedAt), threadName(c.threadId), c.kind === "turn_aggregate" ? c.modelUsages.map((m) => m.model).join(",") : c.model, c.kind === "turn_aggregate" ? (contextOf(c) === null ? "unknown" : `${tok(contextOf(c)!)} est.`) : tok(contextOf(c)!), tok(c.usage.output), `${usd(callCost(c))}${c.compaction?.estimated ? " est." : ""}`]);
  return [
    "Cost by root turn (subagent calls included in the turn that spawned them)",
    "",
    table(["#", "start", "calls", "input", "cache read", "cache write", "output", "reasoning", "turn cost", "running total"], timeline, [0, 2, 3, 4, 5, 6, 7, 8, 9]),
    "",
    "Where the money went",
    "",
    table(["token type", "cost", "share"], [...Object.entries(parts).map(([k, v]) => [TOKEN_LABELS[k], usd(v), pct(v, sum(Object.values(parts)) + aggregateCost)]), ...(aggregateCost > 0 ? [["reported aggregate", usd(aggregateCost), pct(aggregateCost, sum(Object.values(parts)) + aggregateCost)]] : [])], [1, 2]),
    "",
    table(["model", "cost", "share"], group((c) => c.kind === "turn_aggregate" && c.modelUsages.length > 1 ? "mixed models" : c.model), [1, 2]),
    "",
    table(["thread", "cost", "share"], group((c) => threadName(c.threadId)), [1, 2]),
    "",
    hasAggregate ? "Most expensive calls and turn aggregates" : "Most expensive calls",
    "",
    table(["at", "thread", "model", "context", "output", "cost"], top, [3, 4, 5]),
  ].join("\n");
}

export function toolsCommand(s: Session): string {
  const byCategory = new Map<string, ToolCall[]>();
  for (const t of s.toolCalls) {
    const key = t.shellCategory ? `${t.category}/${t.shellCategory}` : t.category;
    byCategory.set(key, [...(byCategory.get(key) ?? []), t]);
  }
  const rows = [...byCategory]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, ts]) => [k, String(ts.length), pct(ts.length, s.toolCalls.length), String(ts.filter((t) => t.status === "failed").length), dur(sum(ts.map(toolMs))), [...new Set(ts.map((t) => t.name))].join(",")]);
  const programs = countBy(s.toolCalls.filter((t) => t.command), (t) => shellProgram(t.command!)).slice(0, 10);
  const failures = countBy(s.toolCalls.filter((t) => t.status === "failed" && t.command), (t) => shellProgram(t.command!)).slice(0, 5);
  return [
    table(["category", "calls", "share", "failed", "time", "tool names"], rows, [1, 2, 3, 4]),
    "",
    `Top shell programs: ${programs.map(([p, n]) => `${p} ${n}`).join(", ") || "-"}`,
    `Failing shell programs: ${failures.map(([p, n]) => `${p} ${n}`).join(", ") || "-"}`,
  ].join("\n");
}

export function timeCommand(s: Session): string {
  if (s.harness === "grok" && rootTurns(s).length === 0) return "Time unknown: no turn timing recorded.";
  const rows = rootTurns(s).map((t, i) => {
    const wall = (t.endedAt ?? t.startedAt) - t.startedAt;
    const calls = s.modelCalls.filter((c) => c.turnId === t.id);
    const tools = s.toolCalls.filter((x) => x.turnId === t.id);
    const model = Math.min(wall, sum(calls.map(callMs)));
    const tool = sum(tools.map(toolMs));
    const waiting = sum(tools.filter((x) => x.category === "user_interaction").map(toolMs));
    const sub = sum(tools.filter((x) => x.category === "agent").map(toolMs));
    const missingGrokTime = s.harness === "grok" && t.endedAt === null;
    return [String(i + 1), clock(t.startedAt), missingGrokTime ? "unknown" : dur(wall), s.harness === "grok" && calls.length === 0 ? "unknown" : dur(model), s.harness === "grok" && calls.length === 0 ? "unknown" : pct(model, wall), dur(tool - waiting - sub), dur(sub), dur(waiting), calls.some((c) => c.kind === "turn_aggregate") ? "API duration" : calls.some((c) => c.startInferred) ? "inferred" : s.harness === "grok" ? "unknown" : "recorded"];
  });
  const gaps = rootTurns(s)
    .slice(1)
    .map((t, i) => t.startedAt - (rootTurns(s)[i].endedAt ?? rootTurns(s)[i].startedAt))
    .filter((g) => g > 0);
  return [
    table(["#", "start", "wall", "model", "model share", "tools", "agent tools", "waiting on user", "call start"], rows, [0, 2, 3, 4, 5, 6, 7]),
    "",
    `Time between turns (the person's time): total ${dur(sum(gaps))}, longest ${dur(Math.max(0, ...gaps))}`,
  ].join("\n");
}

type Listed = { found: Found; s: Session; start: number; end: number; cost: number; wall: number };

export function lsCommand(words: string[], flags: Record<string, string>, base: string | undefined, now: number, withSize = false): string {
  const harnesses = words.length ? words : HARNESS_NAMES;
  for (const h of harnesses) if (!isHarnessName(h)) throw new Error(`unknown harness ${h}: use ${HARNESS_NAMES.join(", ")}`);
  const sort = flags.s ?? "new";
  if (!["new", "cost", "time", "turns"].includes(sort)) throw new Error(`bad sort ${sort}: use new, cost, time or turns`);
  const limit = Number(flags.n ?? 20);
  // Filters that need every session loaded look at the last 30 days unless -d says otherwise.
  const needsAll = flags.m !== undefined || flags.c !== undefined || flags.p !== undefined || flags.k !== undefined || sort !== "new";
  const when = flags.d !== undefined ? parseWhen(flags.d, now) : needsAll ? parseWhen("30", now) : { from: -Infinity, to: Infinity };
  const cost = flags.c !== undefined ? parseAmount(flags.c) : null;
  const all = findSessions(base, harnesses as HarnessName[]);
  const short = shortIds(findSessions(base).map((f) => f.id));
  const rows: Listed[] = [];
  // Sessions that launched another loaded session, as <harness>:<id>.
  const launchers = new Set<string>();
  // A log last written before the window holds no activity inside it.
  for (const found of all.filter((f) => f.updatedAt >= when.from).sort((a, b) => b.updatedAt - a.updatedAt)) {
    let s: Session;
    try {
      s = ADAPTERS[found.harness].load(found.ref, found.roots);
    } catch {
      continue;
    }
    const parent = launchOf(s)?.parent;
    if (parent) launchers.add(`${parent.harness}:${parent.id}`);
    const turns = rootTurns(s);
    const times = [...turns.flatMap((t) => [t.startedAt, t.endedAt ?? t.startedAt]), ...s.modelCalls.map((c) => c.endedAt)];
    if (times.length === 0) continue;
    const [start, end] = [Math.min(...times), Math.max(...times)];
    const total = sum(s.modelCalls.map((c) => callCost(c) ?? 0));
    if (end < when.from || start >= when.to) continue;
    if (flags.m && !s.modelCalls.some((c) => modelCounts(c).some(([m]) => m.includes(flags.m)))) continue;
    if (flags.p && !(s.cwd ?? "").includes(flags.p)) continue;
    if (cost && (total < cost.from || total > cost.to)) continue;
    rows.push({ found, s, start, end, cost: total, wall: sum(turns.map((t) => (t.endedAt ?? t.startedAt) - t.startedAt)) });
    if (sort === "new" && rows.length >= limit * 2) break;
  }
  // The skill wf run launched a session for, or orchestrator when it launched others.
  const role = (r: Listed) => launchOf(r.s)?.skill ?? (launchers.has(`${r.found.harness}:${r.s.id}`) ? "orchestrator" : "-");
  if (flags.k) rows.splice(0, rows.length, ...rows.filter((r) => role(r) === flags.k));
  const key: Record<string, (r: Listed) => number> = { new: (r) => r.start, cost: (r) => r.cost, time: (r) => r.wall, turns: (r) => rootTurns(r.s).length };
  const shown = rows.sort((a, b) => key[sort](b) - key[sort](a)).slice(0, limit);
  const sizeCall = withSize ? new SessionSizeCall() : null;
  sizeCall?.prepare(shown.map((row) => row.s), base === undefined);
  const out = shown.map((r) => {
    const { found, s, start, cost, wall } = r;
    const models = [...new Set(s.modelCalls.flatMap((c) => modelCounts(c).map(([m]) => m)))];
    const size = sizeCall?.measure(s, base === undefined);
    const sizeText = size ? size.tokens === null ? "unknown" : `${thousands(size.tokens)}${size.provenance.estimated ? " est." : ""}` : null;
    return [
      new Date(start).toISOString().slice(5, 16).replace("T", " "),
      found.harness,
      short.get(found.id) ?? found.id,
      role(r),
      oneLine(folderName(s.cwd), 20),
      oneLine(titleOf(s), 36),
      oneLine(models.join(",") || "-", 28),
      String(rootTurns(s).length),
      usd(cost),
      dur(wall),
      ...(sizeText === null ? [] : [sizeText]),
    ];
  });
  return [
    table(["start (UTC)", "harness", "id", "role", "directory", "title or first prompt", "models", "turns", "cost", "wall", ...(withSize ? ["code and docs tokens"] : [])], out, [7, 8, 9, ...(withSize ? [10] : [])]),
    `${shown.length} of ${rows.length}${sort === "new" && rows.length >= limit * 2 ? "+" : ""} matching sessions. Pass an id to summary, turns, cost, tools, time or files.`,
  ].join("\n");
}
