// Codex CLI rollout files: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// A subagent writes its own file naming the parent thread in session_meta.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyApiError, shellCategory, toolCategory } from "../../catalog.ts";
import { emptySession, type Session, type Turn } from "../../model.ts";
import { type LoadOptions, type SessionRef, archiveDir, cachedByRoots, resultFromReply, resultSize, shellReads, skillFromPath, textSize, unionFiles, UNKNOWN_SIZE } from "../common/logs.ts";

export const CODEX_LIVE = join(homedir(), ".codex", "sessions");
export const codexRoots = () => [CODEX_LIVE, archiveDir("codex")];
export const isCodexLog = (rel: string) => rel.endsWith(".jsonl");

type Line = { timestamp: string; type: string; payload: any };

export function readLines(file: string): Line[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Line types the session loader ignores; reasoning and replies are most of a file's bytes.
const IGNORED = /"payload":\{"type":"(?:reasoning|custom_tool_call|message)"|"item":\{"type":"(?:Reasoning|AgentMessage)"|"type":"compacted"/;
// Command output repeats up to four times per command and the loader reads none of it.
const OUTPUT_KEYS = ["stdout", "stderr", "aggregated_output", "formatted_output"].map((k) => Buffer.from(`,"${k}":"`));
const QUOTE = 34;

// The index just past the JSON string whose opening quote is at `open`.
function stringEnd(buf: Buffer, open: number): number {
  let q = open;
  for (;;) {
    q = buf.indexOf(QUOTE, q + 1);
    if (q < 0) return -1;
    let slashes = 0;
    while (buf[q - 1 - slashes] === 92) slashes++;
    if (slashes % 2 === 0) return q + 1;
  }
}

// Codex parses each command itself; a read it recognises names its path.
// Commands it leaves unknown fall back to the shared shell parser.
function commandTarget(command: string, parsed: unknown): { paths: string[]; lines: string | null } {
  const reads = Array.isArray(parsed) ? parsed.filter((c: any) => c?.type === "read" && typeof c.path === "string") : [];
  if (!reads.length) return shellReads(command);
  const shell = shellReads(command);
  return { paths: reads.map((c: any) => c.path), lines: reads.length === 1 ? shell.lines : null };
}

// Codex cuts command output to about 40,000 characters before the model sees it;
// its log keeps the whole output. Measured on 304 truncated outputs, 2026-09-30.
const MODEL_OUTPUT_CHARS = 40_000;

// A command's output as the model saw it. Lines and words of a truncated output
// shrink in proportion to its characters.
function commandOutputSize(item: any) {
  if (typeof item.output_chars !== "number") return UNKNOWN_SIZE;
  const share = item.output_chars > MODEL_OUTPUT_CHARS ? MODEL_OUTPUT_CHARS / item.output_chars : 1;
  const scaled = (n: unknown) => (typeof n === "number" ? Math.round(n * share) : null);
  return { resultChars: Math.min(item.output_chars, MODEL_OUTPUT_CHARS), resultLines: scaled(item.output_lines), resultWords: scaled(item.output_words) };
}

// One line's text without command output fields. `counts` adds the output's
// lines and words, which cost decoding it.
function withoutOutput(buf: Buffer, start: number, end: number, counts: boolean): string {
  const cuts: [number, number][] = [];
  for (const key of OUTPUT_KEYS) {
    const at = buf.indexOf(key, start);
    if (at < 0 || at >= end) continue;
    const after = stringEnd(buf, at + key.length - 1);
    if (after < 0 || after > end) return buf.toString("utf8", start, end);
    cuts.push([at, after]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  let text = "";
  let from = start;
  for (const [at, after] of cuts) {
    text += buf.toString("utf8", from, at);
    // The escaped byte length of the output stands in for its characters.
    if (buf.subarray(at, at + OUTPUT_KEYS[2].length).equals(OUTPUT_KEYS[2])) {
      text += `,"output_chars":${after - at - OUTPUT_KEYS[2].length - 1}`;
      // Counts decode the output, so they match every other harness's.
      if (counts) {
        const size = textSize(JSON.parse(buf.toString("utf8", at + OUTPUT_KEYS[2].length - 1, after)));
        text += `,"output_lines":${size.resultLines},"output_words":${size.resultWords}`;
      }
    }
    from = after;
  }
  return text + buf.toString("utf8", from, end);
}

// The lines loadCodex reads. A tool output line keeps only its timestamp and type.
function readRecords(file: string, counts: boolean): Line[] {
  const buf = readFileSync(file);
  const out: Line[] = [];
  for (let start = 0; start < buf.length; ) {
    let end = buf.indexOf(10, start);
    if (end < 0) end = buf.length;
    if (end > start) {
      const head = buf.toString("latin1", start, Math.min(end, start + 300));
      if (head.includes('"type":"custom_tool_call_output"')) {
        out.push({ timestamp: /"timestamp":"([^"]*)"/.exec(head)?.[1] ?? "", type: "response_item", payload: { type: "custom_tool_call_output" } });
      } else if (!IGNORED.test(head)) {
        try {
          out.push(JSON.parse(head.includes('"type":"CommandExecution"') ? withoutOutput(buf, start, end, counts) : buf.toString("utf8", start, end)));
        } catch {
          out.push(JSON.parse(buf.toString("utf8", start, end)));
        }
      }
    }
    start = end + 1;
  }
  return out;
}

function firstMeta(file: string): any {
  // Read only the first line: files reach tens of megabytes.
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
    return JSON.parse(first).payload;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

type CodexIndex = { files: string[]; rel: Map<string, string>; metas: Map<string, any> };

export const codexIndex = cachedByRoots((roots): CodexIndex => {
  const byRel = unionFiles(roots, isCodexLog);
  const files = [...byRel.values()].sort();
  return {
    files,
    rel: new Map([...byRel].map(([r, f]) => [f, r])),
    metas: new Map(files.map((f) => [f, firstMeta(f)])),
  };
});

// Root session files: every file whose session_meta names no parent thread.
export function listCodex(roots = codexRoots()): SessionRef[] {
  const { files, metas } = codexIndex(roots, true);
  return files
    .filter((f) => metas.get(f) && !metas.get(f).source?.subagent)
    .map((f) => ({ ref: f, id: metas.get(f).id, updatedAt: statSync(f).mtimeMs }));
}


function findCodexSession(idOrPath: string, roots: string[]): string {
  if (idOrPath.endsWith(".jsonl")) return idOrPath;
  const hit = codexIndex(roots).files.find((f) => f.includes(idOrPath));
  if (!hit) throw new Error(`no Codex session matches ${idOrPath}`);
  return hit;
}

// Child thread files, found by parent_thread_id, depth first.
function childFiles(parentId: string, files: string[], metas: Map<string, any>): string[] {
  const out: string[] = [];
  for (const f of files) {
    const spawn = metas.get(f)?.source?.subagent?.thread_spawn;
    if (spawn?.parent_thread_id === parentId) {
      out.push(f, ...childFiles(metas.get(f).id, files, metas));
    }
  }
  return out;
}

export function threadFilesOf(idOrPath: string, roots: string[]): string[] {
  const rootFile = findCodexSession(idOrPath, roots);
  const { files, metas } = codexIndex(roots);
  return [rootFile, ...childFiles(firstMeta(rootFile).id, files, metas)];
}

export function loadCodex(idOrPath: string, roots = codexRoots(), { counts = false }: LoadOptions = {}): Session {
  const threadFiles = threadFilesOf(idOrPath, roots);
  const rootMeta = firstMeta(threadFiles[0]);
  const metas = new Map(threadFiles.map((f) => [f, firstMeta(f)]));
  const session = emptySession("codex", rootMeta.id);
  session.cwd = rootMeta.cwd ?? null;
  session.startGit = { ...(typeof rootMeta.git?.commit_hash === "string" ? { commit: rootMeta.git.commit_hash } : {}), ...(typeof rootMeta.git?.repository_url === "string" ? { repository: rootMeta.git.repository_url } : {}), at: Date.parse(rootMeta.timestamp) };
  session.harnessVersion = rootMeta.cli_version ?? null;

  const threadByAgentPath = new Map<string, string>();
  for (const f of threadFiles) {
    const meta = metas.get(f);
    const spawn = meta?.source?.subagent?.thread_spawn;
    session.threads.push({
      id: meta.id,
      parentId: spawn?.parent_thread_id ?? null,
      name: spawn ? `${spawn.agent_nickname ?? ""} ${spawn.agent_path ?? ""}`.trim() : null,
      agentType: spawn?.agent_role || null,
      spawnedByToolCallId: null,
    });
    if (spawn?.agent_path) threadByAgentPath.set(spawn.agent_path, meta.id);
  }

  for (const file of threadFiles) {
    const threadId = metas.get(file).id;
    const lines = readRecords(file, counts);
    const turns = new Map<string, Turn>();
    const turnModel = new Map<string, { model: string; effort: string | null }>();
    const prompted = new Set<string>();
    const pendingCalls = new Map<string, { name: string; at: number; turnId: string | null }>();
    let currentTurn: string | null = null;
    let boundary: number | null = null;
    const hasUsageRecords = lines.some((l) => l.type === "token_usage_record");
    let lastTotal = -1;

    for (const l of lines) {
      const at = Date.parse(l.timestamp);
      const p = l.payload ?? {};
      if (l.type === "turn_context") {
        turnModel.set(p.turn_id, { model: p.model, effort: p.effort ?? null });
      } else if (l.type === "event_msg" && p.type === "task_started") {
        if (threadId === session.id) session.result = null;
        currentTurn = p.turn_id;
        boundary = p.started_at * 1000;
        turns.set(p.turn_id, {
          id: p.turn_id,
          threadId,
          trigger: "agent_message",
          promptText: null,
          startedAt: p.started_at * 1000,
          endedAt: null,
          outcome: "unknown",
        });
      } else if (l.type === "event_msg" && p.type === "task_complete") {
        if (threadId === session.id) session.result = resultFromReply(p.last_agent_message ?? "");
        const t = turns.get(p.turn_id);
        if (t) {
          t.endedAt = p.completed_at * 1000;
          t.outcome = p.error ? "error" : "completed";
        }
        if (p.error) {
          session.incidents.push({
            turnId: p.turn_id,
            threadId,
            at,
            kind: classifyApiError(p.error.codex_error_info ?? p.error.message ?? ""),
            detail: p.error.codex_error_info ?? null,
          });
        }
      } else if (l.type === "event_msg" && p.type === "turn_aborted") {
        const t = turns.get(p.turn_id);
        if (t) {
          t.endedAt = p.completed_at * 1000;
          t.outcome = "interrupted";
        }
        session.incidents.push({ turnId: p.turn_id, threadId, at, kind: "interrupted", detail: p.reason ?? null });
      } else if (l.type === "event_msg" && p.type === "item_completed") {
        const item = p.item ?? {};
        if (item.type === "UserMessage") {
          const t = turns.get(p.turn_id);
          const text = (item.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
          if (t && text && !prompted.has(p.turn_id)) {
            t.trigger = "prompt";
            t.promptText = text;
            prompted.add(p.turn_id);
          }
          for (const c of item.content ?? []) {
            if (c.type === "skill") session.skills.push({ turnId: p.turn_id, threadId, skill: c.name, mechanism: "mention" });
          }
        } else if (item.type === "CommandExecution") {
          const command: string = (item.command ?? []).at(-1) ?? "";
          session.toolCalls.push({
            id: item.id,
            threadId,
            turnId: p.turn_id,
            name: "exec_command",
            category: "shell",
            shellCategory: shellCategory(command),
            command,
            origin: item.source === "user_shell" ? "user" : "model",
            startedAt: p.started_at_ms ?? null,
            endedAt: p.completed_at_ms ?? null,
            status: item.status === "failed" || (item.exit_code ?? 0) !== 0 ? "failed" : "ok",
            spawnsThreadId: null,
            ...commandTarget(command, item.parsed_cmd),
            ...commandOutputSize(item),
          });
          const skill = /SKILL\.md/.test(command) && !/apply_patch|>\s*\S*SKILL\.md/.test(command) ? skillFromPath(command) : null;
          if (skill) session.skills.push({ turnId: p.turn_id, threadId, skill, mechanism: "file_read" });
          boundary = p.completed_at_ms ?? boundary;
        } else if (item.type === "FileChange") {
          session.toolCalls.push({
            id: item.id,
            threadId,
            turnId: p.turn_id,
            name: "apply_patch",
            category: "file_write",
            shellCategory: null,
            command: null,
            origin: "model",
            startedAt: p.started_at_ms ?? null,
            endedAt: p.completed_at_ms ?? null,
            status: item.status === "failed" ? "failed" : "ok",
            spawnsThreadId: null,
            paths: Object.keys(item.changes ?? {}),
            lines: null,
            ...UNKNOWN_SIZE,
          });
        }
      } else if (l.type === "response_item" && p.type === "function_call") {
        pendingCalls.set(p.call_id, { name: p.name, at, turnId: currentTurn });
      } else if (l.type === "response_item" && p.type === "function_call_output") {
        const call = pendingCalls.get(p.call_id);
        boundary = at;
        if (!call) continue;
        let spawns: string | null = null;
        if (call.name === "spawn_agent") {
          try {
            spawns = threadByAgentPath.get(JSON.parse(p.output).task_name) ?? null;
          } catch {}
        }
        session.toolCalls.push({
          id: p.call_id,
          threadId,
          turnId: call.turnId,
          name: call.name,
          category: toolCategory(call.name),
          shellCategory: null,
          command: null,
          origin: "model",
          startedAt: call.at,
          endedAt: at,
          status: "ok",
          spawnsThreadId: spawns,
          paths: [],
          lines: null,
          ...resultSize(typeof p.output === "string" ? p.output : null, counts),
        });
        if (spawns) {
          const child = session.threads.find((t) => t.id === spawns);
          if (child) child.spawnedByToolCallId = p.call_id;
        }
      } else if (l.type === "response_item" && p.type === "custom_tool_call_output") {
        boundary = at;
      }
      // The account's main limit. Other limit ids cover single models.
      if (l.type === "event_msg" && p.type === "token_count" && p.rate_limits?.limit_id === "codex") {
        for (const w of [p.rate_limits.primary, p.rate_limits.secondary]) {
          if (!w?.window_minutes || !w.resets_at) continue;
          session.quotaReadings.push({ threadId, at, provider: "openai", plan: p.rate_limits.plan_type ?? null, windowMinutes: w.window_minutes, usedPercent: w.used_percent, resetsAt: w.resets_at * 1000 });
        }
      }
      if (
        (l.type === "token_usage_record" && hasUsageRecords) ||
        (!hasUsageRecords && l.type === "event_msg" && p.type === "token_count" && p.info)
      ) {
        const u = l.type === "token_usage_record" ? p.usage : p.info.last_token_usage;
        if (l.type !== "token_usage_record") {
          if (p.info.total_token_usage.total_tokens === lastTotal) continue;
          lastTotal = p.info.total_token_usage.total_tokens;
        }
        const turnId = p.turn_id ?? currentTurn;
        const m = turnModel.get(turnId ?? "") ?? { model: "unknown", effort: null };
        session.modelCalls.push({
          id: p.response_id ?? `${threadId}:${at}`,
          threadId,
          turnId,
          provider: "openai",
          model: m.model,
          effort: m.effort,
          startedAt: boundary,
          startInferred: true,
          endedAt: at,
          usage: {
            input: u.input_tokens - u.cached_input_tokens,
            cacheRead: u.cached_input_tokens,
            cacheWrite: u.cache_write_input_tokens ?? 0,
            cacheWrite1h: 0,
            output: u.output_tokens,
            reasoning: u.reasoning_output_tokens ?? 0,
          },
          stopReason: null,
          purpose: "turn",
          reportedCostUsd: null,
        });
        boundary = at;
      }
    }
    session.turns.push(...turns.values());
  }
  return session;
}
