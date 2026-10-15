// uc-7 and uc-14: the value of each subscription, its limit windows and its spend.
import { billingPeriods, monthlyEur, monthlyUsd, SUBSCRIPTIONS, subscriptionOf, USD_PER_EUR, type Subscription } from "../catalog.ts";
import { type QuotaReading, type Session } from "../model.ts";
import { windowKey, type PlanUsage } from "../providers/index.ts";
import { type Range } from "./find.ts";
import { clock, day, eur, table, times, usd } from "./format.ts";
import { callCost, callCount, sum } from "../facts.ts";

type PricedCall = { at: number; sub: Subscription | null; provider: string; model: string; cost: number | null; count: number };

// Each call with the subscription that paid for it. Codex reports the account's
// plan type in its quota readings; a call takes the plan of the last reading before it.
function pricedCalls(sessions: Session[]): PricedCall[] {
  const out: PricedCall[] = [];
  for (const s of sessions) {
    const plans = s.quotaReadings.filter((r) => r.plan !== null).sort((a, b) => a.at - b.at);
    let i = -1;
    for (const c of [...s.modelCalls].sort((a, b) => a.endedAt - b.endedAt)) {
      while (i + 1 < plans.length && plans[i + 1].at <= c.endedAt) i++;
      const plan = i >= 0 ? plans[i].plan : null;
      out.push({ at: c.endedAt, sub: subscriptionOf(c.provider, c.endedAt, plan), provider: c.provider, model: c.model, cost: callCost(c), count: callCount(c) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Limit incidents per subscription, taking the subscription of the session's
// last call before the incident. Incidents within 30 minutes of the previous one count once.
export function limitHits(sessions: Session[]): { sub: Subscription; at: number }[] {
  const raw: { sub: Subscription; at: number }[] = [];
  for (const s of sessions) {
    for (const i of s.incidents.filter((x) => x.kind === "usage_limit" || x.kind === "rate_limit")) {
      const c = s.modelCalls.filter((x) => x.endedAt <= i.at).at(-1) ?? s.modelCalls[0];
      const sub = c && subscriptionOf(c.provider, i.at);
      if (sub) raw.push({ sub, at: i.at });
    }
  }
  const last = new Map<Subscription, number>();
  return raw
    .sort((a, b) => a.at - b.at)
    .filter((h) => {
      const keep = h.at - (last.get(h.sub) ?? -Infinity) > 30 * 60_000;
      last.set(h.sub, h.at);
      return keep;
    });
}

const MONTH_MINUTES = 30.44 * 24 * 60;
const WEEK_MINUTES = 7 * 1440;

// A full window's API-equivalent cost from the cost of the share used so far,
// a month of such windows, and that month as a multiple of the plan's price.
export function windowProjection(cost: number, usedPercent: number, windowMinutes: number, monthlyPriceUsd: number): { window: number; month: number; multiplier: number } | null {
  if (usedPercent <= 0) return null;
  const window = (cost / usedPercent) * 100;
  const month = window * (MONTH_MINUTES / windowMinutes);
  return { window, month, multiplier: month / monthlyPriceUsd };
}

// uc-14: the API-equivalent cost of each plan's calls since its current weekly
// window started, as the provider reports that start.
export function weeklySpend(sessions: Session[], usages: PlanUsage[]): Map<string, number> {
  const calls = pricedCalls(sessions);
  const out = new Map<string, number>();
  for (const u of usages) {
    const w = u.windows.find((x) => x.minutes === WEEK_MINUTES);
    if (!u.plan || !w || w.resetsAt === null) continue;
    const start = w.resetsAt - WEEK_MINUTES * 60_000;
    out.set(u.plan.name, sum(calls.filter((c) => c.sub?.name === u.plan!.name && c.at >= start).map((c) => c.cost ?? 0)));
  }
  return out;
}

// One limit window with the share of it that the logged calls used, from its
// start to its last reading. A limit hit is a reading at 100%.
type Sample = { sub: Subscription; windowMinutes: number; start: number; at: number; percent: number; cost: number };

// Harness quota readings and recorded provider readings grouped into limit
// windows, one window each however many sources reported it.
function limitWindows(sessions: Session[], recorded: QuotaReading[]): { sub: Subscription; readings: QuotaReading[] }[] {
  const windows = new Map<string, { sub: Subscription; readings: QuotaReading[] }>();
  for (const r of [...sessions.flatMap((s) => s.quotaReadings), ...recorded]) {
    const sub = subscriptionOf(r.provider, r.at, r.plan);
    if (!sub) continue;
    const key = `${sub.name}|${windowKey(r)}`;
    if (!windows.has(key)) windows.set(key, { sub, readings: [] });
    windows.get(key)!.readings.push(r);
  }
  // Every window stands at 0% when it starts, so the share and the cost count from its start.
  // A provider that resets a window early starts the next one before the old reset time,
  // and a session still open reports the old window after that: those readings are dropped.
  const startOf = (r: QuotaReading) => r.resetsAt - r.windowMinutes * 60_000;
  const all = [...windows.values()].map((w) => ({ ...w, readings: w.readings.sort((a, b) => a.at - b.at), start: startOf(w.readings[0]) }));
  return all.flatMap((w) => {
    const next = Math.min(...all.filter((o) => o.sub === w.sub && o.readings[0].windowMinutes === w.readings[0].windowMinutes && o.start > w.start).map((o) => o.start));
    const rs = w.readings.filter((r) => r.at < next);
    if (rs.length === 0) return [];
    return [{ sub: w.sub, readings: w.start < rs[0].at ? [{ ...rs[0], at: w.start, usedPercent: 0 }, ...rs] : rs }];
  });
}

function costBetween(calls: PricedCall[], sub: Subscription, from: number, to: number): number {
  return sum(calls.filter((c) => c.sub === sub && c.at > from && c.at <= to).map((c) => c.cost ?? 0));
}

function windowSamples(sessions: Session[], recorded: QuotaReading[]): Sample[] {
  const calls = pricedCalls(sessions);
  const out: Sample[] = [];
  for (const { sub, readings: rs } of limitWindows(sessions, recorded)) {
    const [first, last] = [rs[0], rs.at(-1)!];
    if (last.usedPercent > first.usedPercent) {
      out.push({ sub, windowMinutes: first.windowMinutes, start: first.at, at: last.at, percent: last.usedPercent - first.usedPercent, cost: costBetween(calls, sub, first.at, last.at) });
    }
  }
  return out;
}

// Index pairs into one window's readings, oldest first, each ending at the first
// reading at least `step` points above the pair's start.
export function stepSpans(used: number[], step: number): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  for (let i = 1; i < used.length; i++) {
    if (used[i] - used[from] >= step) {
      out.push([from, i]);
      from = i;
    }
  }
  return out;
}

// uc-7: each rise of `step` points within a limit window, with its cost, the
// multiplier a month of such use gives, and the model that spent most of it.
function stepSamplesCommand(sessions: Session[], when: Range, recorded: QuotaReading[], step: number): string {
  const calls = pricedCalls(sessions);
  const rows: { at: number; cells: string[] }[] = [];
  for (const { sub, readings: rs } of limitWindows(sessions, recorded)) {
    for (const [i, j] of stepSpans(rs.map((r) => r.usedPercent), step)) {
      const [a, b] = [rs[i], rs[j]];
      if (b.at < when.from || b.at >= when.to) continue;
      const spent = calls.filter((c) => c.sub === sub && c.at > a.at && c.at <= b.at);
      const cost = sum(spent.map((c) => c.cost ?? 0));
      const points = b.usedPercent - a.usedPercent;
      const weekly = b.windowMinutes === WEEK_MINUTES ? windowProjection(cost, points, WEEK_MINUTES, monthlyUsd(sub)) : null;
      const byModel = new Map<string, number>();
      for (const c of spent) byModel.set(c.model, (byModel.get(c.model) ?? 0) + (c.cost ?? 0));
      const [model, modelCost] = [...byModel].sort((x, y) => y[1] - x[1])[0] ?? ["-", 0];
      const share = cost > 0 ? ` ${Math.round((modelCost / cost) * 100)}%` : "";
      rows.push({
        at: b.at,
        cells: [sub.name, windowName(b.windowMinutes), `${day(a.at)} ${clock(a.at)}`, `${day(b.at)} ${clock(b.at)}`, `${Math.round(a.usedPercent)}-${Math.round(b.usedPercent)}%`, usd(cost), `$${(cost / points).toFixed(2)}`, times(weekly?.multiplier ?? null), `${model}${share}`],
      });
    }
  }
  rows.sort((x, y) => y.at - x.at);
  return [
    `API-equivalent cost of each ${step}-point rise within a limit window, newest first`,
    "",
    table(["plan", "window", "from (UTC)", "to (UTC)", "used", "API-equivalent", "per 1%", "multiplier", "main model"], rows.map((r) => r.cells), [4, 5, 6, 7]),
    "",
    "The multiplier is a month of weekly windows at this rate over the plan's price; shorter windows have none.",
    "Use outside these logs counts toward a limit without adding cost, so a low figure can mean unlogged use.",
  ].join("\n");
}

const windowName = (m: number) => (m % 1440 === 0 ? `${m / 1440}d` : `${m / 60}h`);

// Calls in `when` per plan and model. A plan's row totals its models;
// providers without a plan show as paid per token.
function modelRows(calls: PricedCall[]): string[][] {
  const groups = new Map<string, Map<string, PricedCall[]>>();
  for (const c of calls) {
    const plan = c.sub?.name ?? `${c.provider} (per token)`;
    const models = groups.get(plan) ?? new Map<string, PricedCall[]>();
    const cs = models.get(c.model) ?? [];
    cs.push(c);
    models.set(c.model, cs);
    groups.set(plan, models);
  }
  const row = (plan: string, model: string, cs: PricedCall[]) => {
    const cost = sum(cs.map((c) => c.cost ?? 0));
    return { cost, cells: [plan, model, String(sum(cs.map((c) => c.count))), String(sum(cs.filter((c) => c.cost === null).map((c) => c.count))), usd(cost)] };
  };
  const plans = [...groups].map(([plan, models]) => ({
    total: row(plan, "all", [...models.values()].flat()),
    models: [...models].map(([model, cs]) => row("", model, cs)).sort((a, b) => b.cost - a.cost),
  }));
  plans.sort((a, b) => b.total.cost - a.total.cost);
  return plans.flatMap((p) => [p.total, ...p.models].map((r) => r.cells));
}

const DAY_MS = 86_400_000;

// Time from `now` to `at` in whole days, or hours under a day.
const until = (now: number, at: number) => (at - now < DAY_MS ? `${Math.ceil((at - now) / 3_600_000)}h` : `${Math.floor((at - now) / DAY_MS)}d`);

const monthDay = (ms: number) => day(ms).slice(5);

// uc-7 default view: the plans running at `now`, with their price, next bill,
// use of the current billing period and current weekly window.
function overview(calls: PricedCall[], windows: ReturnType<typeof limitWindows>, now: number): string {
  const running = SUBSCRIPTIONS.filter((s) => Date.parse(s.from) <= now && (s.to === null || Date.parse(s.to) > now));
  const rows = running.map((sub) => {
    const period = billingPeriods(sub, now).at(-1)!;
    const used = costBetween(calls, sub, period.start - 1, period.end);
    const week = windows.filter((w) => w.sub === sub && w.readings[0].windowMinutes === WEEK_MINUTES).map((w) => w.readings.at(-1)!).sort((a, b) => b.at - a.at)[0];
    const live = week && week.resetsAt > now ? week : null;
    return {
      end: period.end,
      used,
      cells: [sub.name, `${eur(monthlyEur(sub))}/month`, `${monthDay(period.end)} (in ${until(now, period.end)})`, usd(used), times(used / monthlyUsd(sub)), live ? `${Math.round(live.usedPercent)}%` : "-", live ? `${monthDay(live.resetsAt)} ${clock(live.resetsAt)}` : "-"],
    };
  });
  rows.sort((a, b) => a.end - b.end);
  const monthly = sum(running.map(monthlyEur));
  const used = sum(rows.map((r) => r.used));
  const total = ["total", `${eur(monthly)}/month`, "", usd(used), times(used / sum(running.map(monthlyUsd))), "", ""];
  return [
    `Paying ${eur(monthly)} a month on ${running.length} plans, as of ${day(now)} ${clock(now)} UTC`,
    "Used: API-equivalent cost of the current billing period's calls. Week: share of the current weekly limit used, and when it resets (UTC).",
    "",
    table(["plan", "price", "next bill", "used", "multiplier", "week", "resets"], [...rows.map((r) => r.cells), total], [3, 4, 5]),
  ].join("\n");
}

// uc-7 --history: per plan, what the logged use cost against the price and what
// a full weekly limit is worth, then per billing period. Billing periods that
// overlap `when` count in full.
function history(calls: PricedCall[], hits: { sub: Subscription; at: number }[], weeks: Sample[], when: Range, now: number): string {
  const inRange = <T extends { at: number; sub: Subscription | null }>(xs: T[], sub: Subscription, a: number, b: number) =>
    xs.filter((x) => x.sub === sub && x.at >= a && x.at < b);
  const plans: { multiplier: number; cells: string[] }[] = [];
  const periods: string[][] = [];
  for (const sub of new Set(calls.map((c) => c.sub).filter((x) => x !== null))) {
    let paid = 0, used = 0, hitCount = 0;
    const ps = billingPeriods(sub, now).filter((p) => p.end > when.from && p.start < when.to);
    if (ps.length === 0) continue;
    for (const p of ps) {
      const pc = inRange(calls, sub, p.start, p.end);
      const cost = sum(pc.map((c) => c.cost ?? 0));
      const h = inRange(hits, sub, p.start, p.end).length;
      paid += monthlyEur(sub) * p.share;
      used += cost;
      hitCount += h;
      periods.push([sub.name, `${day(p.start)} to ${day(p.end)}${p.current ? " (so far)" : ""}`, eur(monthlyEur(sub) * p.share), usd(cost), times(cost / (monthlyUsd(sub) * p.share)), String(sum(pc.map((c) => c.count))), String(h)]);
    }
    const ws = weeks.filter((x) => x.sub === sub);
    const full = windowProjection(sum(ws.map((x) => x.cost)), sum(ws.map((x) => x.percent)), WEEK_MINUTES, monthlyUsd(sub));
    const multiplier = used / (paid * USD_PER_EUR);
    plans.push({
      multiplier,
      cells: [sub.name, `${eur(monthlyEur(sub))}/month`, eur(paid), usd(used), times(multiplier), String(ws.length), usd(full?.window ?? null), times(full?.multiplier ?? null), String(hitCount)],
    });
  }
  plans.sort((a, b) => b.multiplier - a.multiplier);
  return [
    "Value of each subscription, most usage per euro first",
    "Used: the logged calls at API prices against the price paid. Full window: a weekly limit's worth, from the share each window used. Full multiplier: a month of full windows against the price.",
    "",
    table(["plan", "price", "paid", "used", "used multiplier", "windows", "full window", "full multiplier", "limit hits"], plans.map((p) => p.cells), [2, 3, 4, 5, 6, 7, 8]),
    "",
    "Per billing period",
    "",
    table(["plan", "period", "paid", "used", "multiplier", "calls", "limit hits"], periods, [2, 3, 4, 5, 6]),
  ].join("\n");
}

// uc-7 --weeks: each weekly window, newest first, with the share used and its cost.
function weekly(weeks: Sample[]): string {
  const rows = [...weeks]
    .sort((a, b) => b.start - a.start || a.sub.name.localeCompare(b.sub.name))
    .map((x) => {
      const p = windowProjection(x.cost, x.percent, x.windowMinutes, monthlyUsd(x.sub));
      return [x.sub.name, `${day(x.start)} ${clock(x.start)}`, `${Math.round(x.percent)}%`, usd(x.cost), usd(p?.window ?? null), times(p?.multiplier ?? null)];
    });
  return [
    "Per weekly window, newest first",
    "",
    table(["plan", "start (UTC)", "used", "API-equivalent", "full window", "multiplier"], rows, [2, 3, 4, 5]),
    "",
    "Readings: Codex logs report the share used, Claude Code logs only limit hits, and wf usage records every provider's share each time it runs.",
    "Use outside these logs counts toward a limit without adding cost, so the full window and its multiplier are lower bounds.",
  ].join("\n");
}

// uc-7: the running plans, then the views the flags ask for. Windows count when
// their last reading falls in `when`, and calls when they end in it. `now` is the
// latest call or reading, so a fixed set of logs gives the same output every day.
export function subscriptionsCommand(sessions: Session[], when: Range, recorded: QuotaReading[] = [], flags: Record<string, string> = {}): string {
  if (flags.s !== undefined) {
    const step = Number(flags.s);
    if (!(step > 0)) throw new Error(`bad step: ${flags.s}`);
    return stepSamplesCommand(sessions, when, recorded, step);
  }
  const calls = pricedCalls(sessions);
  const windows = limitWindows(sessions, recorded);
  const now = Math.max(calls.at(-1)?.at ?? 0, ...windows.map((w) => w.readings.at(-1)!.at));
  const weeks = windowSamples(sessions, recorded).filter((x) => x.windowMinutes === WEEK_MINUTES && x.at >= when.from && x.at < when.to);
  const parts = [overview(calls, windows, now)];
  if (flags.history !== undefined) parts.push(history(calls, limitHits(sessions), weeks, when, now));
  if (flags.weeks !== undefined) parts.push(weekly(weeks));
  if (flags.models !== undefined) {
    parts.push(["Per plan and model", "", table(["plan", "model", "calls", "unpriced", "API-equivalent"], modelRows(calls.filter((c) => c.at >= when.from && c.at < when.to)), [2, 3, 4])].join("\n"));
  }
  return parts.join("\n\n");
}
