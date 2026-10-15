import { type Launch, type LaunchOptions, type RunResult, jsonLines } from "../common/launch.ts";

// `codex exec --json` prints events: thread.started names the session, and
// the last agent_message item is the reply.
export function launchCodex(o: LaunchOptions): Launch {
  return {
    command: "codex",
    args: [
      "exec", "--skip-git-repo-check", "--json", "-m", o.model,
      ...(o.write ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-s", "read-only"]),
      ...(o.effort ? ["-c", `model_reasoning_effort=${o.effort}`] : []),
      o.prompt,
    ],
  };
}

export function codexResult(stdout: string): RunResult {
  const events = jsonLines(stdout);
  const messages = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message");
  return { id: events.find((e) => e.type === "thread.started")?.thread_id ?? null, reply: messages.at(-1)?.item.text ?? null };
}
