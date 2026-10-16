// OpenCode database: ~/.local/share/opencode/opencode.db (SQLite), opened
// read-only. A child session (subagent) names its parent in session.parent_id.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { classifyApiError, modelName, shellCategory, toolCategory } from "../../catalog.ts";
import { emptySession, type Session, type Turn } from "../../model.ts";
import { type SessionRef, type LoadOptions, resultFromReply, resultSize, toolTarget } from "../common/logs.ts";

export const DB_NAME = "opencode.db";
export const OPENCODE_LIVE = join(homedir(), ".local", "share", "opencode", DB_NAME);
export const openCodeRoots = () => [OPENCODE_LIVE];

// A root is the database file or a directory holding opencode.db.
export function databases(roots: string[]): string[] {
  return roots
    .map((r) => (existsSync(r) && statSync(r).isDirectory() ? join(r, DB_NAME) : r))
    .filter((r) => existsSync(r));
}

export function withDatabase<T>(file: string, use: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return use(db);
  } finally {
    db.close();
  }
}

export function listOpenCode(roots = openCodeRoots()): SessionRef[] {
  const refs = new Map<string, SessionRef>();
  for (const file of databases(roots)) {
    const rows = withDatabase(file, (db) => db.prepare("select id, time_updated from session where parent_id is null").all() as { id: string; time_updated: number }[]);
    for (const r of rows) if (!refs.has(r.id)) refs.set(r.id, { ref: r.id, id: r.id, updatedAt: r.time_updated });
  }
  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id));
}


export function databaseOf(sessionId: string, roots: string[]): string {
  const file = databases(roots).find((f) => withDatabase(f, (db) => db.prepare("select 1 from session where id = ?").get(sessionId)));
  if (!file) throw new Error(`no OpenCode session ${sessionId}`);
  return file;
}

// The root session row and every descendant, breadth first.
export function sessionRows(db: DatabaseSync, sessionId: string): any[] {
  const rows: any[] = [db.prepare("select * from session where id = ?").get(sessionId)];
  for (let i = 0; i < rows.length; i++) {
    rows.push(...(db.prepare("select * from session where parent_id = ?").all(rows[i].id) as any[]));
  }
  return rows;
}

