// Copilot CLI logs: ~/.copilot/session-state/<session>/events.jsonl, with the
// session name in workspace.yaml. Subagent events sit in the same file and carry
// `agentId`. research/copilot/events-catalog.md lists the event kinds.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { classifyApiError, shellCategory, toolCategory } from "../../catalog.ts";
import { emptySession, emptyUsage, type ModelCall, type Session, type SkillUse, type ToolCall, type Turn, type TurnTrigger, type Usage } from "../../model.ts";
import { type SessionRef, archiveDir, cachedByRoots, type LoadOptions, resultFromReply, resultSize, toolTarget, UNKNOWN_SIZE, type ResultSize } from "../common/logs.ts";

export const COPILOT_LIVE = join(homedir(), ".copilot", "session-state");
export const copilotRoots = () => [COPILOT_LIVE, archiveDir("copilot")];

const FILES = new Set(["events.jsonl", "workspace.yaml"]);
export const isCopilotLog = (rel: string) => rel.split(sep).length === 2 && FILES.has(basename(rel));

// Session directories by id. The first root holding an id wins, so the live
// copy shadows the archived one. Checkpoints and file snapshots stay unread.
const copilotIndex = cachedByRoots((roots) => {
  const out = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const events = join(root, name, "events.jsonl");
      if (!out.has(name) && existsSync(events)) out.set(name, events);
    }
  }
  return out;
});

export function listCopilot(roots = copilotRoots()): SessionRef[] {
  return [...copilotIndex(roots, true)]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, file]) => ({ ref: file, id, updatedAt: statSync(file).mtimeMs }));
}

export function findCopilotSession(idOrPath: string, roots: string[]): string {
  for (const [id, file] of copilotIndex(roots)) if (file === idOrPath || id === idOrPath || id.startsWith(idOrPath)) return file;
  throw new Error(`no Copilot session matches ${idOrPath}`);
}

