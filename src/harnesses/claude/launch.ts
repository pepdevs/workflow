import { type Launch, type LaunchOptions, type RemoteOptions, type RunResult, inUserUnit } from "../common/launch.ts";

// Print mode ends with one JSON result naming the session and its reply.
// Read mode restricts tool availability as well as permission approvals.
export function launchClaude(o: LaunchOptions): Launch {
  return {
    command: "claude",
    args: [
      "-p", o.prompt, "--model", o.model, "--output-format", "json",
      ...(o.write ? ["--dangerously-skip-permissions"] : [
        "--tools", "Read,Grep,Glob,WebFetch,WebSearch", "--strict-mcp-config",
        "--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch",
      ]),
      ...(o.effort ? ["--effort", o.effort] : []),
    ],
  };
}

// An interactive session with Remote Control on, named for the phone and
// claude.ai/code. Auto mode answers permission requests; one it holds waits
// for the operator over Remote Control. Without --no-chrome a Chrome extension
// dialog blocks the start.
export function launchClaudeRemote(o: RemoteOptions): Launch {
  return inUserUnit(o, {
    command: "claude",
    args: [
      "--rc", "--no-chrome", "--name", o.name, "--session-id", o.id, "--model", o.model,
      "--permission-mode", "auto", ...(o.effort ? ["--effort", o.effort] : []), o.prompt,
    ],
  });
}

export function claudeResult(stdout: string): RunResult {
  try {
    const r = JSON.parse(stdout);
    return { id: r.session_id ?? null, reply: r.result ?? null };
  } catch {
    return { id: null, reply: null };
  }
}
