import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEXT, redactCommand, redactError, redactJson, skillPath } from "../common/redact.ts";
import { SHELLS, copilotRoots, findCopilotSession, readEvents } from "./logs.ts";

// Keys whose string values are free text, however short. Commits and branches
// name private work, so they go too.
const TEXT_KEYS = new Set([
  "content", "detailedContent", "transformedContent", "arguments", "result", "message", "error", "summary", "description",
  "agentDescription", "prompt", "intent", "reasoningText", "reasoningOpaque", "encryptedContent", "text", "title", "output",
  "input", "path", "cwd", "gitRoot", "repository", "branch", "headCommit", "baseCommit", "attachments", "summaryContent",
]);

// Writes the session under outDir/<session>/ with text replaced by
// placeholders. Shell commands keep their program for the classifier, and the
// skill tool keeps the skill it loads.
export function cutCopilotFixture(idOrPath: string, outDir: string, roots = copilotRoots()): void {
  const file = findCopilotSession(idOrPath, roots);
  const events = readEvents(file);
  const out = events.map((e) => {
    const r = redactJson(e, TEXT_KEYS) as any;
    const d = e.data ?? {};
    if (e.type === "tool.execution_start" || e.type === "tool.user_requested") {
      r.data.arguments = {};
      if (typeof d.arguments?.command === "string" && SHELLS.has(d.toolName)) r.data.arguments.command = redactCommand(d.arguments.command);
      if (d.toolName === "skill" && typeof d.arguments?.skill === "string") r.data.arguments.skill = d.arguments.skill;
    }
    if (e.type.startsWith("skill.invoked") && typeof d.name === "string" && typeof d.path === "string") r.data.path = skillPath(d.name);
    if (e.type === "session.error") r.data.message = redactError(String(d.message ?? ""), d.statusCode ?? null);
    if (e.type === "subagent.failed") r.data.error = redactError(String(d.error ?? ""));
    if (e.type === "tool.execution_complete" && d.error) r.data.error = { message: TEXT };
    return JSON.stringify(r);
  });
  const id = events.find((e) => e.type === "session.start")?.data?.sessionId ?? idOrPath;
  const target = join(outDir, id);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "events.jsonl"), out.join("\n") + "\n");
  writeFileSync(join(target, "workspace.yaml"), `id: ${id}\nname: ${TEXT}\n`);
}
