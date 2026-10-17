// uc-14: how much of each plan's limit windows is used right now, from the providers,
// the pace that uses each weekly window up by its reset, and what a full window is worth.
import { monthlyUsd } from "../catalog.ts";
import type { PlanUsage } from "../providers/index.ts";
import { table, times, usd } from "./format.ts";
import { windowProjection } from "./subscriptions.ts";

const DAY_MS = 86_400_000;
const WEEK_MINUTES = 7 * 1440;

const windowName = (minutes: number | null) =>
  minutes === null ? "-" : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

const resetsIn = (ms: number | null, now: number) => {
  if (ms === null) return "-";
  const minutes = Math.max(0, Math.round((ms - now) / 60_000));
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

// Points ahead (+) or behind (-) an even burn of the window to 100% at reset,
// and the share per day that uses the rest by the reset.
export function windowPace(usedPercent: number, minutes: number, resetsAt: number, now: number): { pace: number; perDay: number } {
  const windowMs = minutes * 60_000;
  const left = Math.min(windowMs, Math.max(0, resetsAt - now));
  return {
    pace: Math.round(usedPercent - (100 * (windowMs - left)) / windowMs),
    perDay: left === 0 ? 0 : Math.round((Math.max(0, 100 - usedPercent) * DAY_MS) / left),
  };
}

// `spent` holds each plan's API-equivalent cost since its weekly window started;
// without it the value columns stay out.
export function usageCommand(usages: PlanUsage[], flags: Record<string, string>, now: number, spent: Map<string, number> | null = null): string {
  const rows = usages.flatMap((u) => {
    const plan = u.plan?.name ?? `no plan in data/subscriptions.json (${u.provider})`;
    if (u.error) return [[plan, "-", "-", "-", "", "", "", "", "", u.error]];
    const shown = flags.w ?? "7d";
    const windows = u.windows.filter((w) => shown === "all" || windowName(w.minutes) === shown);
    // A plan without the chosen window still gets a row, so no plan drops out of the table.
    if (windows.length === 0) return [[plan, "-", "-", "-", "", "", "", "", "", shown === "all" ? "no windows reported" : `no ${shown} window`]];
    return windows.map((w, i) => {
      const weekly = w.minutes === WEEK_MINUTES && w.usedPercent !== null && w.resetsAt !== null;
      const pace = weekly ? windowPace(w.usedPercent!, w.minutes!, w.resetsAt!, now) : null;
      const cost = weekly && u.plan ? spent?.get(u.plan.name) : undefined;
      const value = cost === undefined ? null : windowProjection(cost, w.usedPercent!, WEEK_MINUTES, monthlyUsd(u.plan!));
      return [i ? "" : plan, windowName(w.minutes), w.usedPercent === null ? "-" : `${Math.round(w.usedPercent)}%`, resetsIn(w.resetsAt, now),
        pace ? (pace.pace > 0 ? `+${pace.pace}` : String(pace.pace)) : "", pace ? `${pace.perDay}%/d` : "",
        cost === undefined ? "" : usd(cost), value ? usd(value.window) : "", value ? times(value.multiplier) : "", ""];
    });
  });
  const columns = ["plan", "window", "used", "resets in", "pace", "needs/day", "spent", "full window", "multiplier", "problem"];
  const keep = (_: unknown, i: number) => spent !== null || i < 6 || i === 9;
  return [
    `Plan usage reported by each provider now${(flags.w ?? "7d") === "all" ? "" : `, ${flags.w ?? "7d"} windows only (-w all shows every window)`}. Pace: points ahead or behind an even burn to 100% by reset.`,
    ...(spent === null ? [] : ["Spent: API-equivalent cost of the logged calls since the weekly window started. Full window: spent over the share used. Multiplier: a month of full windows over the plan's price."]),
    "",
    table(columns.filter(keep), rows.map((r) => r.filter(keep)), spent === null ? [2, 4, 5] : [2, 4, 5, 6, 7, 8]),
    ...(spent === null ? [] : ["", "Use outside these logs counts toward the limit without adding cost, so the full window and multiplier are lower bounds."]),
  ].join("\n");
}

// The same readings as one JSON document for another tool, every window with its pace.
export function usageJson(usages: PlanUsage[], now: number): string {
  return JSON.stringify(
    {
      schema: 1,
      at: new Date(now).toISOString(),
      plans: usages.map((u) => ({
        provider: u.provider,
        plan: u.plan?.name ?? null,
        error: u.error,
        windows: u.windows.map((w) => {
          const pace = w.minutes !== null && w.usedPercent !== null && w.resetsAt !== null ? windowPace(w.usedPercent, w.minutes, w.resetsAt, now) : null;
          return {
            window: windowName(w.minutes),
            minutes: w.minutes,
            usedPercent: w.usedPercent,
            resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt).toISOString(),
            pace: pace?.pace ?? null,
            perDay: pace?.perDay ?? null,
          };
        }),
      })),
    },
    null,
    2,
  );
}
