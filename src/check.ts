// Loads every root session of each harness through the adapters and counts
// where the model's assumptions break.
// Usage: node src/check.ts [codex|claude|pi|opencode|grok|copilot ...] [--root <path>]...
import { ADAPTERS, HARNESS_NAMES, isHarnessName, type HarnessName } from "./harnesses/index.ts";
import { launchOf, callCount, listCost } from "./facts.ts";
import type { ModelCall, Session } from "./model.ts";
import { SessionSizeCall } from "./repos/session-size.ts";

export function checkMeasurement(c: ModelCall): string[] {
  if (c.kind !== "turn_aggregate") return [];
  const issues: string[] = [];
  if (c.callCount < 1 || c.callCount !== c.modelUsages.reduce((n, m) => n + m.callCount, 0)) issues.push("aggregate call count mismatch");
  if (c.modelUsages.length === 0 || c.modelUsages.some((m) => m.callCount < 1) || c.apiDurationMs < 0 || !Number.isFinite(c.apiDurationMs) || c.reportedCostUsd < 0 || !Number.isFinite(c.reportedCostUsd)) issues.push("invalid turn aggregates");
  if (c.contextObservation && (c.contextObservation.tokens < 0 || !Number.isFinite(c.contextObservation.tokens) || !Number.isFinite(c.contextObservation.at))) issues.push("invalid context observations");
  if (Object.keys(c.usage).some((key) => c.usage[key as keyof typeof c.usage] !== c.modelUsages.reduce((n, m) => n + m.usage[key as keyof typeof c.usage], 0))) issues.push("aggregate usage mismatch");
  return issues;
}

type Counts = Record<string, number>;

export type CheckResult = { counts: Counts; errors: Map<string, number>; examples: Map<string, string>; seconds: number };

