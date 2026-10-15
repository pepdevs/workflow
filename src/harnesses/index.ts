// The only way into harness logs, processes and launches. Each harness lists
// root sessions, loads one session with its subagents, cuts a redacted fixture,
// finds its live processes and launches a fresh headless session. `roots`
// replaces the default of live logs followed by the archive.
import type { Session } from "../model.ts";
import { claudeToken } from "./claude/credentials.ts";
import { cutClaudeFixture, cutClaudeJobFixture } from "./claude/fixture.ts";
import { claudeResult, launchClaude } from "./claude/launch.ts";
import { CLAUDE_LIVE, claudeRoots, findClaudeJobs, isClaudeLog, listClaude, loadClaude } from "./claude/logs.ts";
import { runningClaude } from "./claude/processes.ts";
import { cutCodexFixture } from "./codex/fixture.ts";
import { cutCopilotFixture } from "./copilot/fixture.ts";
import { COPILOT_LIVE, copilotRoots, isCopilotLog, listCopilot, loadCopilot } from "./copilot/logs.ts";
import { codexRateLimits } from "./codex/usage.ts";
import { codexResult, launchCodex } from "./codex/launch.ts";
import { CODEX_LIVE, codexRoots, isCodexLog, listCodex, loadCodex } from "./codex/logs.ts";
import { runningCodex } from "./codex/processes.ts";
import type { Launch, LaunchOptions, RunResult } from "./common/launch.ts";
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
export { cutClaudeJobFixture };
export { descendants, onlyWrittenSince, type RunningSession } from "./common/processes.ts";
export type { Launch, LaunchOptions, RunResult } from "./common/launch.ts";

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
  // Folders the harness reads skills from or keeps a session's files in, as
  // alias patterns: `~` is the home folder, `*` one folder, `{session}` the id.
  pathAliases: Record<string, string[]>;
};

const readOnly = (): never => {
  throw new Error("workflow reads Copilot sessions but does not launch them");
};

export const ADAPTERS = {
  codex: { defaultRoots: codexRoots, list: listCodex, load: loadCodex, cutFixture: cutCodexFixture, archive: { live: CODEX_LIVE, include: isCodexLog }, running: runningCodex, launch: launchCodex, result: codexResult, pathAliases: { $skills: ["~/.codex/skills", "~/.agents/skills"] } },
  claude: { defaultRoots: claudeRoots, list: listClaude, load: loadClaude, cutFixture: cutClaudeFixture, archive: { live: CLAUDE_LIVE, include: isClaudeLog }, running: runningClaude, launch: launchClaude, result: claudeResult, pathAliases: { $skills: ["~/.claude/skills"], $session: ["/tmp/claude-*/*/{session}"] } },
  pi: { defaultRoots: piRoots, list: listPi, load: loadPi, cutFixture: cutPiFixture, archive: { live: PI_LIVE, include: isPiLog }, running: runningPi, launch: launchPi, result: piResult, pathAliases: { $skills: ["~/.pi/agent/skills", "~/.agents/skills"] } },
  grok: { defaultRoots: grokRoots, list: listGrok, load: loadGrok, cutFixture: cutGrokFixture, archive: { live: GROK_LIVE, include: isGrokLog }, running: runningGrok, launch: launchGrok, result: grokResult, pathAliases: { $skills: ["~/.grok/bundled/skills", "~/.grok/skills", "~/.agents/skills"] } },
  opencode: { defaultRoots: openCodeRoots, list: listOpenCode, load: loadOpenCode, cutFixture: cutOpenCodeFixture, archive: null, running: runningOpenCode, launch: launchOpenCode, result: openCodeResult, pathAliases: { $skills: ["~/.config/opencode/skills", "~/.agents/skills"] } },
  // Copilot sessions are read only: workflow neither finds its processes nor launches it.
  copilot: { defaultRoots: copilotRoots, list: listCopilot, load: loadCopilot, cutFixture: cutCopilotFixture, archive: { live: COPILOT_LIVE, include: isCopilotLog }, running: () => [], launch: readOnly, result: readOnly, pathAliases: { $skills: ["~/.copilot/skills", "~/.agents/skills"], $session: ["~/.copilot/session-state/{session}"] } },
} satisfies Record<string, Adapter>;

// Logins the harnesses hold, for reading plan usage from the providers. Codex
// answers with its own rate limits; the others hand over a credential.
export const LOGINS = { claudeToken, codexRateLimits, piApiKey, piBearerToken };

export type HarnessName = keyof typeof ADAPTERS;
export const HARNESS_NAMES = Object.keys(ADAPTERS) as HarnessName[];
export const isHarnessName = (name: string): name is HarnessName => name in ADAPTERS;
