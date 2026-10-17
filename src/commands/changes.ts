// uc-22: merged changes per clone as JSON, for Overview's rework figures.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryEntries } from "../catalog.ts";
import { changesOf } from "../repos/changes.ts";
import { parseWhen } from "./find.ts";

// Raise when a field changes meaning or goes away; consumers check it before reading.
export const CHANGES_SCHEMA = 1;

const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// The changes merged in the range into each clone's default branch; the catalog's clones by default.
export function changesCommand(flags: Record<string, string>, clones: string[], now: number): string {
  const when = parseWhen(flags.d ?? "30", now);
  const dirs = clones.length ? clones : Object.values(repositoryEntries).map((e) => e.path);
  const missing = clones.filter((c) => !existsSync(c));
  if (missing.length) throw new Error(`changes: no such directory: ${missing.join(", ")}`);
  const changes = [...new Set(dirs.map((d) => resolve(d)))].filter((d) => existsSync(d)).flatMap((d) => changesOf(d, when.from, when.to, now));
  changes.sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : a.mergedAt > b.mergedAt ? 1 : a.repository < b.repository ? -1 : 1));
  return JSON.stringify({ schema: CHANGES_SCHEMA, range: { from: iso(when.from), to: iso(when.to) }, changes }, null, 2);
}
