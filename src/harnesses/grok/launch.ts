import type { LaunchOptions, Launch, RunResult } from "../common/launch.ts";

export function launchGrok(o: LaunchOptions): Launch {
  return {
    command: "grok",
    args: [
      "-p", o.prompt, "-m", o.model, "--output-format", "json",
      ...(o.write
        ? ["--always-approve", "--permission-mode", "bypassPermissions"]
        : ["--tools", "read_file,list_dir,grep", "--permission-mode", "plan"]),
      ...(o.effort ? ["--reasoning-effort", o.effort] : []),
    ],
  };
}

export function grokResult(stdout: string): RunResult {
  try {
    const value = JSON.parse(stdout);
    return {
      id: typeof value.sessionId === "string" ? value.sessionId : null,
      reply: typeof value.text === "string" ? value.text : null,
    };
  } catch {
    return { id: null, reply: null };
  }
}
