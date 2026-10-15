import { type Launch, type LaunchOptions, type RunResult, jsonLines } from "../common/launch.ts";

// `opencode run --format json` prints parts with their sessionID. Text parts
// after the last step_start form the reply. Read mode runs the plan agent;
// write mode passes --auto to approve what OpenCode would ask for, such as
// access outside the working directory, which a headless run cannot answer.
export function launchOpenCode(o: LaunchOptions): Launch {
  return {
    command: "opencode",
    args: [
      "run", "--format", "json", "-m", o.model,
      ...(o.write ? ["--auto"] : ["--agent", "plan"]),
      ...(o.effort ? ["--variant", o.effort] : []),
      o.prompt,
    ],
  };
}

export function openCodeResult(stdout: string): RunResult {
  const events = jsonLines(stdout);
  const lastStep = events.findLastIndex((e) => e.type === "step_start");
  const text = events.slice(lastStep + 1).filter((e) => e.type === "text").map((e) => e.part?.text ?? "").join("");
  return { id: events.find((e) => e.sessionID)?.sessionID ?? null, reply: events.some((e) => e.type === "text") ? text : null };
}
