import { type Launch, type LaunchOptions, type RunResult, jsonLines } from "../common/launch.ts";

// `pi -p --mode json` prints a session event with the id, then message
// events; the last assistant message_end holds the reply. Pi asks no
// permissions, so read mode limits its tools.
export function launchPi(o: LaunchOptions): Launch {
  return {
    command: "pi",
    args: [
      "-p", "--mode", "json", "--model", o.model,
      ...(o.write ? [] : ["--tools", "read,grep,find,ls"]),
      ...(o.effort ? ["--thinking", o.effort] : []),
      o.prompt,
    ],
  };
}

export function piResult(stdout: string): RunResult {
  const events = jsonLines(stdout);
  const last = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").at(-1);
  const text = (last?.message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return { id: events.find((e) => e.type === "session")?.id ?? null, reply: last ? text : null };
}
