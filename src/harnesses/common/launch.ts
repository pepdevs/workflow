// Headless launches shared by every harness, and the user units and launch
// records of Remote Control sessions.
import { spawnSync } from "node:child_process";
import { constants, fchmodSync, mkdirSync, openSync, readFileSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { LaunchRecord } from "../../model.ts";
import { ARCHIVE_ROOT } from "./logs.ts";

// A fresh headless session. Read allows reading tools only; write bypasses
// every permission check in the working directory the caller chose.
// `addDirs` are extra folders the session may read, for a harness that takes them.
export type LaunchOptions = { model: string; prompt: string; write: boolean; effort: string | null; addDirs: string[] };
export type Launch = { command: string; args: string[] };
// The session id and final reply from a headless run's standard output.
export type RunResult = { id: string | null; reply: string | null };

// An interactive session with Remote Control on, which the caller starts in
// its own user unit and does not wait for. `id` names the session, `unit` its
// systemd user unit, and `env` the environment the unit gets.
export type RemoteOptions = {
  model: string; prompt: string; effort: string | null; name: string; id: string;
  unit: string; cwd: string; env: Record<string, string>; maxSeconds: number | null; addDirs: string[];
};
// What the session's log holds so far: whether it logged its first prompt, and
// the Remote Control URL once the session connected.
export type RemoteState = { logged: boolean; url: string | null };
// `trusted` says whether the harness starts in a directory without asking the
// operator to trust it first; `config` replaces the harness's own settings file.
export type Remote = { launch: (o: RemoteOptions) => Launch; state: (id: string) => RemoteState; trusted: (dir: string, config?: string) => boolean };

// The transient user unit a Remote Control session runs in.
export const unitOf = (id: string) => `wf-${id}`;

// systemd user units, which `wf stop` checks and stops. Tests replace them.
export const UNITS = {
  active: (unit: string): boolean => spawnSync("systemctl", ["--user", "is-active", "--quiet", unit]).status === 0,
  // Does not wait for the unit to stop, so a session can stop its own unit.
  stop: (unit: string): string | null => {
    const r = spawnSync("systemctl", ["--user", "stop", "--no-block", unit], { encoding: "utf8" });
    return r.status === 0 ? null : (r.stderr ?? "").trim() || `code ${r.status}`;
  },
};

// A Remote Control session's prompt is what the operator reads on the phone, so
// `wf run` keeps the launch facts in a private file of the archive instead of a
// header: <archive>/launches/<harness>/<id>.json.
const launchFile = (harness: string, id: string) => join(ARCHIVE_ROOT, "launches", harness, `${id}.json`);

export function writeLaunchRecord(harness: string, id: string, record: LaunchRecord): void {
  const file = launchFile(harness, id);
  mkdirSync(join(ARCHIVE_ROOT, "launches", harness), { recursive: true, mode: 0o700 });
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
}

// The session's launch record, or null when it has none or it is malformed.
export function readLaunchRecord(harness: string, id: string): LaunchRecord | null {
  // A session id names a file in the archive, never a path.
  if (!/^[\w-]+$/.test(id)) return null;
  let v: any;
  try {
    v = JSON.parse(readFileSync(launchFile(harness, id), "utf8"));
  } catch {
    return null;
  }
  const text = (x: unknown) => typeof x === "string" && x.length > 0;
  if (!v || typeof v !== "object" || !(v.skill === null || text(v.skill))) return null;
  if (!(v.parent === null || (text(v.parent?.harness) && text(v.parent?.id)))) return null;
  return {
    skill: v.skill, parent: v.parent && { harness: v.parent.harness, id: v.parent.id },
    ...(text(v.plan) ? { plan: v.plan } : {}), ...(text(v.repo) ? { repo: v.repo } : {}), ...(text(v.commit) ? { commit: v.commit } : {}),
  };
}

// Runs a command line in a transient systemd user unit under `script`, which
// gives an interactive harness the terminal it needs. The unit ends with the
// command, or after `maxSeconds`.
export function inUserUnit(o: Pick<RemoteOptions, "unit" | "cwd" | "env" | "maxSeconds">, launch: Launch): Launch {
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  return {
    command: "systemd-run",
    args: [
      "--user", "--quiet", "--collect", `--unit=${o.unit}`, `--working-directory=${o.cwd}`,
      ...(o.maxSeconds === null ? [] : [`--property=RuntimeMaxSec=${o.maxSeconds}`]),
      ...Object.entries(o.env).map(([k, v]) => `--setenv=${k}=${v}`),
      "script", "-qfec", [launch.command, ...launch.args].map(quote).join(" "), "/dev/null",
    ],
  };
}

export const jsonLines = (stdout: string): any[] =>
  stdout.split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
