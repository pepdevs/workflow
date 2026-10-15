// Live harness processes, read from /proc.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { type SessionRef } from "./logs.ts";

// A process from /proc. `startTicks` is field 22 of /proc/<pid>/stat, which
// identifies the process across PID reuse.
export type Proc = { pid: number; comm: string; cwd: string | null; startedAt: number; startTicks: string };

// A harness process and the root session it writes.
export type RunningSession = { pid: number; id: string; startedAt: number };

const CLOCK_TICKS = 100;
export function scanFailure(error: unknown, strict: boolean): void {
  if (strict && !["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
}

const read = (path: string, strict = false) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    scanFailure(error, strict);
    return null;
  }
};
const bootMs = (strict = false) => {
  const boot = /^btime (\d+)$/m.exec(read("/proc/stat", strict) ?? "")?.[1];
  if (!boot && strict) throw new Error("unknown process boot time");
  return Number(boot ?? 0) * 1000;
};

export function proc(pid: number, boot = bootMs(), strict = false): Proc | null {
  // Foreign processes do not belong to this operator's inventory.
  try {
    if (statSync(`/proc/${pid}`).uid !== process.getuid!()) return null;
  } catch (error) {
    scanFailure(error, strict);
    return null;
  }
  const stat = read(`/proc/${pid}/stat`, strict);
  if (!stat) return null;
  // The command name sits in parentheses and may hold spaces, so split after it.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const startTicks = fields[19];
  let cwd: string | null = null;
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {}
  return { pid, comm: (read(`/proc/${pid}/comm`, strict) ?? "").trim(), cwd, startedAt: boot + (Number(startTicks) / CLOCK_TICKS) * 1000, startTicks };
}

// Processes whose command name matches the harness.
export function processesNamed(name: string, strict = false): Proc[] {
  const boot = bootMs(strict);
  const out: Proc[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const comm = (read(`/proc/${entry}/comm`, strict) ?? "").trim();
    if (name !== comm) continue;
    const p = proc(Number(entry), boot, strict);
    if (p) out.push(p);
  }
  return out;
}

// Paths of the files a process holds open.
export function openFiles(pid: number, strict = false): string[] {
  try {
    return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try {
        return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
      } catch (error) {
        scanFailure(error, strict);
        return [];
      }
    });
  } catch (error) {
    scanFailure(error, strict);
    return [];
  }
}

// Direct children of a process. Each thread lists the children it spawned, and
// Codex spawns tools from worker threads.
function childrenOf(pid: number, strict = false): number[] {
  let tasks: string[] = [];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch (error) { scanFailure(error, strict); }
  return tasks.flatMap((t) => (read(`/proc/${pid}/task/${t}/children`, strict) ?? "").trim().split(/\s+/).filter(Boolean).map(Number));
}

// An environment variable of any direct child of a process.
export function childEnv(pid: number, name: string, strict = false): string | null {
  for (const child of childrenOf(pid, strict)) {
    const hit = (read(`/proc/${child}/environ`, strict) ?? "").split("\0").find((v) => v.startsWith(`${name}=`));
    if (hit) return hit.slice(name.length + 1);
  }
  return null;
}

// The one session a process writes, among sessions in its working directory
// written since it started. Null when none or several qualify.
export function onlyWrittenSince(p: Proc, candidates: SessionRef[]): RunningSession | null {
  const hits = candidates.filter((s) => s.updatedAt >= p.startedAt - 1_000);
  return hits.length === 1 ? { pid: p.pid, id: hits[0].id, startedAt: p.startedAt } : null;
}

// Every descendant of a process, parents before children.
export function descendants(pid: number): number[] {
  const out: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const children = childrenOf(queue.shift()!);
    out.push(...children);
    queue.push(...children);
  }
  return out;
}

// Runs a harness command and returns its standard output, or throws after
// `timeoutMs` or on a non-zero exit. Standard error stays unread, because
// it can echo a credential.
export function capture(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => reject(new Error(`${command} could not start`)));
    child.on("close", (code, signal) => (code === 0 ? resolve(out.trim()) : reject(new Error(signal ? `${command} timed out` : `${command} exited with ${code}`))));
  });
}
