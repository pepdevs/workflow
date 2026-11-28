// The only way into harness logs, processes and launches. Each harness lists
// root sessions, loads one session with its subagents, cuts a redacted fixture,
// finds its live processes and launches a fresh headless session. `roots`
// replaces the default of live logs followed by the archive.
import type { Session } from "../model.ts";
import { claudeToken } from "./claude/credentials.ts";
import { cutClaudeFixture, cutClaudeJobFixture } from "./claude/fixture.ts";
import { claudeResult, claudeTrusted, launchClaude, launchClaudeRemote } from "./claude/launch.ts";
import { CLAUDE_LIVE, claudeRemoteState, claudeRoots, findClaudeJobs, isClaudeLog, listClaude, loadClaude } from "./claude/logs.ts";
import { runningClaude } from "./claude/processes.ts";
import { cutCodexFixture } from "./codex/fixture.ts";
import { cutCopilotFixture } from "./copilot/fixture.ts";
import { COPILOT_LIVE, copilotRoots, isCopilotLog, listCopilot, loadCopilot } from "./copilot/logs.ts";
import { codexRateLimits } from "./codex/usage.ts";
import { codexResult, launchCodex } from "./codex/launch.ts";
import { CODEX_LIVE, codexRoots, isCodexLog, listCodex, loadCodex } from "./codex/logs.ts";
import { runningCodex } from "./codex/processes.ts";
import { type Launch, type LaunchOptions, type Remote, type RunResult, readLaunchRecord } from "./common/launch.ts";
import type { LoadOptions, SessionRef } from "./common/logs.ts";
import type { RunningSession } from "./common/processes.ts";
import { cutOpenCodeFixture } from "./opencode/fixture.ts";
import { launchOpenCode, openCodeResult } from "./opencode/launch.ts";
import { listOpenCode, loadOpenCode, openCodeRoots } from "./opencode/logs.ts";
import { runningOpenCode } from "./opencode/processes.ts";
import { cutGrokFixture } from "./grok/fixture.ts";
import { grokResult, launchGrok } from "./grok/launch.ts";
import { GROK_LIVE, grokRoots, isGrokLog, listGrok, loadGrok } from "./grok/logs.ts";
import { runningGrok } from "./grok/processes.ts";
import { piApiKey, piBearerToken } from "./pi/credentials.ts";
import { cutPiFixture } from "./pi/fixture.ts";
import { launchPi, piResult } from "./pi/launch.ts";
import { isPiLog, listPi, loadPi, PI_LIVE, piRoots } from "./pi/logs.ts";
import { runningPi } from "./pi/processes.ts";

export { ARCHIVE_ROOT, lineRange, resultFromReply, shellReads, skillFromPath, turnTriggerFromText, unionFiles, type SessionRef } from "./common/logs.ts";
export { findClaudeJobs };
export { spawnedId as grokSpawnedId } from "./grok/logs.ts";
export { unquoteRunPrompt } from "./opencode/logs.ts";
export { cutClaudeJobFixture };
export { descendants, onlyWrittenSince, type RunningSession } from "./common/processes.ts";
export { UNITS, unitOf, writeLaunchRecord, type Launch, type LaunchOptions, type Remote, type RemoteOptions, type RemoteState, type RunResult } from "./common/launch.ts";

export type Adapter = {
  defaultRoots: () => string[];
  list: (roots?: string[]) => SessionRef[];
  // `counts` adds lines and words to each tool result; only `workflow files` shows them.
  load: (idOrPath: string, roots?: string[], options?: LoadOptions) => Session;
  cutFixture: (idOrPath: string, outDir: string, roots?: string[], options?: { omitSignals?: boolean; children?: string[]; launchResult?: { prompt: string; reply: string } }) => void;
  // Live log directory and the files `workflow archive` copies from it.
  // OpenCode keeps sessions in its database until the user deletes them.
  archive: { live: string; include: (rel: string) => boolean } | null;
  // Live harness processes and the root session each one writes.
  // Strict scans throw when an inventory cannot establish session absence.
  running: (strict?: boolean) => RunningSession[];
  // The command line of a fresh headless session, and what its output says.
  launch: (o: LaunchOptions) => Launch;
  result: (stdout: string) => RunResult;
  // An interactive session with Remote Control in its own user unit, where the
  // harness has one; `wf run --remote-control` starts it and returns.
  remote: Remote | null;
  // Whether `wf run --add-dir` reaches the harness; the others refuse the flag.
  addDir: boolean;
  // Folders the harness reads skills from or keeps a session's files in, as
  // alias patterns: `~` is the home folder, `*` one folder, `{session}` the id.
  pathAliases: Record<string, string[]>;
};