export function checkHarness(harness: HarnessName, roots?: string[]): CheckResult {
  const started = Date.now();
  const adapter = ADAPTERS[harness];
  const counts: Counts = { "implement sessions with result link": 0, "implement sessions without result link": 0 };
  const add = (key: string, n = 1) => (counts[key] = (counts[key] ?? 0) + n);
  const errors = new Map<string, number>();
  const examples = new Map<string, string>();
  const sizes = new SessionSizeCall();
  const loaded: { id: string; session: Session }[] = [];
  let logMs = 0;
  let gitMs = 0;
  let tokenMs = 0;
  const note = (key: string, id: string) => {
    add(key);
    if (!examples.has(key)) examples.set(key, id);
  };

  for (const { ref: id } of adapter.list(roots)) {
    add("sessions");
    let s: Session;
    const loadStarted = performance.now();
    try {
      s = adapter.load(id, roots);
    } catch (e) {
      logMs += performance.now() - loadStarted;
      const msg = String((e as Error).message).slice(0, 80);
      errors.set(msg, (errors.get(msg) ?? 0) + 1);
      note("load failed", id);
      continue;
    }
    logMs += performance.now() - loadStarted;
    loaded.push({ id, session: s });
  }
  const prepareStarted = performance.now();
  sizes.prepare(loaded.map(({ session }) => session), roots === undefined);
  gitMs += performance.now() - prepareStarted;
  for (const { id, session: s } of loaded) {
    const size = sizes.measure(s, roots === undefined);
    gitMs += size.gitMs;
    tokenMs += size.tokenMs;
    add(size.tokens === null ? "size unknown" : size.provenance.estimated ? "size estimated" : "size recorded");
    if (s.modelCalls.length === 0) note("sessions without model calls", id);
    add("threads", s.threads.length);
    add("turns", s.turns.length);
    add("model calls", s.modelCalls.reduce((n, c) => n + callCount(c), 0));
    add("tool calls", s.toolCalls.length);
    add("skill uses", s.skills.length);
    add("incidents", s.incidents.length);
    if (launchOf(s)?.skill === "implement" || s.skills.some((skill) => skill.skill === "implement" && skill.threadId === s.id)) {
      add(s.result ? "implement sessions with result link" : "implement sessions without result link");
    }

    for (const t of s.threads) {
      if (t.parentId !== null && !t.spawnedByToolCallId) note("subagent threads without spawn link", id);
    }
    for (const t of s.turns) {
      if (t.endedAt === null) note("turns without end", id);
      else if (t.endedAt < t.startedAt) note("turns ending before start", id);
      if (t.trigger === "prompt" && !t.promptText) note("prompt turns without text", id);
    }
    for (const c of s.modelCalls) {
      if (c.kind === "turn_aggregate") {
        add("turn aggregates");
        for (const issue of checkMeasurement(c)) note(issue, id);
      }
      if (c.turnId === null) note("model calls without turn", id);
      if (!c.model || c.model === "unknown") note("model calls without model", id);
      if (c.startedAt !== null && c.endedAt < c.startedAt) note("model calls ending before start", id);
      if (Object.values(c.usage).some((v) => v < 0 || !Number.isFinite(v))) note("model calls with negative or missing tokens", id);
      if (c.usage.reasoning > c.usage.output) note("model calls with reasoning above output", id);
      if (c.startInferred) add("model calls with inferred start");
      if (c.purpose === "turn" && listCost(c) === null) {
        note("model calls without catalog price", id);
        if (c.reportedCostUsd === null) note("model calls without any cost", id);
      }
    }
    for (const t of s.toolCalls) {
      if (t.turnId === null) note("tool calls without turn", id);
      if (t.status === "unknown") note("tool calls without result", id);
      if (t.startedAt !== null && t.endedAt !== null && t.endedAt < t.startedAt) note("tool calls ending before start", id);
      if (t.category === "other") note("tool calls in category other", id);
      if (t.shellCategory === "other") add("shell calls in subcategory other");
      if (t.category === "file_read" || t.shellCategory === "read") add(t.paths.length ? "file reads with path" : "file reads without path");
      if (t.category === "file_read" && !t.paths.length) note("file read tools without path", id);
    }

    // Computed against reported cost, only where every call is priced.
    const computed = s.modelCalls.filter((c) => !c.compaction?.estimated).map(listCost);
    if (s.reportedCostUsd !== null && s.reportedCostUsd > 0 && computed.every((c) => c !== null)) {
      const sum = computed.reduce((a, b) => a + (b ?? 0), 0);
      add("cost-compared sessions");
      add("cost computed (cents)", Math.round(sum * 100));
      add("cost reported (cents)", Math.round(s.reportedCostUsd * 100));
      if (Math.abs(sum - s.reportedCostUsd) > 0.1 * s.reportedCostUsd) note("sessions with cost gap over 10%", id);
    }
  }
  counts["log read ms"] = Math.round(logMs);
  counts["Git read ms"] = Math.round(gitMs);
  counts["tokenise ms"] = Math.round(tokenMs);
  return { counts, errors, examples, seconds: (Date.now() - started) / 1000 };
}

export function formatCheck(harness: string, r: CheckResult): string {
  const lines = [`## ${harness} (read in ${r.seconds.toFixed(1)}s)`, ""];
  const w = Math.max(...Object.keys(r.counts).map((k) => k.length));
  for (const [k, v] of Object.entries(r.counts)) {
    lines.push(`${k.padEnd(w)}  ${String(v).padStart(7)}${r.examples.has(k) ? `  e.g. ${r.examples.get(k)}` : ""}`);
  }
  for (const [msg, n] of r.errors) lines.push(`error ×${n}: ${msg}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const roots = args.flatMap((a, i) => (args[i - 1] === "--root" ? [a] : []));
  const wanted = args.filter(isHarnessName);
  let total = 0;
  for (const harness of HARNESS_NAMES) {
    if (wanted.length && !wanted.includes(harness)) continue;
    const r = checkHarness(harness, roots.length ? roots : undefined);
    total += r.seconds;
    console.log(`\n${formatCheck(harness, r)}`);
  }
  console.log(`\nTotal read time ${total.toFixed(1)}s. Plan a cache (AGENTS.md rule 2) only above 60s.`);
}
