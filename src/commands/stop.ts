// uc-11: stop a session and the tools it runs.
import { ADAPTERS, UNITS, descendants, unitOf } from "../harnesses/index.ts";
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
// A session `wf run --remote-control` started runs in its own user unit:
// stopping the unit ends the session, its terminal and every tool in it. The
// stop does not wait, so a session can stop its own unit.
export function stopCommand(s: Session): string {
  const harness = ADAPTER_OF[s.harness];
  const unit = `${unitOf(s.id)}.service`;
  if (UNITS.active(unit)) return stopUnit(unit, `Stopping ${unit}, which runs ${harness} ${s.id}.`);
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

function stopUnit(unit: string, stopping: string): string {
  const error = UNITS.stop(unit);
  return error === null ? stopping : `systemctl --user stop ${unit} failed: ${error}`;
}

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A session `wf run --remote-control` started that has not logged its first
// prompt has no session to find, but its unit runs. Given its full id, stops
// that unit; otherwise null.
export function stopUnlogged(id: string): string | null {
  const unit = `${unitOf(id)}.service`;
  if (!FULL_ID.test(id) || !UNITS.active(unit)) return null;
  return stopUnit(unit, `Stopping ${unit}: session ${id} has logged no prompt yet.`);
}
