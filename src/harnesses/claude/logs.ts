// Claude Code logs: ~/.claude/projects/<project>/<session>.jsonl, with
// subagents in <session>/subagents/agent-<id>.jsonl and agent-<id>.meta.json.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { classifyApiError, shellCategory, toolCategory } from "../../catalog.ts";
import { emptySession, type ModelCall, type Session, type ToolCall, type Turn } from "../../model.ts";
import { type LoadOptions, type SessionRef, archiveDir, cachedByRoots, resultFromReply, skillFromPath, resultSize, toolTarget, UNKNOWN_SIZE, turnTriggerFromText, unionFiles } from "../common/logs.ts";

export const CLAUDE_LIVE = join(homedir(), ".claude", "projects");
const CLAUDE_JOBS = join(homedir(), ".claude", "jobs");
export const claudeRoots = () => [CLAUDE_LIVE, archiveDir("claude")];
export const isClaudeLog = (rel: string) => rel.endsWith(".jsonl") || rel.endsWith(".meta.json");

const claudeIndex = cachedByRoots((roots) => unionFiles(roots, isClaudeLog));

// Job ids are aliases for the transcript named by state.json.
export function findClaudeJobs(prefix: string, roots?: string[]): string[] {
  const dirs = roots ? roots.map((root) => join(root, "jobs")) : [CLAUDE_JOBS];
  return dirs.flatMap((dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => {
      const state = join(dir, entry.name, "state.json");
      if (!existsSync(state)) throw new Error(`Claude Code job ${entry.name} has no state.json`);
      const id = JSON.parse(readFileSync(state, "utf8")).resumeSessionId;
      if (typeof id !== "string" || !id) throw new Error(`Claude Code job ${entry.name} has no resumeSessionId`);
      return id;
    }) : []);
}

