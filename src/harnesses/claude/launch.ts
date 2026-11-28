import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Launch, type LaunchOptions, type RemoteOptions, type RunResult, inUserUnit } from "../common/launch.ts";

// `--add-dir` takes every folder that follows it, so it goes before another
// option and never last, where it would swallow the prompt.
const addDirArgs = (dirs: string[]) => (dirs.length ? ["--add-dir", ...dirs] : []);

// Print mode ends with one JSON result naming the session and its reply.
// Read mode restricts tool availability as well as permission approvals.
export function launchClaude(o: LaunchOptions): Launch {
  return {
    command: "claude",
    args: [
      "-p", o.prompt, ...addDirArgs(o.addDirs), "--model", o.model, "--output-format", "json",
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
      "--rc", "--no-chrome", "--name", o.name, "--session-id", o.id, ...addDirArgs(o.addDirs), "--model", o.model,
      "--permission-mode", "auto", ...(o.effort ? ["--effort", o.effort] : []), o.prompt,
    ],
  });
}

// Claude Code's own settings, which record the folders the operator trusted.
const claudeConfig = () => join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");

// Claude Code starts without its trust dialog in a folder the operator trusted
// or inside one. An interactive session in any other folder waits at that
// dialog and never logs its prompt. Reads the settings and never changes them.
export function claudeTrusted(dir: string, config = claudeConfig()): boolean {
  let projects: Record<string, { hasTrustDialogAccepted?: unknown }> = {};
  try {
    projects = JSON.parse(readFileSync(config, "utf8"))?.projects ?? {};
  } catch {
    return false;
  }
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (projects[d]?.hasTrustDialogAccepted === true) return true;
    if (dirname(d) === d) return false;
  }
}

export function claudeResult(stdout: string): RunResult {
  try {
    const r = JSON.parse(stdout);
    return { id: r.session_id ?? null, reply: r.result ?? null };
  } catch {
    return { id: null, reply: null };
  }
}
