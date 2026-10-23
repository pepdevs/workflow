#!/usr/bin/env node
// CLI over the unified session model: argument parsing and dispatch to src/commands/.
// Usage: wf help, or node src/cli.ts help. `npm run setup` links `wf` to this file.
import { ADAPTERS, isHarnessName } from "./harnesses/index.ts";
import { type QuotaReading, type Session } from "./model.ts";
import { archiveCommand } from "./commands/archive.ts";
import { DAY, type Range, findByPrefix, loadAll, parseAt, parseWhen } from "./commands/find.ts";
import { modelsCommand } from "./commands/models.ts";
import { routeCommand } from "./commands/route.ts";
import { usageCommand, usageJson } from "./commands/usage.ts";
import { READINGS_FILE, readUsage, recordUsage, recordedReadings, type PlanUsage } from "./providers/index.ts";
import { parseRunCompletion, runCommand } from "./commands/run.ts";
import { filesCommand } from "./commands/files.ts";
import { costCommand, lsCommand, summary, timeCommand, toolsCommand, turnsCommand } from "./commands/sessions.ts";
import { statusCommand } from "./commands/status.ts";
import { commandHelp, helpText } from "./commands/help.ts";
import { planCommand } from "./commands/plan.ts";
import { changesCommand } from "./commands/changes.ts";
import { exportCommand, promptsCommand } from "./commands/export.ts";
import { webCommand, webJson } from "./commands/web.ts";
import { stopCommand } from "./commands/stop.ts";
import { repoCommand } from "./commands/repo.ts";
import { subscriptionsCommand, weeklySpend } from "./commands/subscriptions.ts";

// Pure functions the table tests reach through this entry point.
export { usd, eur, dur, table } from "./commands/format.ts";
export { parseAmount, parseAt, parseWhen } from "./commands/find.ts";
export { parseChatGptUsage, parseClaudeUsage, parseCodexRateLimits, parseXaiBilling, parseZaiQuota } from "./providers/index.ts";
export { modelRows, modelTable, routeCounts } from "./commands/models.ts";
export { parseRouteEntry, routesFrom } from "./commands/route.ts";
export { summary, costCommand, turnsCommand, timeCommand } from "./commands/sessions.ts";
export { filesCommand } from "./commands/files.ts";
export { readGithubEvaluations } from "./providers/github.ts";
export { rankRoutes } from "./commands/route.ts";
export { usageCommand, usageJson, windowPace } from "./commands/usage.ts";
export { stepSpans, windowProjection } from "./commands/subscriptions.ts";
export { changedLines, parseReadings, readingLines } from "./providers/index.ts";
export { planMatches } from "./commands/plan.ts";
export { gitLaunchInfo, parentFromEnv, repoFromRemote, parseRunCompletion } from "./commands/run.ts";
export { sessionStatus, statusPresentation, subagentStatus } from "./commands/status.ts";
export { launchHeader, launchOf } from "./facts.ts";
export { categoryOf } from "./repos/index.ts";
export { sessionProvenance } from "./repos/provenance.ts";

const FLAGS = new Set(["d", "m", "c", "p", "s", "n", "a", "w", "i", "k", "r", "e", "x"]);

// Splits `-xVALUE` and `-x VALUE` flags from positional arguments.
function parseFlags(args: string[]): { words: string[]; flags: Record<string, string> } {
  const words: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^-([a-z])(.*)$/.exec(args[i]);
    if (!m || !FLAGS.has(m[1])) {
      words.push(args[i]);
      continue;
    }
    const value = m[2] || args[++i];
    if (value === undefined) throw new Error(`-${m[1]} needs a value`);
    flags[m[1]] = value;
  }
  return { words, flags };
}

const COMMANDS: Record<string, (s: Session) => string> = {
  summary,
  turns: turnsCommand,
  cost: costCommand,
  tools: toolsCommand,
  time: timeCommand,
  files: filesCommand,
  stop: stopCommand,
};

const ALL_SESSION_COMMANDS: Record<string, (s: Session[], when: Range, recorded: QuotaReading[], flags: Record<string, string>) => string> = {
  subscriptions: subscriptionsCommand,
};