export function readEvents(file: string): any[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// The session name Copilot generates or the user sets, from workspace.yaml.
function workspaceName(dir: string): string | null {
  const file = join(dir, "workspace.yaml");
  if (!existsSync(file)) return null;
  const value = /^name:[ \t]*(.*)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
  if (!value) return null;
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value.replace(/^'(.*)'$/, "$1").replaceAll("''", "'");
}

// Copilot bills AI credits of one US cent; events count them in nano units.
const nanoAiuToUsd = (n: unknown) => (typeof n === "number" ? n / 1e11 : 0);

// Model usage as `session.shutdown` reports it. `inputTokens` includes cache
// reads and writes. Gemini reports reasoning beside output, the others inside it.
function usageOf(m: any): Usage {
  const u = m?.usage ?? {};
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  const output = u.outputTokens ?? 0;
  return {
    ...emptyUsage(),
    input: m?.tokenDetails?.input?.tokenCount ?? Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output,
    reasoning: Math.min(u.reasoningTokens ?? 0, output),
  };
}

// Skill and instruction text arrives as a user message inside the current
// turn, so it starts none.
function triggerOf(d: any, subagent: boolean): TurnTrigger | null {
  const source: string | undefined = d.source;
  if (source?.startsWith("skill-") || source === "instruction-discovery") return null;
  if (subagent) return "agent_message";
  if (source === "system" || source === "autopilot" || d.isAutopilotContinuation) return "notification";
  if (typeof d.content === "string" && /^\/[a-z][\w-]*(\s|$)/.test(d.content)) return "command";
  return "prompt";
}

// Tools whose `command` argument is a shell command line. `local_shell` runs
// the commands the user types after `!`.
export const SHELLS = new Set(["powershell", "bash", "local_shell"]);

// Events that show the agent still working on the open turn. Session
// lifecycle events such as a later resume or shutdown do not.
const ACTIVITY = /^(assistant|tool|subagent|skill|hook)\.|^abort$|^session\.(error|compaction_complete)$/;

export function loadCopilot(idOrPath: string, roots = copilotRoots(), { counts = false }: LoadOptions = {}): Session {
  const file = findCopilotSession(idOrPath, roots);
  const events = readEvents(file);
  const start = events.find((e) => e.type === "session.start")?.data ?? {};
  const id: string = start.sessionId ?? basename(dirname(file));
  const session = emptySession("copilot", id);
  const context = start.context ?? {};
  session.title = workspaceName(dirname(file));
  session.cwd = context.cwd ?? null;
  session.harnessVersion = start.copilotVersion ?? null;
  const startedAt = Date.parse(start.startTime ?? events[0]?.timestamp);
  if ((context.headCommit || context.branch || context.repository) && Number.isFinite(startedAt)) {
    session.startGit = { ...(context.headCommit ? { commit: context.headCommit } : {}), ...(context.branch ? { branch: context.branch } : {}), ...(context.repository ? { repository: context.repository } : {}), at: startedAt };
  }
  session.threads.push({ id, parentId: null, name: null, agentType: null, spawnedByToolCallId: null });

  const turnOf = new Map<string, Turn>();
  const modelOf = new Map<string, string>([[id, start.selectedModel ?? "unknown"]]);
  const lastAt = new Map<string, number>();
  const pendingSkills: SkillUse[] = [];
  const tools = new Map<string, ToolCall>();
  const skillSizes = new Map<string, ResultSize>();
  const spawns = new Map<string, string>();
  const compacting = new Map<string, number>();
  const awaitingTask = new Set<string>();
  let lastReply: string | null = null;
  let shutdown: { at: number; data: any } | null = null;

  const threadOf = (e: any): string => {
    const threadId: string = e.agentId ?? id;
    if (!session.threads.some((t) => t.id === threadId)) session.threads.push({ id: threadId, parentId: id, name: null, agentType: null, spawnedByToolCallId: null });
    return threadId;
  };

  for (const e of events) {
    const at = Date.parse(e.timestamp);
    const d = e.data ?? {};
    const threadId = threadOf(e);
    const turn = turnOf.get(threadId);
    lastAt.set(threadId, at);
    if (turn && ACTIVITY.test(e.type)) turn.endedAt = at;

    switch (e.type) {
      case "session.model_change":
        if (d.newModel) modelOf.set(threadId, d.newModel);
        break;
      case "subagent.started": {
        const t = session.threads.find((x) => x.id === threadId)!;
        if (d.parentId && d.parentId !== threadId) t.parentId = d.parentId;
        t.name = d.agentDisplayName ?? d.agentName ?? null;
        t.agentType = d.agentName ?? null;
        t.spawnedByToolCallId = d.toolCallId ?? null;
        if (d.toolCallId) spawns.set(d.toolCallId, threadId);
        if (d.model) modelOf.set(threadId, d.model);
        // Older versions log no user message for the subagent's task, so its
        // turn starts here and adopts the message when one follows.
        if (threadId !== id && !turn) {
          const first: Turn = { id: e.id, threadId, model: modelOf.get(threadId) ?? null, trigger: "agent_message", promptText: null, startedAt: at, endedAt: at, outcome: "unknown" };
          session.turns.push(first);
          turnOf.set(threadId, first);
          awaitingTask.add(threadId);
        }
        break;
      }
      case "subagent.failed":
        session.incidents.push({ threadId, turnId: turn?.id ?? null, at, kind: classifyApiError(String(d.error ?? "")), detail: String(d.error ?? "").slice(0, 80) });
        break;
      case "user.message": {
        const trigger = triggerOf(d, threadId !== id);
        if (trigger !== null && turn && awaitingTask.delete(threadId)) {
          turn.promptText = d.content ?? null;
          break;
        }
        awaitingTask.delete(threadId);
        // A message sent while the agent works steers the open turn.
        if (trigger === null || (d.delivery === "steering" && turn?.outcome === "unknown")) {
          if (turn) turn.endedAt = at;
          break;
        }
        const next: Turn = { id: e.id, threadId, model: modelOf.get(threadId) ?? null, trigger, promptText: d.content ?? null, startedAt: at, endedAt: null, outcome: "unknown" };
        session.turns.push(next);
        turnOf.set(threadId, next);
        if (threadId === id) lastReply = null;
        for (let i = pendingSkills.length - 1; i >= 0; i--) {
          if (pendingSkills[i].threadId !== threadId) continue;
          session.skills.push({ ...pendingSkills[i], turnId: next.id });
          pendingSkills.splice(i, 1);
        }
        break;
      }
      case "assistant.turn_start":
        if (turn) turn.outcome = "unknown";
        break;
      case "assistant.turn_end":
        if (turn?.outcome === "unknown") turn.outcome = "completed";
        break;
      case "assistant.message":
        if (d.model) modelOf.set(threadId, d.model);
        if (threadId === id && typeof d.content === "string" && d.content) lastReply = d.content;
        break;
      case "abort":
        if (turn) turn.outcome = "interrupted";
        session.incidents.push({ threadId, turnId: turn?.id ?? null, at, kind: "interrupted", detail: d.reason ?? null });
        break;
      case "session.error": {
        const kind = d.errorType === "quota" ? "usage_limit" : d.errorType === "authorization" ? "unauthorized" : classifyApiError(String(d.message ?? ""), d.statusCode ?? null);
        if (turn) turn.outcome = "error";
        session.incidents.push({ threadId, turnId: turn?.id ?? null, at, kind, detail: String(d.message ?? "").slice(0, 80) });
        break;
      }
      case "skill.invoked":
      case "skill.invoked_ref": {
        if (!d.name) break;
        const use: SkillUse = { threadId, turnId: turn?.id ?? null, skill: d.name, mechanism: d.trigger === "user-invoked" ? "command" : "tool" };
        // A skill the user names is recorded just before the message that names it.
        if (d.trigger === "user-invoked") pendingSkills.push(use);
        else session.skills.push(use);
        // The skill tool's result only confirms the load. This event carries the
        // SKILL.md path, and the text that enters the context unless it is a _ref;
        // the tool's telemetry reports that text's length for both.
        const call = d.trigger === "user-invoked" ? undefined : session.toolCalls.findLast((t) => t.threadId === threadId && t.name === "skill" && !t.paths.length);
        if (call && typeof d.path === "string" && d.path) {
          call.paths = [d.path];
          if (typeof d.content === "string") {
            const size = { ...resultSize(d.content, counts), resultChars: skillSizes.get(call.id)?.resultChars ?? d.content.length };
            skillSizes.set(call.id, size);
            Object.assign(call, size);
          }
        }
        break;
      }
      case "tool.user_requested":
      case "tool.execution_start": {
        if (!d.toolCallId || tools.has(d.toolCallId)) break;
        const name: string = d.toolName ?? "unknown";
        const command = SHELLS.has(name) && typeof d.arguments?.command === "string" ? d.arguments.command : null;
        const tool: ToolCall = {
          id: d.toolCallId,
          threadId,
          turnId: turn?.id ?? null,
          name,
          category: d.mcpServerName ? "mcp" : toolCategory(name),
          shellCategory: command === null ? null : shellCategory(command),
          command,
          origin: e.type === "tool.user_requested" ? "user" : "model",
          startedAt: at,
          endedAt: null,
          status: "unknown",
          spawnsThreadId: null,
          ...toolTarget(d.arguments, command),
          ...UNKNOWN_SIZE,
        };
        tools.set(tool.id, tool);
        session.toolCalls.push(tool);
        break;
      }
      case "tool.execution_complete": {
        const tool = tools.get(d.toolCallId);
        if (!tool) break;
        tool.endedAt = at;
        tool.status = d.success === false ? "failed" : "ok";
        const skillLength = tool.name === "skill" ? d.toolTelemetry?.metrics?.skillContentLength : undefined;
        if (typeof skillLength === "number") skillSizes.set(tool.id, { ...(skillSizes.get(tool.id) ?? UNKNOWN_SIZE), resultChars: skillLength });
        Object.assign(tool, skillSizes.get(tool.id) ?? resultSize(d.result?.content, counts));
        break;
      }
      case "session.compaction_start":
        compacting.set(threadId, at);
        break;
      case "session.compaction_complete":
        if (d.success !== false && Number.isFinite(d.preCompactionTokens) && Number.isFinite(d.postCompactionTokens)) {
          session.compactions.push({ threadId, turnId: turn?.id ?? null, startedAt: compacting.get(threadId) ?? at, endedAt: at, trigger: d.trigger ?? "unknown", preTokens: d.preCompactionTokens, postTokens: d.postCompactionTokens });
        }
        compacting.delete(threadId);
        break;
      case "session.shutdown":
        // Each shutdown repeats the totals of the whole session, resumes included.
        shutdown = { at, data: d };
        break;
    }
  }
  for (const [call, child] of spawns) {
    const tool = tools.get(call);
    if (tool) tool.spawnsThreadId = child;
  }
  session.skills.push(...pendingSkills);
  session.result = lastReply ? resultFromReply(lastReply) : null;
  if (shutdown) session.modelCalls.push(...aggregates(session, shutdown, lastAt));
  session.reportedCostUsd = session.modelCalls.length ? session.modelCalls.reduce((n, c) => n + (c.reportedCostUsd ?? 0), 0) : null;
  return session;
}

// Copilot reports usage per agent and model only at shutdown, so each thread
// gets one aggregate, in its turn when the thread has one turn. Versions before agentMetrics
// report the whole session under the root. A session without a shutdown,
// still running or ended by a crash, has no usage.
function aggregates(session: Session, shutdown: { at: number; data: any }, lastAt: Map<string, number>): ModelCall[] {
  const d = shutdown.data;
  const root = session.id;
  const agents: [string, any][] = d.agentMetrics && Object.keys(d.agentMetrics).length
    ? Object.entries(d.agentMetrics).map(([agent, m]) => [agent === "main" ? root : agent, m])
    : [[root, { modelMetrics: d.modelMetrics, totalApiDurationMs: d.totalApiDurationMs, totalNanoAiu: d.totalNanoAiu }]];
  const out: ModelCall[] = [];
  for (const [threadId, metrics] of agents) {
    const modelUsages = Object.entries<any>(metrics.modelMetrics ?? {})
      .filter(([, m]) => (m.requests?.count ?? 0) > 0)
      .map(([model, m]) => ({ provider: "github-copilot", model, callCount: m.requests.count as number, usage: usageOf(m) }));
    if (!modelUsages.length) continue;
    if (!session.threads.some((t) => t.id === threadId)) session.threads.push({ id: threadId, parentId: root, name: metrics.agentDisplayName ?? metrics.agentName ?? null, agentType: metrics.agentName ?? null, spawnedByToolCallId: null });
    const usage = emptyUsage();
    for (const m of modelUsages) for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += m.usage[k];
    // A thread with one turn spent all its usage in that turn.
    const turns = session.turns.filter((t) => t.threadId === threadId);
    out.push({
      kind: "turn_aggregate",
      id: `${root}:${threadId}`,
      threadId,
      turnId: turns.length === 1 ? turns[0].id : null,
      provider: "github-copilot",
      model: [...modelUsages].sort((a, b) => b.callCount - a.callCount)[0].model,
      effort: null,
      startedAt: turns[0]?.startedAt ?? null,
      startInferred: true,
      endedAt: threadId === root ? shutdown.at : lastAt.get(threadId) ?? shutdown.at,
      usage,
      stopReason: null,
      purpose: "turn",
      reportedCostUsd: nanoAiuToUsd(metrics.totalNanoAiu),
      callCount: modelUsages.reduce((n, m) => n + m.callCount, 0),
      apiDurationMs: metrics.totalApiDurationMs ?? 0,
      contextObservation: threadId === root && Number.isFinite(d.currentTokens) ? { tokens: d.currentTokens, at: shutdown.at } : null,
      modelUsages,
    });
  }
  return out;
}
