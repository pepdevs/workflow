// uc-15: which model does best at which skill, at what cost, from the logs.
import { CONTEXT_BUDGET, SIZE_BAND_M_MAX, SIZE_BAND_S_MAX, sizeBand, type SizeBand } from "../catalog.ts";
import type { Session } from "../model.ts";
import { callCost, launchOf, modelCounts, peakContext, rootThread, rootTurns, sum } from "../facts.ts";
import { ADAPTER_OF, loadAll, parseWhen } from "./find.ts";
import { dur, table, thousands, tok, usd } from "./format.ts";
import { type Evaluation, readGithubEvaluations } from "../providers/github.ts";
import { SessionSizeCall, type SessionSize } from "../repos/session-size.ts";

export type ModelRow = {
  skill: string;
  harness: string;
  model: string;
  band: SizeBand | "unknown" | null; // implement peak-context band; other skills stay one row
  sessions: number;
  finished: number; // the last root turn completed
  judged: number;
  passed: number;
  changes: number;
  blocked: number;
  medianCost: number;
  medianMs: number;
  medianPeak: number | null;
  estimatedPeak: boolean;
  overBudget: number | null; // unknown when an estimate prevents exact classification
  repositorySize: { median: number | null; measured: number; estimated: boolean } | null;
};

const BAND_ORDER: Record<SizeBand | "unknown", number> = { S: 0, M: 1, L: 2, over: 3, unknown: 4 };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

const peakOf = (s: Session) => peakContext(s.modelCalls);

// The role a session ran: the skill `wf run` launched it with. Sessions a
// person started count for no skill, whatever skills they loaded.
const skillsOf = (s: Session) => {
  const launched = launchOf(s)?.skill;
  return launched ? [launched] : [];
};

// The last root turn completed. Claude Code's print mode writes no turn
// end record, so a last call that stopped without asking for tools counts too.
const ENDS_TURN = new Set(["end_turn", "stop"]);
function finished(s: Session): boolean {
  const last = rootTurns(s).at(-1);
  if (!last || last.outcome === "interrupted" || last.outcome === "error") return false;
  if (last.outcome === "completed") return true;
  return ENDS_TURN.has(s.modelCalls.filter((c) => c.turnId === last.id).at(-1)?.stopReason ?? "");
}