// Every command name, for the use case check in test/golden.test.ts.
export const COMMAND_NAMES = ["ls", "status", "route", "models", "usage", "run", "plan", "export", "prompts", "changes", "web", "repo", ...Object.keys(COMMANDS), ...Object.keys(ALL_SESSION_COMMANDS), "archive"];

export const USAGE = helpText();

// Splits `--root <path>` options from positional arguments.
export function parseRoots(argv: string[]): { args: string[]; roots: string[] | undefined } {
  const args: string[] = [];
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1] !== undefined) roots.push(argv[++i]);
    else args.push(argv[i]);
  }
  return { args, roots: roots.length ? roots : undefined };
}

// Records what the providers reported, then passes it on.
const recorded = (now: number) => (usage: PlanUsage[]) => {
  recordUsage(usage, now);
  return usage;
};

// Output of one command or the help text. Throws with the help text on bad
// arguments. `now` sets the end of relative `-d` windows.
// `usage`, `route` and `models` with implement sessions on default logs read providers
// and return a promise. Commands with custom log roots read only local files.
export function run(argv: string[], now = Date.now(), report?: (output: string) => void): string | Promise<string> {
  const { args: parsed, roots } = parseRoots(argv);
  const withSize = parsed.includes("--size") && (parsed[0] === "ls" || parsed[0] === "summary" || parsed[0] === "models");
  const args = withSize ? parsed.filter((arg) => arg !== "--size") : parsed;
  const [command, harness, id] = args;
  const base = (roots?.length ?? 1) === 1 ? roots?.[0] : null;
  if (args.length === 0 || command === "--help" || command === "-h") return USAGE;
  if (command === "help") return args.length === 1 ? USAGE : commandHelp(args[1]);
  if (args.includes("-h") || args.includes("--help") || args[1] === "help") return commandHelp(command);
  if (command === "archive" && args.length === 1) return archiveCommand();
  if (command === "repo") return repoCommand(args.slice(1));
  if (command === "run" && roots === undefined) {
    const write = args.includes("--write");
    const options: Record<string, string> = {};
    const remaining: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (["--plan", "--done-file", "--done-command", "--max-attempts"].includes(arg)) {
        const value = args[++i];
        if (!value || value.startsWith("-") || options[arg.slice(2)] !== undefined) throw new Error(commandHelp(command));
        options[arg.slice(2)] = value;
      } else if (arg !== "--write") remaining.push(arg);
    }
    const { words, flags } = parseFlags(remaining);
    const [h, model, ...rest] = words;
    if (!h || !isHarnessName(h) || !model || rest.length || Object.keys(flags).some((f) => !["i", "k", "r", "p", "e"].includes(f)) || (flags.k && flags.r)) throw new Error(commandHelp(command));
    return runCommand(h, model, flags, write, options.plan ?? null, parseRunCompletion(options), report);
  }
  if (command === "route" && base !== null) {
    const { words, flags } = parseFlags(args.slice(1));
    if (words.length !== 1 || Object.keys(flags).some((f) => f !== "d" && f !== "x")) throw new Error(commandHelp(command));
    if (base === undefined) return readUsage(now).then(recorded(now)).then((usage) => routeCommand(words[0], flags, base, now, usage));
    return routeCommand(words[0], flags, base, now, null);
  }
  if (command === "plan" && base !== null) {
    const { words, flags } = parseFlags(args.slice(1));
    if (words.length !== 1 || Object.keys(flags).some((f) => f !== "d")) throw new Error(commandHelp(command));
    return planCommand(words[0], flags, base, now);
  }
  if (command === "export" && base !== null) {
    const { words, flags } = parseFlags(args.slice(1));
    if (words.length || Object.keys(flags).some((f) => f !== "d")) throw new Error(commandHelp(command));
    return exportCommand(flags, base, now);
  }
  if (command === "prompts" && base !== null) {
    const { words, flags } = parseFlags(args.slice(1));
    if (words.length || Object.keys(flags).some((f) => f !== "d")) throw new Error(commandHelp(command));
    return promptsCommand(flags, base, now);
  }
  if (command === "web" && base !== null) {
    const asJson = args.includes("--json");
    const { words, flags } = parseFlags(args.slice(1).filter((a) => a !== "--json"));
    if (words.length || Object.keys(flags).some((f) => f !== "d")) throw new Error(commandHelp(command));
    return (asJson ? webJson : webCommand)(flags, base, now);
  }
  if (command === "changes" && roots === undefined) {
    const { words, flags } = parseFlags(args.slice(1));
    if (Object.keys(flags).some((f) => f !== "d")) throw new Error(commandHelp(command));
    return changesCommand(flags, words, now);
  }
  if (command === "models" && base !== null) {
    const { words, flags } = parseFlags(args.slice(1));
    if (words.length || Object.keys(flags).some((f) => f !== "d" && f !== "k")) throw new Error(commandHelp(command));
    return modelsCommand(flags, base, now, withSize);
  }
  if (command === "usage" && roots === undefined) {
    const withValue = args.includes("--value");
    const asJson = args.includes("--json");
    const { words, flags } = parseFlags(args.slice(1).filter((a) => a !== "--value" && a !== "--json"));
    if (words.length || Object.keys(flags).some((f) => f !== "w") || (asJson && (withValue || flags.w))) throw new Error(commandHelp(command));
    if (asJson) return readUsage(now).then(recorded(now)).then((usage) => usageJson(usage, now));
    // A weekly window started at most 7 days ago; sessions updated since then hold its calls.
    // Reading them takes seconds, so the value columns wait for --value.
    return readUsage(now).then(recorded(now)).then((usage) => usageCommand(usage, flags, now, withValue ? weeklySpend(loadAll(undefined, now - 7 * DAY), usage) : null));
  }
  if (command === "status" && base !== null) {
    const { words, flags } = parseFlags(args.slice(1));
    if (words.length || Object.keys(flags).some((f) => f !== "a" && f !== "w")) throw new Error(commandHelp(command));
    return statusCommand(flags, base, now);
  }
  if (command === "ls" && base !== null) {
    const { words, flags } = parseFlags(args.slice(1));
    return lsCommand(words, flags, base, now, withSize);
  }
  if (ALL_SESSION_COMMANDS[command] && base !== null) {
    const views = ["--history", "--weeks", "--models", "--json"];
    const { words, flags } = parseFlags(args.slice(1).filter((a) => !views.includes(a)));
    if (words.length || Object.keys(flags).some((f) => f !== "d" && f !== "s")) throw new Error(commandHelp(command));
    for (const v of views) if (args.includes(v)) flags[v.slice(2)] = "";
    const when = flags.d === undefined ? { from: -Infinity, to: Infinity } : parseWhen(flags.d, now);
    // A billing period starts up to a month before the window.
    const readings = recordedReadings(base === undefined ? READINGS_FILE : `${base}/usage-readings.jsonl`);
    return ALL_SESSION_COMMANDS[command](loadAll(base, when.from - 32 * DAY), when, readings, flags);
  }
  // `files -a` lists every file; the other one-session commands take no flags.
  const all = command === "files" && args.includes("-a");
  const [, h, sid, ...extra] = all ? args.filter((a) => a !== "-a") : args;
  if (COMMANDS[command] && sid === undefined && extra.length === 0 && h !== undefined && base !== null && !isHarnessName(h)) {
    const f = findByPrefix(h, base);
    return show(command, ADAPTERS[f.harness].load(f.ref, f.roots, { counts: command === "files" }), roots === undefined, withSize, all);
  }
  if (!command || !COMMANDS[command] || !h || !isHarnessName(h) || !sid) throw new Error(commandHelp(command));
  return show(command, ADAPTERS[h].load(sid, roots, { counts: command === "files" }), roots === undefined, withSize, all);
}

function show(command: string, session: Session, readClones: boolean, withSize: boolean, all: boolean): string {
  if (command === "summary") return summary(session, readClones, withSize);
  if (command === "files") return filesCommand(session, all);
  return COMMANDS[command](session);
}

if (import.meta.main) {
  try {
    // A blank line parts the output from the command that asked for it.
    const output = await run(process.argv.slice(2), Date.now(), (attempt) => console.log(`\n${attempt}`));
    console.log(`\n${output}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
