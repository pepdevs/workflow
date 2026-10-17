// Pi logs: ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<session>.jsonl.
// One assistant record is one model call; Pi has no subagents.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { classifyApiError, modelName, shellCategory, toolCategory } from "../../catalog.ts";
import { emptySession, type Session, type ToolCall, type Turn } from "../../model.ts";
import { type LoadOptions, type SessionRef, archiveDir, cachedByRoots, resultFromReply, shellReads, skillFromPath, resultSize, toolTarget, UNKNOWN_SIZE, unionFiles } from "../common/logs.ts";

export const PI_LIVE = join(homedir(), ".pi", "agent", "sessions");
export const piRoots = () => [PI_LIVE, archiveDir("pi")];
export const isPiLog = (rel: string) => rel.endsWith(".jsonl") && rel.split(sep).length <= 2;

const piIndex = cachedByRoots((roots) => unionFiles(roots, isPiLog));

// Files are named <start time>_<session id>.jsonl.
export function listPi(roots = piRoots()): SessionRef[] {
  return [...piIndex(roots, true).values()]
    .sort()
    .map((f) => ({ ref: f, id: basename(f, ".jsonl").split("_").at(-1)!, updatedAt: statSync(f).mtimeMs }));
}


export function findPiSession(idOrPath: string, roots: string[]): [string, string] {
  for (const [rel, file] of piIndex(roots)) {
    if (file === idOrPath || basename(rel).includes(idOrPath)) return [rel, file];
  }
  throw new Error(`no Pi session matches ${idOrPath}`);
}

export function readRecords(file: string): any[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function loadPi(idOrPath: string, roots = piRoots(), { counts = false }: LoadOptions = {}): Session {
  const records = readRecords(findPiSession(idOrPath, roots)[1]);
  const header = records.find((r) => r.type === "session");
  const session = emptySession("pi", header.id);
  const threadId = header.id;
  session.cwd = header.cwd ?? null;
  session.threads.push({ id: threadId, parentId: null, name: null, agentType: null, spawnedByToolCallId: null });

  let effort: string | null = null;
  let turn: Turn | null = null;
  const tools = new Map<string, ToolCall>();
  let reported = 0;

  for (const r of records) {
    const at = Date.parse(r.timestamp);
    const m = r.message;
    if (r.type === "session_info") session.title = r.name;
    if (r.type === "thinking_level_change") effort = r.thinkingLevel;
    if (r.type === "compaction" && r.usage) {
      reported += r.usage.cost?.total ?? 0;
      session.modelCalls.push({
        id: r.id,
        threadId,
        turnId: turn?.id ?? null,
        provider: "unknown",
        model: "compaction",
        effort,
        startedAt: null,
        startInferred: false,
        endedAt: at,
        usage: {
          input: r.usage.input,
          cacheRead: r.usage.cacheRead,
          cacheWrite: r.usage.cacheWrite,
          cacheWrite1h: 0,
          output: r.usage.output,
          reasoning: r.usage.reasoning ?? 0,
        },
        stopReason: null,
        purpose: "compaction",
        reportedCostUsd: r.usage.cost?.total ?? null,
      });
    }
    if (r.type !== "message") continue;

    if (m.role === "user") {
      session.result = null;
      if (turn && turn.endedAt === null) turn.endedAt = at;
      turn = {
        id: r.id,
        threadId,
        trigger: "prompt",
        promptText: (m.content ?? []).map((b: any) => b.text ?? "").join("\n"),
        startedAt: at,
        endedAt: null,
        outcome: "unknown",
      };
      session.turns.push(turn);
    } else if (m.role === "assistant") {
      session.result = m.stopReason === "stop" || m.stopReason === "end_turn"
        ? resultFromReply((m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"))
        : null;
      const u = m.usage ?? {};
      reported += u.cost?.total ?? 0;
      session.modelCalls.push({
        id: m.responseId ?? r.id,
        threadId,
        turnId: turn?.id ?? null,
        provider: m.provider,
        model: modelName(m.provider, m.model),
        effort,
        startedAt: m.timestamp ?? null,
        startInferred: false,
        endedAt: at,
        usage: {
          input: u.input ?? 0,
          cacheRead: u.cacheRead ?? 0,
          cacheWrite: u.cacheWrite ?? 0,
          cacheWrite1h: 0,
          output: u.output ?? 0,
          reasoning: u.reasoning ?? 0,
        },
        stopReason: m.stopReason ?? null,
        purpose: "turn",
        reportedCostUsd: u.cost?.total ?? null,
      });
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        session.incidents.push({
          turnId: turn?.id ?? null,
          threadId,
          at,
          kind: m.stopReason === "aborted" ? "interrupted" : classifyApiError(m.errorMessage ?? ""),
          detail: (m.errorMessage ?? "").slice(0, 80),
        });
      }
      if (turn) {
        turn.endedAt = at;
        // A reply that asks for tools leaves the turn open until a later reply ends it.
        turn.outcome = m.stopReason === "aborted" ? "interrupted" : m.stopReason === "error" ? "error" : m.stopReason === "toolUse" ? "unknown" : "completed";
      }
      for (const b of m.content ?? []) {
        if (b.type !== "toolCall") continue;
        const command = b.name === "bash" ? String(b.arguments?.command ?? "") : null;
        const tool: ToolCall = {
          id: b.id,
          threadId,
          turnId: turn?.id ?? null,
          name: b.name,
          category: toolCategory(b.name),
          shellCategory: command === null ? null : shellCategory(command),
          command,
          origin: "model",
          startedAt: at,
          endedAt: null,
          status: "unknown",
          spawnsThreadId: null,
          ...toolTarget(b.arguments, command, b.name),
          ...UNKNOWN_SIZE,
        };
        tools.set(b.id, tool);
        session.toolCalls.push(tool);
        const skill = b.name === "read" ? skillFromPath(String(b.arguments?.path ?? "")) : null;
        if (skill) session.skills.push({ turnId: turn?.id ?? null, threadId, skill, mechanism: "file_read" });
      }
    } else if (m.role === "toolResult") {
      const t = tools.get(m.toolCallId);
      if (t) {
        t.endedAt = at;
        t.status = m.isError ? "failed" : "ok";
        Object.assign(t, resultSize(m.content, counts));
      }
      if (turn) turn.endedAt = at;
    } else if (m.role === "bashExecution") {
      session.toolCalls.push({
        id: r.id,
        threadId,
        turnId: turn?.id ?? null,
        name: "bash",
        category: "shell",
        shellCategory: shellCategory(m.command ?? ""),
        command: m.command ?? null,
        origin: "user",
        startedAt: m.timestamp ?? null,
        endedAt: at,
        status: m.exitCode === 0 ? "ok" : "failed",
        web: null,
        spawnsThreadId: null,
        ...shellReads(m.command ?? ""),
        ...resultSize(m.output, counts),
      });
    }
  }
  session.reportedCostUsd = reported;
  return session;
}
