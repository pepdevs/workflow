import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TEXT, redactCommand, redactError, redactJson } from "../common/redact.ts";
import { DB_NAME, databaseOf, openCodeRoots, sessionRows, withDatabase } from "./logs.ts";

// Keys whose string values are free text, however short.
const TEXT_KEYS = new Set(["text", "input", "output", "metadata", "summary", "system", "title", "raw", "prompt", "description"]);

function redactPart(p: any): any {
  const r = redactJson(p, TEXT_KEYS) as any;
  if (p.type !== "tool" || !p.state) return r;
  r.state.input = {};
  if (p.tool === "bash") r.state.input.command = redactCommand(String(p.state.input?.command ?? ""));
  if (p.tool === "skill") r.state.input.name = p.state.input?.name;
  r.state.metadata = p.tool === "task" && p.state.metadata?.sessionId ? { sessionId: p.state.metadata.sessionId } : {};
  return r;
}

function redactMessage(m: any): any {
  const r = redactJson(m, TEXT_KEYS) as any;
  if (m.error?.data?.message) r.error.data.message = redactError(String(m.error.data.message), m.error.data.statusCode ?? null);
  return r;
}

// Writes outDir/opencode.db holding only the session's and its descendants'
// session, message and part rows, with text replaced by placeholders.
export function cutOpenCodeFixture(sessionId: string, outDir: string, roots = openCodeRoots()): void {
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, DB_NAME);
  rmSync(target, { force: true });
  withDatabase(databaseOf(sessionId, roots), (src) => {
    const out = new DatabaseSync(target, { enableForeignKeyConstraints: false });
    try {
      const tables = src.prepare("select sql from sqlite_master where type = 'table' and name in ('session', 'message', 'part')").all() as { sql: string }[];
      for (const t of tables) out.exec(t.sql);
      const insert = (table: string, row: Record<string, any>) => {
        const cols = Object.keys(row);
        out.prepare(`insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
      };
      for (const row of sessionRows(src, sessionId)) {
        insert("session", {
          ...row,
          slug: TEXT,
          directory: "<path>",
          path: null,
          title: TEXT,
          share_url: null,
          summary_diffs: null,
          metadata: null,
          revert: null,
          permission: null,
        });
        for (const m of src.prepare("select * from message where session_id = ?").all(row.id) as any[]) {
          insert("message", { ...m, data: JSON.stringify(redactMessage(JSON.parse(m.data))) });
        }
        for (const p of src.prepare("select * from part where session_id = ?").all(row.id) as any[]) {
          insert("part", { ...p, data: JSON.stringify(redactPart(JSON.parse(p.data))) });
        }
      }
      out.exec("vacuum");
    } finally {
      out.close();
    }
  });
}
