import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { skillFromPath } from "../common/logs.ts";
import { TEXT, redactCommand, redactError, redactJson, skillPath } from "../common/redact.ts";
import { findPiSession, piRoots, readRecords } from "./logs.ts";

// Keys whose string values are free text, however short.
const TEXT_KEYS = new Set(["text", "thinking", "thinkingSignature", "textSignature", "arguments", "content", "summary", "name", "command", "output", "details", "errorMessage"]);

// Writes the session under outDir in a directory named for no real path,
// with text replaced by placeholders.
export function cutPiFixture(idOrPath: string, outDir: string, roots = piRoots()): void {
  const [rel, file] = findPiSession(idOrPath, roots);
  const out = readRecords(file).map((rec) => {
    const r = redactJson(rec, TEXT_KEYS) as any;
    const m = rec.message;
    if (m && Array.isArray(m.content)) {
      r.message.content = m.content.map((b: any) => {
        const block = redactJson(b, TEXT_KEYS) as any;
        block.type = b.type;
        if (b.type === "toolCall") {
          block.name = b.name;
          block.arguments = {};
          if (b.name === "bash") block.arguments.command = redactCommand(String(b.arguments?.command ?? ""));
          const skill = b.name === "read" ? skillFromPath(String(b.arguments?.path ?? "")) : null;
          if (skill) block.arguments.path = skillPath(skill);
        }
        return block;
      });
    }
    if (m?.role === "bashExecution") r.message.command = redactCommand(String(m.command ?? ""));
    if (m?.errorMessage) r.message.errorMessage = redactError(m.errorMessage);
    if (rec.type === "session_info") r.name = TEXT;
    return JSON.stringify(r);
  });
  const target = join(outDir, "--project--", basename(rel));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, out.join("\n") + "\n");
}