// Root session files sit directly in a project directory.
export function listClaude(roots = claudeRoots()): SessionRef[] {
  return [...claudeIndex(roots, true)]
    .filter(([rel]) => rel.split(sep).length === 2 && rel.endsWith(".jsonl"))
    .map(([rel, file]) => ({ ref: file, id: basename(rel, ".jsonl"), updatedAt: statSync(file).mtimeMs }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

// The root file's path relative to its root, e.g. <project>/<session>.jsonl.
function findClaudeSession(idOrPath: string, roots: string[]): string {
  for (const [rel, file] of claudeIndex(roots)) {
    if (file === idOrPath || (rel.split(sep).length === 2 && basename(rel) === `${idOrPath}.jsonl`)) return rel;
  }
  throw new Error(`no Claude Code session matches ${idOrPath}`);
}

// Root and subagent files of one session: [relative path, file].
export function sessionFiles(idOrPath: string, roots: string[]): [string, string][] {
  const index = claudeIndex(roots);
  const rootRel = findClaudeSession(idOrPath, roots);
  const subPrefix = join(rootRel.replace(/\.jsonl$/, ""), "subagents") + sep;
  return [[rootRel, index.get(rootRel)!], ...[...index].filter(([rel]) => rel.startsWith(subPrefix)).sort()];
}

export function readRecords(file: string): any[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Claude Code injects a slash-invoked skill's body as a meta message starting with this.
const SKILL_BODY = "Base directory for this skill:";

export function loadClaude(idOrPath: string, roots = claudeRoots(), { counts = false }: LoadOptions = {}): Session {
  const files = new Map(sessionFiles(idOrPath, roots));
  const [rootRel] = files.keys();
  const sessionId = basename(rootRel, ".jsonl");
  const session = emptySession("claude-code", sessionId);
  const threadFiles: { file: string; threadId: string }[] = [{ file: files.get(rootRel)!, threadId: sessionId }];
  session.threads.push({ id: sessionId, parentId: null, name: null, agentType: null, spawnedByToolCallId: null });

  for (const [rel, file] of files) {
    if (rel === rootRel || !rel.endsWith(".jsonl")) continue;
    const agentId = basename(rel, ".jsonl").replace(/^agent-/, "");
    const metaFile = files.get(rel.replace(/\.jsonl$/, ".meta.json"));
    const meta = metaFile ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
    session.threads.push({
      id: agentId,
      parentId: sessionId,
      name: [meta.agentType, meta.description].filter(Boolean).join(": ") || null,
      agentType: meta.agentType || null,
      spawnedByToolCallId: meta.toolUseId ?? null,
    });
    threadFiles.push({ file, threadId: agentId });
  }
  const threadBySpawnCall = new Map(
    session.threads.filter((t) => t.spawnedByToolCallId).map((t) => [t.spawnedByToolCallId!, t.id]),
  );

  for (const { file, threadId } of threadFiles) {
    const isSubagent = threadId !== sessionId;
    let turn: Turn | null = null;
    let boundary: number | null = null;
    let pendingCommand: string | null = null;
    const calls = new Map<string, ModelCall>();
    const tools = new Map<string, ToolCall>();
    const replyBlocks = new Map<string, Map<number, string>>();
    let lastModel: string | null = null;

    for (const r of readRecords(file)) {
      const at = r.timestamp ? Date.parse(r.timestamp) : null;
      if (!isSubagent && !session.startGit && at !== null) {
        session.startGit = { ...(typeof r.gitBranch === "string" ? { branch: r.gitBranch } : {}), at };
      }
      if (r.type === "ai-title" && !session.title) session.title = r.aiTitle;
      if (r.type === "custom-title") session.title = r.customTitle;
      if (r.type === "cost-state" && !isSubagent) session.reportedCostUsd = r.totalCostUSD;
      if (r.cwd && !session.cwd) session.cwd = r.cwd;
      if (r.version && !session.harnessVersion) session.harnessVersion = r.version;
      if (at === null) continue;

      if (r.type === "system" && r.subtype === "compact_boundary") {
        const { trigger, preTokens, postTokens } = r.compactMetadata ?? {};
        if (typeof trigger === "string" && Number.isFinite(preTokens) && Number.isFinite(postTokens)) {
          session.modelCalls.push({
            id: r.uuid,
            threadId,
            turnId: turn?.id ?? null,
            provider: "anthropic",
            model: lastModel ?? "unknown",
            effort: null,
            startedAt: null,
            startInferred: false,
            endedAt: at,
            usage: { input: 0, cacheRead: preTokens, cacheWrite: 0, cacheWrite1h: 0, output: postTokens, reasoning: 0 },
            stopReason: null,
            purpose: "compaction",
            reportedCostUsd: null,
            compaction: { trigger, preTokens, postTokens, estimated: true },
          });
        }
        continue;
      }

      if (r.type === "user") {
        const content = r.message?.content;
        const startsTurn =
          (typeof content === "string" && !r.isMeta && !content.startsWith("<local-command")) ||
          (isSubagent && turn === null);
        if (startsTurn) {
          if (!isSubagent) session.result = null;
          const text = typeof content === "string" ? content : content.map((b: any) => b.text ?? "").join("\n");
          // Queued prompts are written out of time order, so never end a turn before it started.
          if (turn && turn.endedAt === null) turn.endedAt = Math.max(turn.startedAt, boundary ?? turn.startedAt);
          turn = {
            // Subagent records repeat the parent's promptId, so scope the id to the thread.
            id: isSubagent ? `${threadId}:${r.uuid}` : (r.promptId ?? r.uuid),
            threadId,
            trigger: isSubagent ? "agent_message" : turnTriggerFromText(text),
            promptText: text.replace(/<\/?command-[a-z]+>/g, " ").trim(),
            startedAt: at,
            endedAt: null,
            outcome: "unknown",
          };
          session.turns.push(turn);
          // A slash command is a skill only when the skill's body follows it;
          // built-in commands such as /model and /clear bring none.
          pendingCommand = /<command-name>\/?([^<]+)<\/command-name>/.exec(text)?.[1] ?? null;
        } else if (r.isMeta && pendingCommand && turn) {
          const text = typeof content === "string" ? content : (content ?? []).map((b: any) => b.text ?? "").join("\n");
          if (text.startsWith(SKILL_BODY)) session.skills.push({ turnId: turn.id, threadId, skill: pendingCommand, mechanism: "command" });
          pendingCommand = null;
        } else if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === "tool_result") {
              const t = tools.get(b.tool_use_id);
              if (t) {
                t.endedAt = at;
                t.status = b.is_error ? "failed" : "ok";
                Object.assign(t, resultSize(b.content, counts));
              }
            } else if (b.type === "text" && String(b.text).startsWith("[Request interrupted by user")) {
              session.incidents.push({ turnId: turn?.id ?? null, threadId, at, kind: "interrupted", detail: null });
              if (turn) {
                turn.outcome = "interrupted";
                turn.endedAt = at;
              }
            }
          }
        }
        boundary = at;
      } else if (r.type === "assistant") {
        const m = r.message;
        if (r.isApiErrorMessage || m.model === "<synthetic>") {
          session.incidents.push({
            turnId: turn?.id ?? null,
            threadId,
            at,
            kind: classifyApiError(String(r.error ?? "")) === "other" ? String(r.error ?? "other") : classifyApiError(String(r.error)),
            detail: r.error ?? null,
          });
          const q = r.quotaLimits;
          const window = { five_hour: 300, seven_day: 10080 }[String(q?.rateLimitType)];
          if (q?.status === "rejected" && window && q.resetsAt) {
            session.quotaReadings.push({ threadId, at, provider: "anthropic", plan: null, windowMinutes: window, usedPercent: 100, resetsAt: q.resetsAt * 1000 });
          }
          continue;
        }
        lastModel = m.model;
        if (!isSubagent) {
          const blocks = replyBlocks.get(m.id) ?? new Map<number, string>();
          for (const [index, block] of (m.content ?? []).entries()) {
            if (block.type === "text") blocks.set(r.apiBlockIndex ?? index, block.text ?? "");
          }
          replyBlocks.set(m.id, blocks);
          if (m.stop_reason === "end_turn") session.result = resultFromReply([...blocks.values()].join("\n"));
        }
        let call = calls.get(m.id);
        if (!call) {
          call = {
            id: m.id,
            threadId,
            turnId: turn?.id ?? null,
            provider: "anthropic",
            model: m.model,
            effort: r.effort ?? null,
            startedAt: boundary,
            startInferred: true,
            endedAt: at,
            usage: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 },
            stopReason: null,
            purpose: "turn",
            reportedCostUsd: null,
          };
          calls.set(m.id, call);
          session.modelCalls.push(call);
        }
        // The last record of a message carries the final usage.
        const u = m.usage ?? {};
        call.endedAt = at;
        call.stopReason = m.stop_reason ?? call.stopReason;
        call.usage = {
          input: u.input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          reasoning: u.output_tokens_details?.thinking_tokens ?? 0,
        };
        for (const b of m.content ?? []) {
          if (b.type !== "tool_use") continue;
          const command = b.name === "Bash" ? String(b.input?.command ?? "") : null;
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
            spawnsThreadId: threadBySpawnCall.get(b.id) ?? null,
            ...toolTarget(b.input, command),
            ...UNKNOWN_SIZE,
          };
          tools.set(b.id, tool);
          session.toolCalls.push(tool);
          if (b.name === "Skill" && b.input?.skill) {
            session.skills.push({ turnId: turn?.id ?? null, threadId, skill: b.input.skill, mechanism: "tool" });
          }
          const skillFile = b.name === "Read" ? skillFromPath(String(b.input?.file_path ?? "")) : null;
          if (skillFile) session.skills.push({ turnId: turn?.id ?? null, threadId, skill: skillFile, mechanism: "file_read" });
        }
      } else if (r.type === "system" && r.subtype === "turn_duration") {
        // A prompt typed while the agent works is queued, so this record can
        // arrive after the next turn started. It closes the latest turn that began before it.
        const closed = session.turns.filter((t) => t.threadId === threadId && t.startedAt <= at).at(-1);
        if (closed) {
          closed.endedAt = at;
          if (closed.outcome === "unknown") closed.outcome = "completed";
        }
      }
    }
    if (turn && turn.endedAt === null) turn.endedAt = Math.max(turn.startedAt, boundary ?? turn.startedAt);
  }
  return session;
}
