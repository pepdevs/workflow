// uc-13: rank harnesses and models for a skill.
import { isHarnessName, type HarnessName } from "../harnesses/index.ts";
import { familyOf, isRetired, ROUTE_PACE_MARGIN, ROUTE_PROVIDERS, routeList, subscriptionOf, type Subscription } from "../catalog.ts";
import { type QuotaReading, type Session } from "../model.ts";
import { modelCounts, rootTurns } from "../facts.ts";
import type { PlanUsage } from "../providers/index.ts";
import { readGithubEvaluations, type Evaluation } from "../providers/github.ts";
import { ADAPTER_OF, loadAll, parseWhen } from "./find.ts";
import { table } from "./format.ts";
import { modelRows, routeCounts, type ModelRow } from "./models.ts";
import { limitHits } from "./subscriptions.ts";
import { windowPace } from "./usage.ts";

export type Route = {
  harness: HarnessName;
  model: string; // the model argument `wf run` takes in this harness
  name: string; // the model as the logs name it
  listPosition: number | null;
  plan: Subscription | null;
  used: number | null; // highest share used of a current limit window
  usedFrom: "provider" | "logs" | null;
  pace: number | null; // points ahead or behind the provider's 7-day window
  limitedUntil: number | null;
  independence: "cross_family" | "distinct_model" | "same_model" | null;
  calls: number;
  verdict?: Pick<ModelRow, "judged" | "passed" | "changes">;
};

// A limit hit without a reset time blocks its plan for one five-hour window.
const LIMIT_BLOCK_MS = 5 * 3_600_000;

export function parseRouteEntry(entry: string): { harness: HarnessName; model: string; name: string; provider: string } {
  const match = /^(\S+) (\S+)$/.exec(entry);
  const harness = match?.[1];
  const model = match?.[2];
  const qualified = harness === "pi" || harness === "opencode";
  const slash = model?.indexOf("/") ?? -1;
  if (!harness || !isHarnessName(harness) || !model || (qualified ? slash < 1 || slash === model.length - 1 : !ROUTE_PROVIDERS[harness])) {
    throw new Error(`Invalid route entry ${JSON.stringify(entry)}: expected <harness> <model> with a provider prefix for pi/opencode or a harness in providers`);
  }
  const provider = qualified ? model.slice(0, slash) : ROUTE_PROVIDERS[harness];
  return { harness, model, name: qualified ? model.slice(slash + 1) : model, provider };
}

// Exhaustion and an exact author-model match precede the operator's list.
export function rankRoutes(routes: Route[], now: number): Route[] {
  const keys = (r: Route) => [
    r.limitedUntil !== null && r.limitedUntil > now ? 1 : 0,
    r.independence === "same_model" ? 1 : 0,
    r.listPosition === null ? 1 : 0,
    r.listPosition !== null && r.pace !== null && r.pace > ROUTE_PACE_MARGIN ? 1 : 0,
    r.listPosition ?? Infinity,
    r.plan ? 0 : 1,
    -r.calls,
  ];
  return [...routes].sort((a, b) => {
    const [ka, kb] = [keys(a), keys(b)];
    const i = ka.findIndex((v, j) => v !== kb[j]);
    return i === -1 ? a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model) : ka[i] - kb[i];
  });
}

// Routes seen in the sessions, with the headroom of their plans at `now`:
// from the providers when they answered, from the logs otherwise.
export function routesFrom(sessions: Session[], skill: string, authors: string[], now: number, usage: PlanUsage[] | null): Route[] {
  const routes = new Map<string, Route>();
  const add = (harness: HarnessName, model: string, name: string, provider: string, listPosition: number | null): Route => {
    const key = `${harness} ${model}`;
    if (!routes.has(key)) {
      const family = familyOf(name);
      routes.set(key, {
        harness, model, name, listPosition, plan: subscriptionOf(provider, now),
        used: null, usedFrom: null, pace: null, limitedUntil: null, calls: 0,
        independence: authors.length === 0 ? null : authors.includes(name) ? "same_model" : authors.some((a) => familyOf(a) === family) ? "distinct_model" : "cross_family",
      });
    }
    return routes.get(key)!;
  };
  routeList(skill).forEach((listed, position) => {
    const { harness, model, name, provider } = parseRouteEntry(listed);
    if (!isRetired(name)) add(harness, model, name, provider, position + 1);
  });
  for (const s of sessions) {
    const harness = ADAPTER_OF[s.harness];
    for (const c of s.modelCalls.filter((c) => c.purpose === "turn")) for (const [name, count] of modelCounts(c)) {
      if (name === "unknown" || isRetired(name)) continue;
      const provider = c.kind === "turn_aggregate" ? c.modelUsages.find((m) => m.model === name)!.provider : c.provider;
      const model = harness === "pi" || harness === "opencode" ? `${provider}/${name}` : name;
      add(harness, model, name, provider, null).calls += count;
    }
  }
  const readings = sessions.flatMap((s) => s.quotaReadings).filter((r) => r.resetsAt > now);
  const hits = limitHits(sessions);
  for (const r of routes.values()) {
    if (!r.plan) continue;
    const weekly = (usage ?? []).filter((u) => u.plan === r.plan && !u.error)
      .flatMap((u) => u.windows)
      .filter((w) => w.minutes === 7 * 1440 && w.usedPercent !== null && w.resetsAt !== null && w.resetsAt > now)
      .map((w) => windowPace(w.usedPercent!, w.minutes!, w.resetsAt!, now).pace);
    // The most-ahead reading, as `used` takes the highest share.
    if (weekly.length) r.pace = Math.max(...weekly);
    const live = (usage ?? []).filter((u) => u.plan === r.plan && !u.error).flatMap((u) => u.windows).filter((w) => w.usedPercent !== null && (w.resetsAt ?? Infinity) > now);
    if (live.length) {
      r.used = Math.max(...live.map((w) => w.usedPercent!));
      r.usedFrom = "provider";
      const full = live.filter((w) => w.usedPercent! >= 100).map((w) => w.resetsAt ?? now + LIMIT_BLOCK_MS);
      if (full.length) r.limitedUntil = Math.max(...full);
      continue;
    }
    const mine = readings.filter((q) => subscriptionOf(q.provider, q.at, q.plan) === r.plan);
    const latest = new Map<number, QuotaReading>();
    for (const q of mine) if ((latest.get(q.windowMinutes)?.at ?? -Infinity) < q.at) latest.set(q.windowMinutes, q);
    if (latest.size) {
      r.used = Math.max(...[...latest.values()].map((q) => q.usedPercent));
      r.usedFrom = "logs";
    }
    const full = [...latest.values()].filter((q) => q.usedPercent >= 100).map((q) => q.resetsAt);
    const hit = hits.filter((h) => h.sub === r.plan && h.at + LIMIT_BLOCK_MS > now).map((h) => h.at + LIMIT_BLOCK_MS);
    if (full.length || hit.length) r.limitedUntil = Math.max(...full, ...hit);
  }
  return [...routes.values()];
}

