// Provider usage readings kept on disk, so a limit window stays measurable
// after the provider has moved on to the next one. Each line is what one
// provider said about one window at one moment; spend, projections and the
// plan's name are derived on each run.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { QuotaReading } from "../model.ts";
import type { PlanUsage } from "./index.ts";

export const READINGS_FILE = process.env.WORKFLOW_READINGS ?? join(homedir(), ".local", "share", "workflow", "usage-readings.jsonl");

// `plan` is the plan type the provider reported, as in harness quota readings.
type Line = { at: number; provider: string; plan: string | null; windowMinutes: number; usedPercent: number; resetsAt: number };

// Windows are keyed by reset time to the minute, since sources report it in seconds or milliseconds.
export const windowKey = (r: { provider: string; windowMinutes: number; resetsAt: number }) =>
  `${r.provider}|${r.windowMinutes}|${Math.round(r.resetsAt / 60_000)}`;

// Each complete window a provider reported, as file lines.
export function readingLines(usages: PlanUsage[], at: number): Line[] {
  return usages.flatMap((u) =>
    u.error ? [] : u.windows.flatMap((w) =>
      w.minutes === null || w.usedPercent === null || w.resetsAt === null ? [] : [{ at, provider: u.provider, plan: u.planType, windowMinutes: w.minutes, usedPercent: w.usedPercent, resetsAt: w.resetsAt }]));
}

// Recorded readings from the file's text. A line that does not parse is skipped.
export function parseReadings(text: string): QuotaReading[] {
  return text.split("\n").flatMap((line) => {
    try {
      const r = JSON.parse(line) as Line;
      const ok = typeof r.at === "number" && typeof r.provider === "string" && typeof r.windowMinutes === "number" && typeof r.usedPercent === "number" && typeof r.resetsAt === "number";
      return ok ? [{ threadId: "recorded", at: r.at, provider: r.provider, plan: r.plan ?? null, windowMinutes: r.windowMinutes, usedPercent: r.usedPercent, resetsAt: r.resetsAt }] : [];
    } catch {
      return [];
    }
  });
}

// Lines whose share used differs from the last recorded reading of their window.
export function changedLines(recorded: QuotaReading[], lines: Line[]): Line[] {
  const last = new Map<string, number>();
  for (const r of [...recorded].sort((a, b) => a.at - b.at)) last.set(windowKey(r), r.usedPercent);
  return lines.filter((l) => last.get(windowKey(l)) !== l.usedPercent);
}

export function recordedReadings(file = READINGS_FILE): QuotaReading[] {
  return existsSync(file) ? parseReadings(readFileSync(file, "utf8")) : [];
}

// Appends what the providers reported now. A failed write leaves the command's answer intact.
export function recordUsage(usages: PlanUsage[], at: number, file = READINGS_FILE): void {
  try {
    const lines = changedLines(recordedReadings(file), readingLines(usages, at));
    if (lines.length === 0) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  } catch (e) {
    console.error(`wf: usage readings not recorded: ${(e as Error).message}`);
  }
}