// A session `wf run --remote-control` started carries no launch header; its
// launch facts come from the record `wf run` wrote for it.
const withLaunchRecord = (harness: string, load: Adapter["load"]): Adapter["load"] => (idOrPath, roots, options) => {
  const s = load(idOrPath, roots, options);
  const launchRecord = readLaunchRecord(harness, s.id);
  return launchRecord ? { ...s, launchRecord } : s;
};

const readOnly = (): never => {
  throw new Error("workflow reads Copilot sessions but does not launch them");
};

export const ADAPTERS = {
  codex: { defaultRoots: codexRoots, list: listCodex, load: withLaunchRecord("codex", loadCodex), cutFixture: cutCodexFixture, archive: { live: CODEX_LIVE, include: isCodexLog }, running: runningCodex, launch: launchCodex, result: codexResult, remote: null, addDir: true, pathAliases: { $skills: ["~/.codex/skills", "~/.agents/skills"] } },
  claude: { defaultRoots: claudeRoots, list: listClaude, load: withLaunchRecord("claude", loadClaude), cutFixture: cutClaudeFixture, archive: { live: CLAUDE_LIVE, include: isClaudeLog }, running: runningClaude, launch: launchClaude, result: claudeResult, remote: { launch: launchClaudeRemote, state: claudeRemoteState, trusted: claudeTrusted }, addDir: true, pathAliases: { $skills: ["~/.claude/skills"], $session: ["/tmp/claude-*/*/{session}"] } },
  pi: { defaultRoots: piRoots, list: listPi, load: withLaunchRecord("pi", loadPi), cutFixture: cutPiFixture, archive: { live: PI_LIVE, include: isPiLog }, running: runningPi, launch: launchPi, result: piResult, remote: null, addDir: false, pathAliases: { $skills: ["~/.pi/agent/skills", "~/.agents/skills"] } },
  grok: { defaultRoots: grokRoots, list: listGrok, load: withLaunchRecord("grok", loadGrok), cutFixture: cutGrokFixture, archive: { live: GROK_LIVE, include: isGrokLog }, running: runningGrok, launch: launchGrok, result: grokResult, remote: null, addDir: false, pathAliases: { $skills: ["~/.grok/bundled/skills", "~/.grok/skills", "~/.agents/skills"] } },
  opencode: { defaultRoots: openCodeRoots, list: listOpenCode, load: withLaunchRecord("opencode", loadOpenCode), cutFixture: cutOpenCodeFixture, archive: null, running: runningOpenCode, launch: launchOpenCode, result: openCodeResult, remote: null, addDir: false, pathAliases: { $skills: ["~/.config/opencode/skills", "~/.agents/skills"] } },
  // Copilot sessions are read only: workflow neither finds its processes nor launches it.
  copilot: { defaultRoots: copilotRoots, list: listCopilot, load: withLaunchRecord("copilot", loadCopilot), cutFixture: cutCopilotFixture, archive: { live: COPILOT_LIVE, include: isCopilotLog }, running: () => [], launch: readOnly, result: readOnly, remote: null, addDir: false, pathAliases: { $skills: ["~/.copilot/skills", "~/.agents/skills"], $session: ["~/.copilot/session-state/{session}"] } },
} satisfies Record<string, Adapter>;

// Logins the harnesses hold, for reading plan usage from the providers. Codex
// answers with its own rate limits; the others hand over a credential.
export const LOGINS = { claudeToken, codexRateLimits, piApiKey, piBearerToken };

export type HarnessName = keyof typeof ADAPTERS;
export const HARNESS_NAMES = Object.keys(ADAPTERS) as HarnessName[];
export const isHarnessName = (name: string): name is HarnessName => name in ADAPTERS;
