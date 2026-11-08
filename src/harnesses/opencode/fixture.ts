import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TEXT, redactCommand, redactError, redactJson } from "../common/redact.ts";
import { DB_NAME, databaseOf, openCodeRoots, type Schema, sessionRows, withDatabase } from "./logs.ts";

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

// A schema 2 reply keeps its tool calls in `content`; each keeps what the
// adapter reads, as redactPart does for schema 1.
function redactContent(c: any): any {
  if (c.type !== "tool") return redactJson({ ...c, native: undefined }, TEXT_KEYS);
  const r = redactJson({ ...c, native: undefined, state: undefined }, TEXT_KEYS) as any;
  const input: Record<string, unknown> = {};
  if (c.name === "bash") input.command = redactCommand(String(c.state?.input?.command ?? ""));
  if (c.name === "skill") input.name = c.state?.input?.name;
  const sessionId = c.name === "task" ? c.state?.metadata?.sessionId ?? null : null;
  r.state = { status: c.state?.status, input, metadata: sessionId ? { sessionId } : {}, content: [] };
  return r;
}

function redactMessage2(m: any): any {
  const r = redactMessage({ ...m, content: undefined, native: undefined, snapshot: undefined });
  if (Array.isArray(m.content)) r.content = m.content.map(redactContent);
  return r;
}

const TABLES: Record<Schema, { session: string; rows: [table: string, redact: (row: any) => any][] }> = {
  1: {
    session: "session",
    rows: [
      ["message", (m) => ({ ...m, data: JSON.stringify(redactMessage(JSON.parse(m.data))) })],
      ["part", (p) => ({ ...p, data: JSON.stringify(redactPart(JSON.parse(p.data))) })],
    ],
  },
  2: {
    session: "session_v2",
    rows: [["session_message", (m) => ({ ...m, data: JSON.stringify(redactMessage2(JSON.parse(m.data))) })]],
  },
};

// Writes outDir/opencode.db holding only the session's and its descendants'
// session and message rows, with text replaced by placeholders.
export function cutOpenCodeFixture(sessionId: string, outDir: string, roots = openCodeRoots()): void {
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, DB_NAME);
  rmSync(target, { force: true });
  const { file, schema } = databaseOf(sessionId, roots);
  const tables = TABLES[schema];
  withDatabase(file, (src) => {
    const out = new DatabaseSync(target, { enableForeignKeyConstraints: false });
    try {
      const names = [tables.session, ...tables.rows.map(([t]) => t)];
      const ddl = src.prepare(`select sql from sqlite_master where type = 'table' and name in (${names.map(() => "?").join(", ")})`).all(...names) as { sql: string }[];
      for (const t of ddl) out.exec(t.sql);
      const insert = (table: string, row: Record<string, any>) => {
        const cols = Object.keys(row);
        out.prepare(`insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
      };
      for (const row of sessionRows(src, sessionId, schema)) {
        insert(tables.session, {
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
        for (const [table, redact] of tables.rows) {
          for (const r of src.prepare(`select * from ${table} where session_id = ?`).all(row.id) as any[]) insert(table, redact(r));
        }
      }
      out.exec("vacuum");
    } finally {
      out.close();
    }
  });
}
