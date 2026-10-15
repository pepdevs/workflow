import { type Launch, type LaunchOptions, type RunResult } from "../common/launch.ts";

// Print mode ends with one JSON result naming the session and its reply.
// Read mode allows only tools that read; print mode denies the rest.
export function launchClaude(o: LaunchOptions): Launch {
  return {
    command: "claude",
    args: [
      "-p", o.prompt, "--model", o.model, "--output-format", "json",
      ...(o.write ? ["--dangerously-skip-permissions"] : ["--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch"]),
      ...(o.effort ? ["--effort", o.effort] : []),
    ],
  };
}

export function claudeResult(stdout: string): RunResult {
  try {
    const r = JSON.parse(stdout);
    return { id: r.session_id ?? null, reply: r.result ?? null };
  } catch {
    return { id: null, reply: null };
  }
}
