// uc-12: launch a skill in a fresh headless session of any harness and model.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ADAPTERS, type HarnessName, unitOf, writeLaunchRecord } from "../harnesses/index.ts";
import { type Session } from "../model.ts";
import { dur, tok, usd } from "./format.ts";
import { type LaunchInfo, callCost, launchHeader, peakContext, rootTurns, skillLine, sum } from "../facts.ts";

// Variables a harness sets for the tools it runs, naming its own session.
const SESSION_VARS = ["GROK_SESSION_ID", "OPENCODE_PID", "PI_SESSION_FILE", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"] as const;

// The session that runs `wf run`, from the environment its harness gave it.
// `wf run` removes these variables for the harness it launches, so only the
// launching harness has set one; an outer harness's variable counts last.
export function parentFromEnv(env: Record<string, string | undefined>, openCodeSession: (pid: number) => string | null): LaunchInfo["parent"] {
  if (env.GROK_SESSION_ID) return { harness: "grok", id: env.GROK_SESSION_ID };
  if (env.OPENCODE_PID) {
    const id = openCodeSession(Number(env.OPENCODE_PID));
    if (id) return { harness: "opencode", id };
  }
  if (env.PI_SESSION_FILE) return { harness: "pi", id: env.PI_SESSION_FILE.replace(/\.jsonl$/, "").split("_").at(-1)! };
  if (env.CODEX_THREAD_ID) return { harness: "codex", id: env.CODEX_THREAD_ID };
  if (env.CLAUDE_CODE_SESSION_ID) return { harness: "claude", id: env.CLAUDE_CODE_SESSION_ID };
  return null;
}

const RUN_BUFFER = 256 * 1024 * 1024;

// How long `wf run --remote-control` waits for the session to log its first
// prompt, then for Remote Control to connect.
const REMOTE_LOG_WAIT_MS = 60_000;
const REMOTE_URL_WAIT_MS = 30_000;
const POLL_MS = 250;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Variables a remote session must not inherit: a harness's own session, and a
// token login, which Remote Control refuses, in place of the stored login.
const REMOTE_DROPPED = /^(CLAUDECODE|CLAUDE_CODE_.*|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENCODE|GROK_SESSION_ID|OPENCODE_PID|PI_SESSION_FILE|CODEX_THREAD_ID)$/;

export type RemoteRun = { name: string; maxSeconds: number | null };

// `--remote-control` takes `--name` and an optional `--max-runtime` in seconds,
// and replaces `--write` and the done checks.
export function parseRemoteRun(options: Record<string, string>, remote: boolean, write: boolean): RemoteRun | null {
  if (!remote) {
    if (options.name !== undefined || options["max-runtime"] !== undefined) throw new Error("--name and --max-runtime go with --remote-control");
    return null;
  }
  if (write) throw new Error("--remote-control replaces --write: auto mode answers permission requests");
  if (["done-file", "done-command", "max-attempts"].some((k) => options[k] !== undefined)) throw new Error("--remote-control starts one session and takes no done check");
  const name = options.name?.trim();
  if (!name) throw new Error("wf run --remote-control needs --name <name>");
  const max = options["max-runtime"];
  if (max !== undefined && (!/^[1-9]\d*$/.test(max) || !Number.isSafeInteger(Number(max)))) throw new Error("--max-runtime takes a positive number of seconds");
  return { name, maxSeconds: max === undefined ? null : Number(max) };
}

type RunCompletion = { check: { kind: "file" | "command"; value: string }; maxAttempts: number };

export function parseRunCompletion(flags: Record<string, string>): RunCompletion | null {
  const file = flags["done-file"];
  const command = flags["done-command"];
  const count = flags["max-attempts"];
  if (file === undefined && command === undefined && count === undefined) return null;
  const check = file !== undefined && command === undefined ? { kind: "file" as const, value: file }
    : command !== undefined && file === undefined ? { kind: "command" as const, value: command } : null;
  if (!check?.value.trim()) {
    throw new Error("wf run needs exactly one of --done-file <path> or --done-command <shell command>");
  }
  if (!count || !/^[1-9]\d*$/.test(count) || !Number.isSafeInteger(Number(count))) {
    throw new Error("wf run needs --max-attempts <positive integer> with a done check");
  }
  return { check, maxAttempts: Number(count) };
}

function checkDone(check: RunCompletion["check"], cwd: string): boolean {
  if (check.kind === "file") return statSync(resolve(cwd, check.value), { throwIfNoEntry: false })?.isFile() ?? false;
  return spawnSync("sh", ["-c", check.value], { cwd, stdio: "ignore" }).status === 0;
}

// Keep only a repository path. Remote usernames, passwords and hosts stay out
// of the prompt and its harness log.
export function repoFromRemote(remote: string): string | null {
  let path: string;
  if (/^https?:\/\//.test(remote) || /^ssh:\/\//.test(remote)) {
    try {
      path = new URL(remote).pathname;
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@/:]+@)?[^@/:]+:(.+)$/.exec(remote);
    if (!scp) return null;
    path = scp[1];
  }
  const parts = path.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "").split("/");
  return parts.length === 2 && parts.every((part) => /^[\w.-]+$/.test(part)) ? parts.join("/") : null;
}

