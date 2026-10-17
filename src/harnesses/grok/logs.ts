// Grok Build stores one directory per session under a URL-encoded cwd.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { shellCategory, toolCategory } from "../../catalog.ts";
import { emptySession, type Session, type ToolCall, type Turn, type Usage } from "../../model.ts";
import { archiveDir, cachedByRoots, resultFromReply, skillFromPath, resultSize, toolTarget, UNKNOWN_SIZE, unionFiles, webUse, type LoadOptions, type SessionRef } from "../common/logs.ts";

export const GROK_LIVE = join(homedir(), ".grok", "sessions");
export const grokRoots = () => [GROK_LIVE, archiveDir("grok")];
const FILES = new Set(["events.jsonl", "updates.jsonl", "usage.json", "signals.json", "summary.json", "chat_history.jsonl"]);
export const isGrokLog = (rel: string) => rel.split(sep).length === 3 && FILES.has(basename(rel));
const index = cachedByRoots((roots) => unionFiles(roots, isGrokLog));
const keyOf = (rel: string) => dirname(rel);
const records = (file?: string): any[] => file && existsSync(file) ? readFileSync(file, "utf8").split("\n").flatMap((line) => {
  try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
}) : [];
const json = (file?: string): any => {
  try { return file ? JSON.parse(readFileSync(file, "utf8")) : {}; } catch { return {}; }
};
const time = (value: unknown): number => typeof value === "number" ? value * 1000 : Date.parse(String(value ?? ""));
const model = (id: string): string => /^grok-\d+(?:\.\d+)*-build$/.test(id) ? id.slice(0, -6) : id;
const usageOf = (u: any): Usage => ({
  input: Math.max(0, (u.inputTokens ?? 0) - (u.cachedReadTokens ?? 0)),
  cacheRead: u.cachedReadTokens ?? 0,
  cacheWrite: u.cacheCreationTokens ?? 0,
  cacheWrite1h: 0,
  output: u.outputTokens ?? 0,
  reasoning: u.reasoningTokens ?? 0,
});
const CATEGORIES: Record<string, string> = {
  run_terminal_command: "shell", todo_write: "planning", read_file: "file_read",
  list_dir: "search", grep: "search", web_fetch: "web", write: "file_write",
  search_replace: "file_write", spawn_subagent: "agent", search_tool: "search",
  get_command_or_subagent_output: "shell", "Web search:": "web",
};

export function listGrok(roots = grokRoots()): SessionRef[] {
  const dirs = new Map<string, SessionRef>();
  for (const [rel, file] of index(roots, true)) {
    const dir = keyOf(rel), id = basename(dir), updatedAt = statSync(file).mtimeMs;
    const old = dirs.get(dir);
    if (!old || updatedAt > old.updatedAt) dirs.set(dir, { ref: dir, id, updatedAt });
  }
  const parents = new Map<string, string>();
  for (const [dir, session] of dirs) for (const spawn of grokSpawns(grokFiles(dir, roots))) parents.set(spawn.id, session.id);
  const byId = new Map([...dirs.values()].map((s) => [s.id, s]));
  for (const child of dirs.values()) {
    const seen = new Set([child.id]);
    let parent = byId.get(parents.get(child.id) ?? "");
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      parent.updatedAt = Math.max(parent.updatedAt, child.updatedAt);
      parent = byId.get(parents.get(parent.id) ?? "");
    }
  }
  return [...dirs.values()].filter((s) => !parents.has(s.id)).sort((a, b) => a.ref.localeCompare(b.ref));
}

// Tool results name the child explicitly, including concurrently spawned children.
export const spawnedId = (text: unknown): string | undefined =>
  typeof text === "string" ? /^subagent_id: ([\w-]+)$/m.exec(text)?.[1] : undefined;

export function grokSpawns(files: Map<string, string>) {
  const updates = records(files.get("updates.jsonl"));
  const spawnTools = new Set(updates.filter((r) => r.params?.update?._meta?.["x.ai/tool"]?.name === "spawn_subagent").map((r) => r.params.update.toolCallId));
  const tools = new Map<string, string>();
  for (const r of updates) {
    const u = r.params?.update, child = spawnedId(u?.rawOutput?.text);
    if (child && spawnTools.has(u.toolCallId)) tools.set(child, u.toolCallId);
  }
  const id = json(files.get("summary.json")).info?.id ?? basename(dirname([...files.values()][0]));
  return updates.flatMap((r) => {
    const u = r.params?.update;
    if (u?.sessionUpdate !== "subagent_spawned" || u.parent_session_id !== id || typeof u.child_session_id !== "string") return [];
    return [{ id: u.child_session_id,
      toolId: tools.get(u.child_session_id) ?? null, name: typeof u.description === "string" ? u.description : null,
      at: r.params._meta?.agentTimestampMs ?? time(r.timestamp) }];
  });
}

