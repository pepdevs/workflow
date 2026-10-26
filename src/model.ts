// Unified session model from research/unified-model.md, as plain data.
// Times are epoch milliseconds. Output tokens include reasoning tokens.

export type Harness = "codex" | "claude-code" | "pi" | "opencode" | "grok" | "copilot";

export type Usage = {
  input: number; // uncached input
  cacheRead: number;
  cacheWrite: number; // all cache writes, one-hour writes included
  cacheWrite1h: number;
  output: number;
  reasoning: number;
};

export type Thread = {
  id: string;
  parentId: string | null;
  name: string | null;
  // The kind of agent the harness ran in a subagent thread, such as code-review.
  agentType: string | null;
  spawnedByToolCallId: string | null;
};

export type TurnTrigger = "prompt" | "command" | "notification" | "agent_message";

export type Turn = {
  id: string;
  threadId: string;
  model?: string | null;
  trigger: TurnTrigger;
  promptText: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: "completed" | "interrupted" | "error" | "unknown";
};

// Model names a harness reader writes when its log names no model: Codex, Claude
// and Copilot calls before a model is known, and Pi's compaction calls.
export const UNNAMED_MODELS: ReadonlySet<string> = new Set(["unknown", "compaction"]);

type Measurement = {
  id: string;
  threadId: string;
  turnId: string | null;
  provider: string;
  model: string;
  effort: string | null;
  startedAt: number | null;
  startInferred: boolean;
  endedAt: number;
  usage: Usage;
  stopReason: string | null;
  purpose: "turn" | "compaction";
  reportedCostUsd: number | null;
  compaction?: { trigger: string; preTokens: number; postTokens: number; estimated: boolean };
};

export type ModelCall = Measurement & (
  | { kind?: "call" }
  | {
      kind: "turn_aggregate";
      purpose: "turn";
      compaction?: never;
      callCount: number;
      apiDurationMs: number;
      // Each call's duration when the harness logs call endpoints apart from the totals.
      callDurationsMs?: number[];
      contextObservation: { tokens: number; at: number } | null;
      modelUsages: { provider: string; model: string; callCount: number; usage: Usage }[];
      reportedCostUsd: number;
    }
);

export type ToolCall = {
  id: string;
  threadId: string;
  turnId: string | null;
  name: string;
  category: string;
  shellCategory: string | null;
  command: string | null;
  origin: "model" | "user";
  startedAt: number | null;
  endedAt: number | null;
  status: "ok" | "failed" | "unknown";
  spawnsThreadId: string | null;
  // Files or folders the call read, searched or changed, as the harness logged them.
  paths: string[];
  // The line range a read asked for, such as `80-199`, or null for the whole file.
  lines: string | null;
  // For a web call, what it did and the query, URL or pattern it named; null for other calls.
  web: WebUse | null;
  // Characters of text the call returned to the model; null when the log keeps none.
  resultChars: number | null;
  // Lines and words of that text, without line numbers a read tool added; null
  // when unknown or when the load did not ask for counts.
  resultLines: number | null;
  resultWords: number | null;
};

// A search, a page opened, a find inside an opened page, or an action the log names no further.
export type WebAction = "search" | "open" | "find" | "other";

export type WebUse = { action: WebAction; target: string | null };

export type SkillUse = {
  turnId: string | null;
  threadId: string;
  skill: string;
  mechanism: "tool" | "mention" | "command" | "file_read";
};

export type Incident = {
  turnId: string | null;
  threadId: string;
  at: number;
  kind: string;
  detail: string | null;
};

export type CompactionEvent = {
  threadId: string;
  turnId: string | null;
  startedAt: number;
  endedAt: number;
  trigger: string;
  preTokens: number;
  postTokens: number;
};

// A harness report of subscription quota: the share of a limit window used,
// and when that window resets. A limit hit reports 100.
export type QuotaReading = {
  threadId: string;
  at: number;
  provider: string;
  plan: string | null;
  windowMinutes: number;
  usedPercent: number;
  resetsAt: number;
};

export type SessionResult = {
  status: "complete" | "checkpoint" | "blocked";
  pullRequest: string | null;
  headSha: string | null;
};

export type Session = {
  harness: Harness;
  id: string;
  title: string | null;
  cwd: string | null;
  // repository is the remote URL or owner/name a harness logs at start, when it logs one.
  startGit?: { commit?: string; branch?: string; repository?: string; at: number };
  // Every branch the root thread's records name, in order of first appearance,
  // for a harness that logs the branch on each record.
  branches?: string[];
  harnessVersion: string | null;
  threads: Thread[];
  turns: Turn[];
  modelCalls: ModelCall[];
  toolCalls: ToolCall[];
  skills: SkillUse[];
  incidents: Incident[];
  compactions: CompactionEvent[];
  quotaReadings: QuotaReading[];
  reportedCostUsd: number | null;
  result?: SessionResult | null;
};

export const emptyUsage = (): Usage => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  output: 0,
  reasoning: 0,
});

export function emptySession(harness: Harness, id: string): Session {
  return {
    harness,
    id,
    title: null,
    cwd: null,
    harnessVersion: null,
    threads: [],
    turns: [],
    modelCalls: [],
    toolCalls: [],
    skills: [],
    incidents: [],
    compactions: [],
    quotaReadings: [],
    reportedCostUsd: null,
    result: null,
  };
}
