// uc-17: what a plan cost, across the sessions `wf run` launched for it.
import { type Session } from "../model.ts";
import { callCost, launchOf, modelCounts, rootTurns, sum } from "../facts.ts";
import { ADAPTER_OF, loadAll, parseWhen, shortIds } from "./find.ts";
import { dur, table, usd } from "./format.ts";

// `7`, `0007`, `workflow#7` and `pepdevs/workflow#0007` all name plan 0007 of pepdevs/workflow.
export function planMatches(query: string, plan: string): boolean {
  const split = (text: string) => {
    const at = text.lastIndexOf("#");
    return { repo: at === -1 ? "" : text.slice(0, at), number: Number(text.slice(at + 1)) };
  };
  const [q, p] = [split(query), split(plan)];
  return Number.isInteger(q.number) && q.number === p.number && (q.repo === "" || p.repo === q.repo || p.repo.endsWith(`/${q.repo}`));
}

const key = (harness: string, id: string) => `${harness}:${id}`;
const costOf = (s: Session) => sum(s.modelCalls.map((c) => callCost(c) ?? 0));
const modelOf = (s: Session) => {
  const counts = new Map<string, number>();
  for (const c of s.modelCalls.filter((c) => c.purpose === "turn")) for (const [model, count] of modelCounts(c)) counts.set(model, (counts.get(model) ?? 0) + count);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
};
const spanOf = (s: Session) => {
  const start = rootTurns(s)[0]?.startedAt;
  const end = Math.max(...s.modelCalls.map((c) => c.endedAt));
  return start === undefined || !Number.isFinite(end) ? null : end - start;
};

export function planCommand(query: string, flags: Record<string, string>, base: string | undefined, now: number): string {
  const when = parseWhen(flags.d ?? "30", now);
  const sessions = loadAll(base, when.from);
  const launched = sessions.filter((s) => {
    const plan = launchOf(s)?.plan;
    return plan && planMatches(query, plan) && (rootTurns(s)[0]?.startedAt ?? -Infinity) >= when.from;
  });
  if (launched.length === 0) return `No wf run session names plan ${query} in the window. Widen it with -d.`;
  const plans = [...new Set(launched.map((s) => launchOf(s)!.plan!))];
  // The sessions that launched them. Their whole cost includes unrelated work, so they
  // show as information and stay out of the plan's total.
  const parentKeys = new Set(launched.map((s) => launchOf(s)!.parent).filter((p) => p !== null).map((p) => key(p!.harness, p!.id)));
  const launchers = sessions.filter((s) => parentKeys.has(key(ADAPTER_OF[s.harness], s.id)) && !launched.includes(s));
  const ids = shortIds(sessions.map((s) => s.id));
  const row = (s: Session, role: string) => [ids.get(s.id) ?? s.id, role, ADAPTER_OF[s.harness], modelOf(s), usd(costOf(s)), dur(spanOf(s)), s.result?.pullRequest ?? "-"];
  const skill = (s: Session) => launchOf(s)?.skill ?? "-";
  const bySkill = [...new Set(launched.map(skill))].map((k) => {
    const group = launched.filter((s) => skill(s) === k);
    return [k, String(group.length), usd(sum(group.map(costOf)))];
  });
  const headers = ["session", "skill", "harness", "model", "cost", "time", "pull request"];
  return [
    `Plan ${plans.join(", ")}: ${launched.length} session${launched.length === 1 ? "" : "s"}, ${usd(sum(launched.map(costOf)))}.`,
    "",
    table(["skill", "sessions", "cost"], bySkill, [1, 2]),
    "",
    table(headers, launched.map((s) => row(s, skill(s))), [4, 5]),
    ...(launchers.length ? ["", "Launched from, not counted: the whole session, including work outside the plan.", table(headers, launchers.map((s) => row(s, "orchestrator")), [4, 5])] : []),
  ].join("\n");
}
