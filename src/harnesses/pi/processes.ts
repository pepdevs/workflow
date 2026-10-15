import { basename, join, sep } from "node:path";
import { type RunningSession, childEnv, onlyWrittenSince, processesNamed } from "../common/processes.ts";
import { PI_LIVE, listPi } from "./logs.ts";

// Pi appends to its session file without holding it open, and names it only
// to the tools it runs, in PI_SESSION_FILE. Without a running tool, the process
// writes the one session in its working directory's folder written since it started.
export function runningPi(strict = false): RunningSession[] {
  const sessions = listPi();
  return processesNamed("pi", strict).flatMap((p) => {
    const file = childEnv(p.pid, "PI_SESSION_FILE", strict);
    if (file) return [{ pid: p.pid, id: basename(file, ".jsonl").split("_").at(-1)!, startedAt: p.startedAt }];
    if (!p.cwd) {
      if (strict) throw new Error("unknown process directory");
      return [];
    }
    const folder = `--${p.cwd.slice(1).replaceAll("/", "-")}--`;
    const hit = onlyWrittenSince(p, sessions.filter((s) => s.ref.startsWith(join(PI_LIVE, folder) + sep)));
    if (!hit && strict) throw new Error("ambiguous process session");
    return hit ? [hit] : [];
  });
}
