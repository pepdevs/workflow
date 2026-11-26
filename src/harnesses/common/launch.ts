// Headless launches shared by every harness.
// A fresh headless session. Read allows reading tools only; write bypasses
// every permission check in the working directory the caller chose.
export type LaunchOptions = { model: string; prompt: string; write: boolean; effort: string | null };
export type Launch = { command: string; args: string[] };
// The session id and final reply from a headless run's standard output.
export type RunResult = { id: string | null; reply: string | null };

// An interactive session with Remote Control on, which the caller starts in
// its own user unit and does not wait for. `id` names the session, `unit` its
// systemd user unit, and `env` the environment the unit gets.
export type RemoteOptions = {
  model: string; prompt: string; effort: string | null; name: string; id: string;
  unit: string; cwd: string; env: Record<string, string>; maxSeconds: number | null;
};
// What the session's log holds so far: whether it logged its first prompt, and
// the Remote Control URL once the session connected.
export type RemoteState = { logged: boolean; url: string | null };
export type Remote = { launch: (o: RemoteOptions) => Launch; state: (id: string) => RemoteState };

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
