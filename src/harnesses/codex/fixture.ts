import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEXT, redactCommand, redactError, redactJson } from "../common/redact.ts";
import { codexIndex, codexRoots, readLines, threadFilesOf } from "./logs.ts";

// Keys whose string values are free text, however short.
const TEXT_KEYS = new Set(["text", "message", "parsed_cmd", "approved_command_prefixes", "domain", "url", "query", "queries", "arguments", "input", "output", "last_agent_message", "instructions", "base_instructions", "user_instructions", "developer_instructions"]);

// Writes the session and its subagent files under outDir, keeping their
// relative paths, with text replaced by placeholders.
export function cutCodexFixture(idOrPath: string, outDir: string, roots = codexRoots()): void {
  const { rel } = codexIndex(roots);
  const agents = new Map<string, string>();
  const agent = (path: string) => {
    if (!agents.has(path)) agents.set(path, `agent-${agents.size + 1}`);
    return agents.get(path)!;
  };
  for (const file of threadFilesOf(idOrPath, roots)) {
    const out = readLines(file).map((line) => {
      const r = redactJson(line, TEXT_KEYS) as any;
      const p = line.payload ?? {};
      const spawn = p.source?.subagent?.thread_spawn;
      if (line.type === "session_meta" && spawn?.agent_path) {
        r.payload.source.subagent.thread_spawn.agent_path = agent(spawn.agent_path);
      }
      if (p.type === "function_call_output" && typeof p.output === "string") {
        try {
          const task = JSON.parse(p.output).task_name;
          if (task) r.payload.output = JSON.stringify({ task_name: agent(task) });
        } catch {}
      }
      if (p.type === "task_complete" && p.error?.message) r.payload.error.message = redactError(p.error.message);
      if (p.type === "item_completed" && p.item?.type === "CommandExecution") {
        r.payload.item.command = [redactCommand(String((p.item.command ?? []).at(-1) ?? ""))];
      }
      if (p.type === "item_completed" && p.item?.type === "UserMessage") {
        r.payload.item.content = (p.item.content ?? []).map((c: any) =>
          c.type === "skill" ? { type: "skill", name: c.name, path: TEXT } : { type: c.type, text: TEXT },
        );
      }
      return JSON.stringify(r);
    });
    const target = join(outDir, rel.get(file)!);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, out.join("\n") + "\n");
  }
}