// One row per skill, harness and model. Implement rows also split by peak-context
// band. A session counts under the model with most turn calls in its root thread,
// under the skill `wf run` launched it with.
export function modelRows(sessions: Session[], evaluations: Evaluation[] = [], sizeOf?: (session: Session) => SessionSize): ModelRow[] {
  const earliest = new Map<string, Evaluation>();
  for (const evaluation of evaluations) {
    const key = `${evaluation.pullRequest}\0${evaluation.headSha.toLowerCase()}`;
    const prior = earliest.get(key);
    if (!prior || evaluation.createdAt < prior.createdAt) earliest.set(key, evaluation);
  }
  const groups = new Map<string, { skill: string; harness: string; model: string; band: SizeBand | "unknown" | null; sessions: Session[] }>();
  for (const s of sessions) {
    const root = rootThread(s);
    const calls = s.modelCalls.filter((c) => c.threadId === root && c.purpose === "turn");
    const counts = new Map<string, number>();
    for (const call of calls) for (const [model, count] of modelCounts(call)) counts.set(model, (counts.get(model) ?? 0) + count);
    const model = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!model) continue;
    for (const skill of skillsOf(s)) {
      const peak = peakOf(s);
      const band = skill === "implement" ? peak.tokens === null ? "unknown" : peak.estimated ? null : sizeBand(peak.tokens) : null;
      const key = `${skill}\0${s.harness}\0${model}\0${band ?? ""}`;
      if (!groups.has(key)) groups.set(key, { skill, harness: ADAPTER_OF[s.harness], model, band, sessions: [] });
      groups.get(key)!.sessions.push(s);
    }
  }
  return [...groups.values()].map(({ skill, harness, model, band, sessions }) => {
    const peaks = sessions.map(peakOf);
    const knownPeaks = peaks.flatMap((p) => p.tokens === null ? [] : [p.tokens]);
    const sizes = sizeOf ? sessions.map(sizeOf) : [];
    const measuredSizes = sizes.flatMap((size) => size.tokens === null ? [] : [size.tokens]);
    const verdicts = skill === "implement" ? sessions.map((s) => s.result?.pullRequest && s.result.headSha
      ? earliest.get(`${s.result.pullRequest}\0${s.result.headSha.toLowerCase()}`)?.verdict : undefined) : [];
    return {
      skill,
      harness,
      model,
      band,
      sessions: sessions.length,
      finished: sessions.filter(finished).length,
      judged: verdicts.filter(Boolean).length,
      passed: verdicts.filter((v) => v === "PASS").length,
      changes: verdicts.filter((v) => v === "CHANGES").length,
      blocked: verdicts.filter((v) => v === "BLOCKED").length,
      medianCost: median(sessions.map((s) => sum(s.modelCalls.map((c) => callCost(c) ?? 0)))),
      medianMs: median(sessions.map((s) => sum(rootTurns(s).map((t) => (t.endedAt ?? t.startedAt) - t.startedAt)))),
      medianPeak: knownPeaks.length ? median(knownPeaks) : null,
      estimatedPeak: peaks.some((p) => p.estimated),
      overBudget: peaks.some((p) => p.estimated || p.tokens === null) ? null : peaks.filter((p) => p.tokens! > CONTEXT_BUDGET).length,
      repositorySize: sizeOf ? {
        median: measuredSizes.length ? median(measuredSizes) : null,
        measured: measuredSizes.length,
        estimated: sizes.some((size) => size.tokens !== null && size.provenance.estimated),
      } : null,
    };
  });
}

// Sums judged, passed and changes across implement bands. The join has no median.
export function routeCounts(rows: ModelRow[]): Map<string, { judged: number; passed: number; changes: number }> {
  const out = new Map<string, { judged: number; passed: number; changes: number }>();
  for (const row of rows) {
    if (row.skill !== "implement") continue;
    const key = `${row.harness}\0${row.model}`;
    const prior = out.get(key) ?? { judged: 0, passed: 0, changes: 0 };
    out.set(key, { judged: prior.judged + row.judged, passed: prior.passed + row.passed, changes: prior.changes + row.changes });
  }
  return out;
}