export function grokFiles(idOrPath: string, roots: string[]): Map<string, string> {
  const files = index(roots);
  const matches = [...new Set([...files.keys()].map(keyOf))].filter((key) => key === idOrPath || basename(key).startsWith(idOrPath) || files.get(join(key, "events.jsonl")) === idOrPath);
  if (matches.length !== 1) throw new Error(matches.length ? `${idOrPath} matches ${matches.length} Grok Build sessions` : `no Grok Build session matches ${idOrPath}`);
  const dir = matches[0];
  return new Map([...files].filter(([rel]) => keyOf(rel) === dir).map(([rel, file]) => [basename(rel), file]));
}

export function loadGrok(idOrPath: string, roots = grokRoots(), options: LoadOptions = {}): Session {
  const session = loadThread(idOrPath, roots, options);
  const visited = new Set([session.id]);
  const available = new Set([...index(roots).keys()].map((rel) => basename(dirname(rel))));
  const parts = [session];
  const visit = (parent: Session) => {
    for (const spawn of grokSpawns(grokFiles(parent.id, roots))) {
      if (visited.has(spawn.id)) continue;
      visited.add(spawn.id);
      const child = available.has(spawn.id) ? loadThread(spawn.id, roots, options) : emptySession("grok", spawn.id);
      const tool = parent.toolCalls.find((t) => t.id === spawn.toolId);
      if (tool) tool.spawnsThreadId = child.id;
      child.threads = [{ id: child.id, parentId: parent.id, name: spawn.name ?? null, agentType: null, spawnedByToolCallId: spawn.toolId }];
      if (!available.has(spawn.id) || child.modelCalls.length === 0) {
        child.incidents.push({ threadId: child.id, turnId: null, at: spawn.at,
          kind: "incomplete child coverage", detail: `No recorded usage for child ${child.id}; totals cover available logs.` });
      }
      parts.push(child);
      if (available.has(spawn.id)) visit(child);
    }
  };
  visit(session);

  const resumed = new Set(parts.filter((part) => {
    if (!available.has(part.id)) return false;
    const summary = json(grokFiles(part.id, roots).get("summary.json"));
    return summary.session_kind === "subagent_resume" && summary.fork_context_source === "resumed"
      && typeof summary.parent_session_id === "string";
  }).map((part) => part.id));
  // Prefer the original turn over a resumed copy, even when the copy loads first.
  const calls = new Map<string, Session["modelCalls"][number]>();
  for (const part of parts) for (const call of part.modelCalls) {
    const key = call.id;
    const previous = calls.get(key);
    if (!previous || (resumed.has(previous.threadId) && previous.turnId?.includes(":inherited:"))) calls.set(key, call);
  }
  const retainedTurns = new Set([...calls.values()].map((c) => c.turnId));
  const tools = new Map<string, ToolCall>();
  for (const part of parts) for (const tool of part.toolCalls) {
    const key = tool.id;
    const previous = tools.get(key);
    if (!previous || (!retainedTurns.has(previous.turnId) && retainedTurns.has(tool.turnId))) tools.set(key, tool);
  }
  session.threads = parts.flatMap((p) => p.threads);
  session.turns = parts.flatMap((p) => p.turns).filter((t) => !t.id.includes(":inherited:") || retainedTurns.has(t.id));
  session.modelCalls = [...calls.values()];
  session.toolCalls = [...tools.values()];
  session.skills = parts.flatMap((p) => p.skills).filter((s) => s.turnId === null || session.turns.some((t) => t.id === s.turnId));
  session.incidents = parts.flatMap((p) => p.incidents);
  session.compactions = [...new Map(parts.flatMap((p) => p.compactions).map((c) => [`${c.startedAt}:${c.endedAt}`, c])).values()];
  session.reportedCostUsd = session.modelCalls.length ? session.modelCalls.reduce((n, c) => n + (c.reportedCostUsd ?? 0), 0) : null;
  return session;
}