export function gitLaunchInfo(cwd: string): Pick<LaunchInfo, "repo" | "commit"> {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  const read = (...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const remote = read("remote", "get-url", "origin");
  const repo = remote ? repoFromRemote(remote) : null;
  const head = read("rev-parse", "--verify", "HEAD");
  const commit = head && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ? head : null;
  return { ...(repo ? { repo } : {}), ...(commit ? { commit } : {}) };
}

// Runs fresh sessions until the done check passes or the attempt limit is reached.
// Each harness keeps its logs for later commands.
export function runCommand(harness: HarnessName, model: string, flags: Record<string, string>, write: boolean, plan: string | null = null, completion: RunCompletion | null = null, report?: (output: string) => void, remote: RemoteRun | null = null): string {
  if (!flags.i) throw new Error("wf run needs -i <file> with the task");
  const input = readFileSync(flags.i, "utf8");
  const parent = parentFromEnv(process.env, (pid) => ADAPTERS.opencode.running().find((r) => r.pid === pid)?.id ?? null);
  const cwd = resolve(flags.p ?? ".");
  if (remote) {
    const result = startRemote(harness, model, flags, plan, parent, cwd, input, remote);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  const env = { ...process.env };
  for (const v of [...SESSION_VARS, "OPENCODE", "CLAUDECODE"]) delete env[v];
  if (!completion) {
    const result = runAttempt(harness, model, flags, write, plan, parent, cwd, env, input);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  if (checkDone(completion.check, cwd)) return "Done check passed before launch; no attempts needed.";
  const outputs: string[] = [];
  let previousId: string | null = null;
  for (let attempt = 1; attempt <= completion.maxAttempts; attempt++) {
    const note = attempt === 1 ? "" : `\n\n## Continue the earlier run\n\nAttempt ${attempt}/${completion.maxAttempts}. Previous session: ${harness} ${previousId ?? "unknown"}.\nThe done check has not passed (${completion.check.kind}: ${completion.check.value}).\nContinue the same task in this directory from the saved work.\nRead the existing artifacts first and finish the task.\n`;
    const result = runAttempt(harness, model, flags, write, plan, parent, cwd, env, input + note);
    const output = `Attempt ${attempt}/${completion.maxAttempts}\n${result.output}`;
    if (report) report(output);
    else outputs.push(output);
    if (checkDone(completion.check, cwd)) return [...outputs, "Done check passed."].join("\n\n");
    previousId = result.id;
  }
  process.exitCode = 1;
  return [...outputs, `Done check failed after ${completion.maxAttempts} attempts.`].join("\n\n");
}

// Starts a session with Remote Control in its own user unit and returns once
// its log holds its first prompt, with its id and Remote Control URL. The
// session runs on after `wf run` exits; `wf stop` ends it. The operator reads
// the prompt on the phone, so the launch facts go to a launch record and the
// prompt starts with the task.
function startRemote(harness: HarnessName, model: string, flags: Record<string, string>, plan: string | null, parent: LaunchInfo["parent"], cwd: string, task: string, run: RemoteRun): { failed: boolean; output: string } {
  const remote = ADAPTERS[harness].remote;
  if (!remote) throw new Error(`wf run --remote-control starts ${HARNESS_WITH_REMOTE.join(", ")} sessions only`);
  if (!remote.trusted(cwd)) throw new Error(`Claude Code has not trusted ${cwd}, so the session would wait at its trust dialog. Run it in a folder inside a trusted checkout, or open ${cwd} once in Claude Code and trust it.`);
  const id = randomUUID();
  const unit = unitOf(id);
  writeLaunchRecord(harness, id, { skill: flags.k ?? flags.r ?? null, parent, plan, ...gitLaunchInfo(cwd) });
  const prompt = `${flags.k ? `${skillLine(flags.k)}\n\n` : ""}${task}`;
  // systemd takes only names a shell could export.
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && /^[A-Za-z_]\w*$/.test(e[0]) && !REMOTE_DROPPED.test(e[0])));
  const { command, args } = remote.launch({ model, prompt, effort: flags.e ?? null, name: run.name, id, unit, cwd, env, maxSeconds: run.maxSeconds });
  const r = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const rows: [string, string][] = [
    ["Session", `${harness} ${id}`],
    ["Name", run.name],
    ["Directory", cwd],
    ["Mode", `remote control${flags.k ? `, skill ${flags.k}` : ""}${flags.r ? `, role ${flags.r}` : ""}${flags.e ? `, effort ${flags.e}` : ""}`],
    ["Parent", parent ? `${parent.harness} ${parent.id}` : "-"],
    ...(plan ? [["Plan", plan] as [string, string]] : []),
    ["Unit", `${unit}.service${run.maxSeconds === null ? "" : `, at most ${dur(run.maxSeconds * 1000)}`}`],
  ];
  const print = (extra: [string, string][], lines: string[] = []) => {
    const all = [...rows, ...extra];
    const w = Math.max(...all.map((x) => x[0].length));
    return [...all.map(([k, v]) => `${k.padEnd(w)}  ${v}`), ...lines].join("\n");
  };
  if (r.error || r.status !== 0) {
    const errors = (r.stderr ?? "").trimEnd().split("\n").filter(Boolean).slice(-20);
    return { failed: true, output: print([["Started", r.error ? r.error.message : `no: ${command} exited with code ${r.status ?? r.signal}`]], errors.length ? ["", "Standard error (last 20 lines)", ...errors] : []) };
  }
  const started = Date.now();
  let state = remote.state(id);
  while (!state.logged && Date.now() - started < REMOTE_LOG_WAIT_MS) {
    sleep(POLL_MS);
    state = remote.state(id);
  }
  if (!state.logged) {
    return { failed: true, output: print([["Started", `no prompt logged within ${REMOTE_LOG_WAIT_MS / 1000}s; journalctl --user -u ${unit} shows why, wf stop ${id} ends it`]]) };
  }
  const logged = Date.now();
  while (!state.url && Date.now() - logged < REMOTE_URL_WAIT_MS) {
    sleep(POLL_MS);
    state = remote.state(id);
  }
  return { failed: false, output: print([["Remote", state.url ?? `not connected within ${REMOTE_URL_WAIT_MS / 1000}s`]]) };
}

const HARNESS_WITH_REMOTE = (Object.keys(ADAPTERS) as HarnessName[]).filter((h) => ADAPTERS[h].remote);

function runAttempt(harness: HarnessName, model: string, flags: Record<string, string>, write: boolean, plan: string | null, parent: LaunchInfo["parent"], cwd: string, env: NodeJS.ProcessEnv, task: string): { id: string | null; failed: boolean; output: string } {
  // -r records a role, such as implement, that has no installed skill to load.
  const header = launchHeader({ skill: flags.k ?? flags.r ?? null, parent, plan, ...gitLaunchInfo(cwd) });
  const prompt = `${header}\n${flags.k ? `${skillLine(flags.k)}\n\n` : ""}${task}`;
  const { command, args } = ADAPTERS[harness].launch({ model, prompt, write, effort: flags.e ?? null });
  const started = Date.now();
  const r = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: RUN_BUFFER, stdio: ["ignore", "pipe", "pipe"], env });
  const took = Date.now() - started;
  const { id, reply } = ADAPTERS[harness].result(r.stdout ?? "");
  let s: Session | null = null;
  try {
    if (id) s = ADAPTERS[harness].load(id);
  } catch {}
  const failed = r.status !== 0 || reply === null;
  const peak = s ? peakContext(s.modelCalls) : null;
  const rows: [string, string][] = [
    ["Session", `${harness} ${id ?? "unknown"}`],
    ["Directory", cwd],
    ["Mode", `${write ? "write" : "read"}${flags.k ? `, skill ${flags.k}` : ""}${flags.r ? `, role ${flags.r}` : ""}${flags.e ? `, effort ${flags.e}` : ""}`],
    ["Parent", parent ? `${parent.harness} ${parent.id}` : "-"],
    ...(plan ? [["Plan", plan] as [string, string]] : []),
    ["Exit", `${r.error ? r.error.message : `code ${r.status ?? r.signal}`} after ${dur(took)}`],
    ["Cost", s ? `${usd(sum(s.modelCalls.map((c) => callCost(c) ?? 0)))} · peak context ${peak?.tokens === null ? "unknown" : `${tok(peak!.tokens!)}${peak?.estimated ? " est." : ""}`} · ${rootTurns(s).length} turns` : "-"],
  ];
  const w = Math.max(...rows.map((x) => x[0].length));
  const errors = failed && r.stderr ? ["", "Standard error (last 20 lines)", ...r.stderr.trimEnd().split("\n").slice(-20)] : [];
  return { id, failed, output: [...rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`), ...errors, "", "Reply", reply ?? "-"].join("\n") };
}