function sortRows(rows: ModelRow[]): ModelRow[] {
  const total = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.skill}\0${row.harness}\0${row.model}`;
    total.set(key, (total.get(key) ?? 0) + row.sessions);
  }
  return [...rows].sort((a, b) => {
    const skill = a.skill.localeCompare(b.skill);
    if (skill) return skill;
    if (a.band || b.band) {
      const key = (r: ModelRow) => `${r.skill}\0${r.harness}\0${r.model}`;
      return (total.get(key(b)) ?? 0) - (total.get(key(a)) ?? 0)
        || a.harness.localeCompare(b.harness)
        || a.model.localeCompare(b.model)
        || BAND_ORDER[a.band ?? "S"] - BAND_ORDER[b.band ?? "S"]
        || a.medianCost - b.medianCost;
    }
    return b.sessions - a.sessions || a.medianCost - b.medianCost;
  });
}

// Text table for `wf models`. Verdict columns appear when a GitHub read succeeded.
export function modelTable(rows: ModelRow[], verdicts: boolean): string {
  const sorted = sortRows(rows);
  const bandColumn = sorted.some((r) => r.band !== null);
  const verdictColumns = verdicts && sorted.some((r) => r.skill === "implement");
  const sizeColumn = sorted.some((r) => r.repositorySize !== null);
  const headers = [
    "skill",
    ...(bandColumn ? ["band"] : []),
    "harness",
    "model",
    "sessions",
    "finished",
    ...(verdictColumns ? ["judged", "passed", "blocked", "pass rate"] : []),
    "cost",
    ...(sizeColumn ? ["code and docs", "measured"] : []),
    "time",
    "peak context",
    `over ${tok(CONTEXT_BUDGET)}`,
  ];
  const numeric = new Set(["sessions", "finished", "judged", "passed", "blocked", "pass rate", "cost", "code and docs", "measured", "time", "peak context", headers.at(-1)!]);
  const intro = bandColumn
    ? `Sessions per skill and model, by the model with most calls in the root thread. Medians per session. Implement rows split by peak context: S under ${tok(SIZE_BAND_S_MAX)}, M from ${tok(SIZE_BAND_S_MAX)} to under ${tok(SIZE_BAND_M_MAX)}, L from ${tok(SIZE_BAND_M_MAX)} through ${tok(CONTEXT_BUDGET)}, over above that.`
    : "Sessions per skill and model, by the model with most calls in the root thread. Medians per session.";
  return [
    intro,
    "",
    table(
      headers,
      sorted.map((r) => [
        r.skill,
        ...(bandColumn ? [r.band ?? "-"] : []),
        r.harness,
        r.model,
        String(r.sessions),
        `${r.finished}`,
        ...(verdictColumns ? (r.skill === "implement"
          ? [String(r.judged), String(r.passed), String(r.blocked), r.passed + r.changes ? `${Math.round(100 * r.passed / (r.passed + r.changes))}%` : "-"]
          : ["-", "-", "-", "-"]) : []),
        usd(r.medianCost),
        ...(sizeColumn ? [
          r.repositorySize?.median === null || r.repositorySize === null ? "unknown" : `${thousands(r.repositorySize.median)}${r.repositorySize.estimated ? " est." : ""}`,
          `${r.repositorySize?.measured ?? 0}/${r.sessions}`,
        ] : []),
        dur(r.medianMs),
        r.medianPeak === null ? "unknown" : `${tok(r.medianPeak)}${r.estimatedPeak ? " est." : ""}`,
        r.overBudget === null ? "unknown" : String(r.overBudget),
      ]),
      headers.flatMap((h, i) => numeric.has(h) ? [i] : []),
    ),
  ].join("\n");
}

export function modelsCommand(flags: Record<string, string>, base: string | undefined, now: number, withSize = false): string | Promise<string> {
  const when = parseWhen(flags.d ?? "30", now);
  const sessions = loadAll(base, when.from).filter((s) => {
    const start = rootTurns(s)[0]?.startedAt;
    return start !== undefined && start >= when.from && start < when.to;
  });
  const render = (evaluations: Evaluation[] | null, notice: string | null): string => {
    const selected = sessions.filter((s) => !flags.k || skillsOf(s).includes(flags.k));
    const sizeCall = withSize ? new SessionSizeCall() : null;
    sizeCall?.prepare(selected, base === undefined);
    const rows = modelRows(selected, evaluations ?? [], sizeCall ? (s) => sizeCall.measure(s, base === undefined) : undefined);
    if (rows.length === 0) return "No wf run session in the window. Widen it with -d.";
    return [modelTable(rows, evaluations !== null), ...(notice ? [notice] : [])].join("\n");
  };
  if (base !== undefined) return render(null, "Verdicts missing (custom log roots).");
  if (flags.k && flags.k !== "implement") return render(null, null);
  const urls = sessions.filter((s) => skillsOf(s).includes("implement") && s.result?.pullRequest && s.result.headSha).map((s) => s.result!.pullRequest!);
  if (urls.length === 0) return render([], null);
  return readGithubEvaluations(urls).then((evaluations) => render(evaluations, null), () => render(null, "Verdicts missing (GitHub unavailable)."));
}
