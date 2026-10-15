import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { skillFromPath } from "../common/logs.ts";
import { TEXT, redactCommand, redactError, redactJson, skillPath } from "../common/redact.ts";
import { claudeRoots, readRecords, sessionFiles } from "./logs.ts";

// Keys whose string values are free text, however short.
const TEXT_KEYS = new Set(["text", "thinking", "signature", "input", "toolUseResult", "aiTitle", "customTitle", "summary", "lastPrompt", "description", "content", "slug"]);

// Prompt text reduced to the markers the adapter reads.
function redactPrompt(text: string): string {
  const command = /<command-name>\/?([^<]+)<\/command-name>/.exec(text);
  if (command) return `<command-name>/${command[1]}</command-name>`;
  for (const marker of ["<task-notification>", "<local-command-stdout>", "[Request interrupted by user]"]) {
    if (text.startsWith(marker.slice(0, -1))) return marker;
  }
  return TEXT;
}

function redactBlock(b: any): any {
  if (typeof b === "string") return redactPrompt(b);
  const r = redactJson(b, TEXT_KEYS) as any;
  r.type = b.type;
  if (b.type === "text") r.text = redactPrompt(String(b.text ?? ""));
  if (b.type === "tool_use") {
    r.name = b.name;
    r.input = {};
    if (b.name === "Bash") r.input.command = redactCommand(String(b.input?.command ?? ""));
    if (b.name === "Skill") r.input.skill = b.input?.skill;
    const skill = b.name === "Read" ? skillFromPath(String(b.input?.file_path ?? "")) : null;
    if (skill) r.input.file_path = skillPath(skill);
  }
  return r;
}

function redactRecord(rec: any): any {
  const r = redactJson(rec, TEXT_KEYS) as any;
  if (rec.subtype === "compact_boundary") {
    const { trigger, preTokens, postTokens } = rec.compactMetadata;
    r.compactMetadata = { trigger, preTokens, postTokens };
  }
  const content = rec.message?.content;
  if (content !== undefined) r.message.content = Array.isArray(content) ? content.map(redactBlock) : redactBlock(content);
  if (typeof rec.error === "string" && r.error === TEXT) r.error = redactError(rec.error);
  return r;
}

// Writes the session, its subagent files and their meta files under outDir,
// with the project directory renamed and text replaced by placeholders.
export function cutClaudeFixture(idOrPath: string, outDir: string, roots = claudeRoots()): void {
  for (const [rel, file] of sessionFiles(idOrPath, roots)) {
    let body: string;
    if (rel.endsWith(".meta.json")) {
      const meta = JSON.parse(readFileSync(file, "utf8"));
      body = JSON.stringify({ agentType: meta.agentType, description: TEXT, toolUseId: meta.toolUseId });
    } else {
      body = readRecords(file)
        .map((rec) => JSON.stringify(redactRecord(rec)))
        .join("\n") + "\n";
    }
    const target = join(outDir, "project", ...rel.split(sep).slice(1));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

// Cut the first two real boundaries and the records needed to identify their model.
export function cutClaudeJobFixture(jobId: string, sessionId: string, outDir: string): void {
  const source = sessionFiles(sessionId, claudeRoots()).find(([rel]) => rel.endsWith(`${sessionId}.jsonl`));
  if (!source) throw new Error(`no Claude Code transcript for ${sessionId}`);
  const records = readRecords(source[1]);
  const selected: any[] = [];
  let previousUser: any = null;
  let previousAssistant: any = null;
  for (const record of records) {
    if (record.type === "user" && typeof record.message?.content === "string" && !record.isMeta) previousUser = record;
    if (record.type === "assistant" && record.message?.model && record.message.model !== "<synthetic>") previousAssistant = record;
    if (record.type !== "system" || record.subtype !== "compact_boundary") continue;
    if (previousUser && !selected.includes(previousUser)) selected.push(previousUser);
    if (previousAssistant) selected.push(previousAssistant);
    selected.push(record);
    if (selected.filter((r) => r.subtype === "compact_boundary").length === 2) break;
  }
  const project = join(outDir, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sessionId}.jsonl`), selected.map((r) => JSON.stringify(redactRecord(r))).join("\n") + "\n");
  const job = join(outDir, "jobs", jobId);
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "state.json"), JSON.stringify({ resumeSessionId: sessionId }) + "\n");
}