export function loadOpenCode(sessionId: string, roots = openCodeRoots(), { counts = false }: LoadOptions = {}): Session {
  return withDatabase(databaseOf(sessionId, roots), (db) => {
    const threadRows = sessionRows(db, sessionId);
    const root = threadRows[0];
    const session = emptySession("opencode", root.id);
    session.title = root.title;
    session.cwd = root.directory;
    session.harnessVersion = root.version;

    session.reportedCostUsd = threadRows.reduce((sum, s) => sum + s.cost, 0);
    const spawnedBy = new Map<string, string>();

    for (const s of threadRows) {
      session.threads.push({ id: s.id, parentId: s.parent_id ?? null, name: null, agentType: null, spawnedByToolCallId: null });
      const messages = db
        .prepare("select id, data from message where session_id = ? order by time_created, id")
        .all(s.id) as any[];
      const parts = db
        .prepare("select message_id, data from part where session_id = ? order by time_created, id")
        .all(s.id) as any[];
      const partsByMessage = new Map<string, any[]>();
      for (const p of parts) {
        const list = partsByMessage.get(p.message_id) ?? [];
        list.push(JSON.parse(p.data));
        partsByMessage.set(p.message_id, list);
      }
      const turns = new Map<string, Turn>();

      for (const row of messages) {
        const m = JSON.parse(row.data);
        const mParts = partsByMessage.get(row.id) ?? [];
        if (m.role === "user") {
          if (!s.parent_id) session.result = null;
          const text = unquoteRunPrompt(mParts
            .filter((p) => p.type === "text" && !p.synthetic)
            .map((p) => p.text)
            .join("\n"));
          const turn: Turn = {
            id: row.id,
            threadId: s.id,
            trigger: s.parent_id ? "agent_message" : "prompt",
            promptText: text,
            startedAt: m.time.created,
            endedAt: null,
            outcome: "unknown",
          };
          turns.set(row.id, turn);
          session.turns.push(turn);
          continue;
        }
        const turn = turns.get(m.parentID) ?? null;
        if (!s.parent_id) {
          session.result = m.finish === "stop"
            ? resultFromReply(mParts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n"))
            : null;
        }
        if (m.agent && !session.threads.at(-1)!.name && s.parent_id) session.threads.at(-1)!.name = session.threads.at(-1)!.agentType = m.agent;
        const t = m.tokens ?? {};
        session.modelCalls.push({
          id: row.id,
          threadId: s.id,
          turnId: turn?.id ?? null,
          provider: m.providerID,
          model: modelName(m.providerID, m.modelID),
          effort: m.variant ?? null,
          startedAt: m.time.created,
          startInferred: false,
          // The message stays open while its tools run; generation ends when the first tool starts.
          endedAt: Math.min(
            m.time.completed ?? m.time.created,
            ...mParts.filter((p) => p.type === "tool" && p.state?.time?.start).map((p) => p.state.time.start),
          ),
          usage: {
            input: t.input ?? 0,
            cacheRead: t.cache?.read ?? 0,
            cacheWrite: t.cache?.write ?? 0,
            cacheWrite1h: 0,
            output: (t.output ?? 0) + (t.reasoning ?? 0),
            reasoning: t.reasoning ?? 0,
          },
          stopReason: m.finish ?? null,
          purpose: m.agent === "compaction" ? "compaction" : "turn",
          reportedCostUsd: m.cost ?? null,
        });
        if (turn) {
          turn.endedAt = m.time.completed ?? turn.endedAt;
          // A reply that asks for tools leaves the turn open until a later reply ends it.
          turn.outcome = m.error ? (m.error.name === "MessageAbortedError" ? "interrupted" : "error") : m.finish === "tool-calls" ? "unknown" : "completed";
        }
        if (m.error) {
          session.incidents.push({
            turnId: turn?.id ?? null,
            threadId: s.id,
            at: m.time.completed ?? m.time.created,
            kind:
              m.error.name === "MessageAbortedError"
                ? "interrupted"
                : classifyApiError(String(m.error.data?.message ?? ""), m.error.data?.statusCode ?? null),
            detail: m.error.name,
          });
        }
        for (const p of mParts) {
          if (p.type !== "tool") continue;
          const command = p.tool === "bash" ? String(p.state?.input?.command ?? "") : null;
          const child = p.tool === "task" ? p.state?.metadata?.sessionId ?? null : null;
          if (child) spawnedBy.set(child, p.callID);
          session.toolCalls.push({
            id: p.callID,
            threadId: s.id,
            turnId: turn?.id ?? null,
            name: p.tool,
            category: toolCategory(p.tool),
            shellCategory: command === null ? null : shellCategory(command),
            command,
            origin: "model",
            startedAt: p.state?.time?.start ?? null,
            endedAt: p.state?.time?.end ?? null,
            status: p.state?.status === "error" ? "failed" : p.state?.status === "completed" ? "ok" : "unknown",
            spawnsThreadId: child,
            ...toolTarget(p.state?.input, command),
            ...resultSize(p.state?.output, counts),
          });
          if (p.tool === "skill" && p.state?.input?.name) {
            session.skills.push({ turnId: turn?.id ?? null, threadId: s.id, skill: p.state.input.name, mechanism: "tool" });
          }
        }
      }
    }
    for (const thread of session.threads) thread.spawnedByToolCallId = spawnedBy.get(thread.id) ?? null;
    return session;
  });
}

// `opencode run` wraps a message argument that contains a space in double quotes
// and escapes the quotes inside it. A text in that exact form is unwrapped, so a
// `wf run` launch header starts the prompt. A typed prompt with an unescaped inner
// quote keeps its text.
export function unquoteRunPrompt(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const inner = text.slice(1, -1);
  if (!inner.includes(" ") || /(^|[^\\])"/.test(inner)) return text;
  return inner.replaceAll('\\"', '"');
}
