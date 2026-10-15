// uc-11: stop a session and the tools it runs.
import { ADAPTERS, descendants } from "../harnesses/index.ts";
import { type Session } from "../model.ts";
import { ADAPTER_OF } from "./find.ts";

const STOP_WAIT_MS = 10_000;

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Sends SIGTERM to every process writing the session and to the tools it runs,
// then waits for them to exit. A harness leaves its tools running when only it
// receives the signal.
export function stopCommand(s: Session): string {
  const harness = ADAPTER_OF[s.harness];
  const pids = ADAPTERS[harness].running().filter((r) => r.id === s.id).map((r) => r.pid);
  if (pids.length === 0) return `No running process writes ${harness} ${s.id}.`;
  const tree = pids.flatMap((pid) => [pid, ...descendants(pid)]);
  for (const pid of tree) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const started = Date.now();
  while (tree.some(alive) && Date.now() - started < STOP_WAIT_MS) sleep(200);
  const left = tree.filter(alive);
  const took = ((Date.now() - started) / 1000).toFixed(1);
  return left.length
    ? `${left.length} of ${tree.length} processes still run ${STOP_WAIT_MS / 1000}s after SIGTERM. Run kill -9 ${left.join(" ")} to end them.`
    : `Stopped ${harness} ${s.id}: pid ${pids.join(", ")} and ${tree.length - pids.length} tool processes exited after ${took}s.`;
}