export function routeCommand(skill: string, flags: Record<string, string>, base: string | undefined, now: number, usage: PlanUsage[] | null): string | Promise<string> {
  const when = parseWhen(flags.d ?? "7", now);
  const authors = flags.x ? flags.x.split(",") : [];
  const sessions = loadAll(base, when.from);
  const builderSessions = sessions.filter((s) => {
    const start = rootTurns(s)[0]?.startedAt;
    return start !== undefined && start >= when.from && start < when.to;
  });
  const routeSessions = sessions.map((s) => ({ ...s, modelCalls: s.modelCalls.filter((c) => c.endedAt >= when.from && c.endedAt < when.to) }));
  const render = (evaluations: Evaluation[] | null, notice: string | null): string => {
    const routes = routesFrom(routeSessions, skill, authors, now, usage);
    if (skill === "implement" && evaluations !== null) {
      const counts = routeCounts(modelRows(builderSessions, evaluations));
      for (const route of routes) {
        const row = counts.get(`${route.harness}\0${route.name}`);
        route.verdict = { judged: row?.judged ?? 0, passed: row?.passed ?? 0, changes: row?.changes ?? 0 };
      }
    }
    const ranked = rankRoutes(routes, now);
    const headroom = (r: Route) => {
      const used = r.used === null ? "no reading" : `${Math.round(r.used)}% used${r.usedFrom === "logs" ? " (logs)" : ""}`;
      const pace = r.pace === null ? "unknown" : r.pace > 0 ? `+${r.pace}` : String(r.pace);
      const limited = r.limitedUntil !== null && r.limitedUntil > now
        ? `limited until ${new Date(r.limitedUntil).toISOString().slice(5, 16).replace("T", " ")}; ` : "";
      return `${limited}${used}, pace ${pace}`;
    };
    const rows = ranked.map((r, i) => [
      String(i + 1), r.harness, r.model, r.listPosition === null ? "-" : String(r.listPosition), r.plan?.name ?? "per token", headroom(r),
      ...(skill === "implement" && evaluations !== null ? [String(r.verdict?.judged ?? 0), r.verdict && r.verdict.passed + r.verdict.changes
        ? `${Math.round(100 * r.verdict.passed / (r.verdict.passed + r.verdict.changes))}%` : "-"] : []),
      r.independence?.replace("_", " ") ?? "-", String(r.calls),
    ]);
    const top = ranked[0];
    return [
      `Routes for ${skill}${authors.length ? `, judged against ${authors.join(", ")}` : ""}.${top ? " Best first." : ""}`,
      "",
      table(["#", "harness", "model", "list", "plan", "headroom", ...(skill === "implement" && evaluations !== null ? ["judged", "pass rate"] : []), "independence", "calls"], rows, skill === "implement" && evaluations !== null ? [0, 3, 6, 7, 9] : [0, 3, 7]),
      ...(notice ? [notice] : []),
      "",
      ...(top ? [`wf run ${top.harness} ${top.model} -i <task file> -k ${skill}`] : ["No routes found in this window."]),
    ].join("\n");
  };
  if (skill !== "implement") return render(null, null);
  if (base !== undefined) return render(null, "Verdicts missing (custom log roots).");
  const urls = builderSessions.filter((s) => s.result?.pullRequest && s.result.headSha).map((s) => s.result!.pullRequest!);
  if (urls.length === 0) return render([], null);
  return readGithubEvaluations(urls).then((evaluations) => render(evaluations, null), () => render(null, "Verdicts missing (GitHub unavailable)."));
}
