import { type RunningSession, openFiles, processesNamed } from "../common/processes.ts";
import { CODEX_LIVE, listCodex } from "./logs.ts";

// A running Codex process holds its root session file open.
export function runningCodex(strict = false): RunningSession[] {
  const roots = listCodex();
  return processesNamed("codex", strict).flatMap((p) => {
    const open = new Set(openFiles(p.pid, strict).filter((f) => f.startsWith(CODEX_LIVE)));
    const hits = roots.filter((r) => open.has(r.ref));
    if (strict && open.size > 0 && !hits.length) throw new Error("unknown process session");
    return hits.map((r) => ({ pid: p.pid, id: r.id, startedAt: p.startedAt }));
  });
}
