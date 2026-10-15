import { type RunningSession, onlyWrittenSince, processesNamed } from "../common/processes.ts";
import { databases, openCodeRoots, withDatabase } from "./logs.ts";

// OpenCode processes share one database, so a process writes the one root
// session of its working directory updated since it started.
export function runningOpenCode(strict = false): RunningSession[] {
  const processes = processesNamed("opencode", strict);
  const file = databases(openCodeRoots())[0];
  if (!file) {
    if (strict && processes.length) throw new Error("unknown process database");
    return [];
  }
  return processes.flatMap((p) => {
    if (!p.cwd) {
      if (strict) throw new Error("unknown process directory");
      return [];
    }
    const rows = withDatabase(file, (db) =>
      db.prepare("select id, time_updated from session where parent_id is null and directory = ?").all(p.cwd!) as { id: string; time_updated: number }[],
    );
    const hit = onlyWrittenSince(p, rows.map((r) => ({ ref: r.id, id: r.id, updatedAt: r.time_updated })));
    if (!hit && strict) throw new Error("ambiguous process session");
    return hit ? [hit] : [];
  });
}
