import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactCommand, redactJson, skillPath, TEXT } from "../common/redact.ts";
import { skillFromPath } from "../common/logs.ts";
import { grokFiles, grokRoots, grokSpawns, spawnedId } from "./logs.ts";

const TEXT_KEYS = new Set(["prompt", "generated_title", "worktree_label", "head_branch", "last_turn_summary", "text", "content", "command", "description", "reason", "summary_preview", "session_summary", "title", "arguments", "cwd", "git_root_dir", "grok_home", "agent_name", "old_string", "new_string", "oldText", "newText", "pattern", "glob", "query", "encrypted_content", "context_before", "context_after", "line_prefix", "output_for_prompt", "retrieval_hint"]);
const ids = new Map<string, string>();
const safeId = (id: string) => {
  if (!ids.has(id)) ids.set(id, `fixture-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`);
  return ids.get(id)!;
};
const redact = (value: any, key = "", inText = false): any => {
  if (typeof value === "string") {
    if (inText) return TEXT;
    if (["path", "file_path", "target_file", "arguments"].includes(key)) {
      const skill = skillFromPath(value);
      if (skill) return skillPath(skill);
    }
    if (key === "command") return redactCommand(value);
    if (["agent_id", "attempt_id", "owner_session_id", "last_turn_summary_prompt_id", "resume_from", "task_ids", "parent_session_id", "child_session_id", "subagent_id", "parent_prompt_id", "fork_parent_prompt_id", "resumed_from", "task_id", "id", "sessionId", "session_id", "toolCallId", "tool_call_id", "prompt_id", "promptId", "eventId", "request_id"].includes(key)) return safeId(value);
    if (["cwd", "git_root_dir", "grok_home"].includes(key)) return "/fixture/project";
    if (TEXT_KEYS.has(key)) return TEXT;
    return redactJson(value, TEXT_KEYS, false, key);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key, inText));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name, inText || TEXT_KEYS.has(key))]));
  return value;
};

export function cutGrokFixture(idOrPath: string, outDir: string, roots = grokRoots(), options: { omitSignals?: boolean; children?: string[]; launchResult?: { prompt: string; reply: string } } = {}): void {
  ids.clear();
  const visited = new Set<string>();
  const cut = (idOrPath: string) => {
    if (visited.has(idOrPath)) return;
    visited.add(idOrPath);
    let files: Map<string, string>;
    try { files = grokFiles(idOrPath, roots); } catch (error) {
      if (visited.size === 1) throw error;
      return;
    }
    const folder = join(outDir, "%2Ffixture%2Fproject", safeId(idOrPath.split("/").at(-1)!));
    mkdirSync(folder, { recursive: true });
    for (const [name, file] of files) {
      if (options.omitSignals && name === "signals.json") {
        rmSync(join(folder, name), { force: true });
        continue;
      }
      const text = readFileSync(file, "utf8");
      if (name.endsWith(".jsonl")) {
        const lines = text.split("\n").flatMap((line) => {
          try { return line.trim() ? [JSON.stringify(redactRecord(JSON.parse(line), name, options.launchResult))] : []; } catch { return []; }
        });
        writeFileSync(join(folder, name), lines.join("\n") + "\n");
      } else {
        try { writeFileSync(join(folder, name), JSON.stringify(redact(JSON.parse(text))) + "\n"); } catch { /* A live file may be incomplete. */ }
      }
    }
    for (const child of grokSpawns(files)) {
      if (!options.children || options.children.includes(child.id)) cut(child.id);
    }
  };
  cut(idOrPath);
}

// Keep only the structural child ID from a spawn result's free text.
function redactRecord(record: any, name: string, launchResult?: { prompt: string; reply: string }): any {
  const child = spawnedId(record.params?.update?.rawOutput?.text);
  const safe = redact(record);
  if (child) safe.params.update.rawOutput.text = `subagent_id: ${safeId(child)}`;
  if (launchResult && name === "updates.jsonl" && record.params?.update?.sessionUpdate === "user_message_chunk") {
    safe.params.update.content.text = launchResult.prompt;
  }
  if (launchResult && name === "chat_history.jsonl" && record.type === "assistant" && typeof record.content === "string" && !record.tool_calls) {
    safe.content = launchResult.reply;
  }
  return safe;
}
