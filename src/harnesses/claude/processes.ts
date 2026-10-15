import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type RunningSession, proc, scanFailure } from "../common/processes.ts";

// Claude Code writes ~/.claude/sessions/<pid>.json for each running process,
// naming its session and its /proc start time.
const CLAUDE_PROCESSES = join(homedir(), ".claude", "sessions");

export function runningClaude(strict = false): RunningSession[] {
  let files: string[] = [];
  try {
    files = readdirSync(CLAUDE_PROCESSES).filter((f) => /^\d+\.json$/.test(f));
  } catch (error) { scanFailure(error, strict); }
  return files.flatMap((f) => {
    try {
      const r = JSON.parse(readFileSync(join(CLAUDE_PROCESSES, f), "utf8"));
      if (strict && (!Number.isInteger(r.pid) || typeof r.sessionId !== "string" || r.procStart === undefined)) {
        throw new Error("invalid process metadata");
      }
      const p = proc(r.pid, undefined, strict);
      return p && p.startTicks === String(r.procStart) ? [{ pid: p.pid, id: r.sessionId, startedAt: p.startedAt }] : [];
    } catch (error) {
      scanFailure(error, strict);
      return [];
    }
  });
}
