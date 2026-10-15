import { sep } from "node:path";
import { type RunningSession, openFiles, processesNamed } from "../common/processes.ts";
import { GROK_LIVE } from "./logs.ts";

// Headless Grok Build keeps its root events file open. Its active-session
// registry omits headless runs, and the command line has no session id.
export function runningGrok(strict = false): RunningSession[] {
  return processesNamed("grok", strict).flatMap((p) => {
    const prefix = `${GROK_LIVE}${sep}`;
    const sessions = new Set(openFiles(p.pid, strict).flatMap((file) => {
      if (!file.startsWith(prefix) || !file.endsWith(`${sep}events.jsonl`)) return [];
      const rel = file.slice(prefix.length).split(sep);
      if (rel.length !== 3 || !p.cwd || rel[0] !== encodeURIComponent(p.cwd)) return [];
      return [rel[1]];
    }));
    if (strict && sessions.size > 1) throw new Error(`Grok Build process ${p.pid} writes several root sessions`);
    return [...sessions].map((id) => ({ pid: p.pid, id, startedAt: p.startedAt }));
  });
}