function loadThread(idOrPath: string, roots: string[], { counts = false }: LoadOptions): Session {
  const files = grokFiles(idOrPath, roots);
  const summary = json(files.get("summary.json"));
  const events = records(files.get("events.jsonl"));
  const updates = records(files.get("updates.jsonl")).filter((r) => r.params?.update).map((r) => ({ at: time(r.params._meta?.agentTimestampMs ? r.params._meta.agentTimestampMs / 1000 : r.timestamp), update: r.params.update, meta: r.params._meta }));
  const history = records(files.get("chat_history.jsonl"));
  const signals = json(files.get("signals.json"));
  const id = summary.info?.id ?? basename(dirname([...files.values()][0]));
  const session = emptySession("grok", id);
  session.cwd = summary.info?.cwd ?? (() => { try { return decodeURIComponent(basename(dirname(idOrPath))); } catch { return null; } })();
  // agent_name is the agent profile, such as grok-build-plan, which every session shares.
  session.title = summary.generated_title ?? summary.session_summary ?? null;
  session.harnessVersion = null;
  session.threads.push({ id, parentId: null, name: null, agentType: null, spawnedByToolCallId: null });

  const starts = events.filter((e) => e.type === "turn_started");
  const ends = events.filter((e) => e.type === "turn_ended");
  const prompts = updates.filter((r) => r.update.sessionUpdate === "user_message_chunk").map((r) => r.update.content?.text).filter((x): x is string => typeof x === "string");
  const historyPrompts = history.filter((r) => r.type === "user").map((r) => typeof r.content === "string" ? r.content : null);
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i], end = ends[i], promptIndex = start.turn_number ?? i;
    const promptText = prompts[promptIndex] ?? historyPrompts[promptIndex] ?? null;
    const startedAt = time(start.ts);
    session.turns.push({ id: `${id}:${i}`, threadId: id, model: model(start.model_id ?? summary.current_model_id ?? "unknown"), trigger: "prompt", promptText, startedAt, endedAt: end ? time(end.ts) : null, outcome: end?.outcome === "completed" ? "completed" : ["interrupted", "cancelled"].includes(end?.outcome) ? "interrupted" : end ? "error" : "unknown" });
  }
  const turnAt = (at: number): Turn | undefined => session.turns.findLast((t) => t.startedAt <= at) ?? session.turns[0];
  let compactStart: typeof updates[number] | undefined;
  for (const r of updates) {
    const u = r.update;
    if (u.sessionUpdate === "auto_compact_started") compactStart = r;
    if (u.sessionUpdate === "auto_compact_completed") {
      session.compactions.push({ threadId: id, turnId: turnAt(r.at)?.id ?? null,
        startedAt: compactStart?.at ?? r.at - (u.elapsed_ms ?? 0), endedAt: r.at,
        trigger: "auto", preTokens: u.tokens_before, postTokens: u.tokens_after });
      compactStart = undefined;
    }
  }
  const completed = new Set<string>();
  for (const r of updates) {
    const u = r.update, at = r.at;
    if (u.sessionUpdate !== "turn_completed" || !u.usage) continue;
    let turn = session.turns.findLast((t) => t.startedAt <= at && (t.endedAt === null || at <= t.endedAt + 1000));
    if (!turn) {
      const promptIndex = session.turns.filter((t) => t.id.includes(":inherited:")).length;
      turn = { id: `${id}:inherited:${promptIndex}`, threadId: id, trigger: "prompt", promptText: prompts[promptIndex] ?? historyPrompts[promptIndex] ?? null,
        startedAt: at - (u.elapsed_ms ?? 0), endedAt: at, outcome: "completed" };
      session.turns.push(turn);
      session.turns.sort((a, b) => a.startedAt - b.startedAt);
    }
    const key = String(u.prompt_id ?? `${turn?.id}:${at}`);
    if (completed.has(key)) continue;
    completed.add(key);
    const byModel = Object.entries(u.usage.modelUsage ?? {}) as [string, any][];
    const fallbackModel = starts.findLast((e) => time(e.ts) <= at)?.model_id ?? summary.current_model_id ?? "unknown";
    const modelUsages = (byModel.length ? byModel : [[fallbackModel, u.usage]] as [string, any][]).map(([name, measure]) => ({ provider: "xai", model: model(name), callCount: measure.modelCalls ?? 1, usage: usageOf(measure) }));
    const first = modelUsages[0];
    const observations = updates.filter((item) => item.at >= turn.startedAt && item.at <= at && typeof item.meta?.totalTokens === "number");
    const largest = observations.reduce((best, item) => item.meta.totalTokens > (best?.meta.totalTokens ?? -1) ? item : best, undefined as typeof observations[number] | undefined);
    const estimate = largest ? { tokens: largest.meta.totalTokens, at: largest.at } : null;
    session.modelCalls.push({ kind: "turn_aggregate", id: key, threadId: id, turnId: turn?.id ?? null,
      provider: "xai", model: first.model, effort: summary.reasoning_effort ?? null,
      startedAt: turn?.startedAt ?? null, startInferred: true, endedAt: at,
      usage: usageOf(u.usage), stopReason: u.stop_reason ?? null, purpose: "turn",
      reportedCostUsd: (u.usage.costUsdTicks ?? 0) / 1e10,
      callCount: u.usage.modelCalls ?? modelUsages.reduce((n, m) => n + m.callCount, 0),
      apiDurationMs: u.usage.apiDurationMs ?? 0, contextObservation: estimate, modelUsages });
  }
  // Signals are a session snapshot. They remain an estimate even when only one turn exists.
  if (session.modelCalls.length === 1 && Number.isFinite(signals.contextTokensUsed)) {
    const call = session.modelCalls[0];
    if (call.kind === "turn_aggregate") call.contextObservation = { tokens: signals.contextTokensUsed, at: time(summary.updated_at ?? new Date(call.endedAt).toISOString()) };
  }
  session.reportedCostUsd = session.modelCalls.length ? session.modelCalls.reduce((n, c) => n + (c.reportedCostUsd ?? 0), 0) : null;

  const children = new Set(updates.filter((r) => r.update.sessionUpdate === "subagent_spawned").map((r) => r.update.child_session_id));
  const tools = new Map<string, ToolCall>();
  for (const r of updates) {
    const u = r.update, at = r.at, callId = u.toolCallId;
    if (!callId || !["tool_call", "tool_call_update"].includes(u.sessionUpdate)) continue;
    const name = u._meta?.["x.ai/tool"]?.name ?? u.title ?? "unknown";
    const command = u.rawInput?.command ?? null;
    let tool = tools.get(callId);
    if (!tool) {
      tool = { id: callId, threadId: id, turnId: turnAt(at)?.id ?? null, name,
        category: CATEGORIES[name] ?? toolCategory(name),
        shellCategory: command ? shellCategory(command) : null, command,
        origin: "model", startedAt: at, endedAt: null, status: "unknown", spawnsThreadId: null,
        paths: [], lines: null, web: webUse(name, u.rawInput), ...UNKNOWN_SIZE };
      tools.set(callId, tool);
      session.toolCalls.push(tool);
    }
    if (command && !tool.command) { tool.command = command; tool.shellCategory = shellCategory(command); }
    if (u.rawInput && Object.keys(u.rawInput).length && !tool.paths.length) {
      const web = tool.web;
      Object.assign(tool, toolTarget(u.rawInput, tool.command, name));
      if (web?.target && !tool.web?.target) tool.web = web;
    }
    // The backend web search names its query only in the update that completes it.
    const query = u.rawOutput?.action?.query;
    if (tool.web && typeof query === "string" && query) tool.web = { action: "search", target: query };
    if (u.content) Object.assign(tool, resultSize((Array.isArray(u.content) ? u.content : []).map((c: any) => c?.content ?? c), counts));
    // One tool waits on both background commands and subagents; only a spawned child makes it a subagent wait.
    const taskIds = u.rawInput?.task_ids;
    if (name === "get_command_or_subagent_output" && Array.isArray(taskIds)) tool.category = taskIds.some((t) => children.has(t)) ? "agent" : "shell";
    const status = r.meta?.updateParams?.status;
    if (status === "Completed" || status === "Failed") {
      tool.endedAt = at;
      tool.status = status === "Completed" ? "ok" : "failed";
    }
    const skill = skillFromPath(JSON.stringify(u.rawInput ?? {}));
    if (skill && !session.skills.some((s) => s.turnId === tool.turnId && s.skill === skill)) session.skills.push({ turnId: tool.turnId, threadId: id, skill, mechanism: "file_read" });
  }
  for (const e of events.filter((e) => e.type === "tool_completed" && e.tool_call_id)) {
    const tool = tools.get(e.tool_call_id);
    if (tool) { tool.endedAt = time(e.ts); tool.status = e.outcome === "success" ? "ok" : "failed"; }
  }
  const reply = history.filter((r) => r.type === "assistant" && typeof r.content === "string").at(-1)?.content;
  session.result = reply ? resultFromReply(reply) : null;
  return session;
}
