// Headless launches shared by every harness.
// A fresh headless session. Read allows reading tools only; write bypasses
// every permission check in the working directory the caller chose.
export type LaunchOptions = { model: string; prompt: string; write: boolean; effort: string | null };
export type Launch = { command: string; args: string[] };
// The session id and final reply from a headless run's standard output.
export type RunResult = { id: string | null; reply: string | null };

export const jsonLines = (stdout: string): any[] =>
  stdout.split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
