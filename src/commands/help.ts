// Help text: one aligned line per command in `wf help`, details in `wf help <command>`.
import { HARNESS_NAMES } from "../harnesses/index.ts";
import { STATUS } from "../catalog.ts";

type Help = { group: string; args: string; line: string; detail: string[] };

const WHEN = "-d when    2 (days), 6h, 2026-09-20, 09-20, 09-01..09-07, 09-01.. (UTC days)";
const ONE_SESSION = [
  "<id> is a session id prefix, or a Claude Code job id.",
  "Also: wf <command> <harness> <session id or path> [--root <path>]...",
];

const HELP: Record<string, Help> = {
  repo: { group: "Repository", args: "[directory] [commit]", line: "tracked size by category, folder and file", detail: ["wf repo [directory] [commit] [-d depth] [-n files]", "Reads the committed tree at HEAD unless a commit is given.", "-d depth  folder levels to show, 2 by default", "-n files  largest files to show, 10 by default"] },
  run: {
    group: "Launch and watch", args: "<harness> <model> -i <file>", line: "start a fresh headless session",
    detail: [
      `wf run <${HARNESS_NAMES.join("|")}> <model> -i <task file> [-k skill | -r role] [-p dir] [-e effort] [--plan p] [--write]`,
      "Runs one session, waits, and prints its id, cost and reply.",
      "-k skill   skill the task uses; recorded for wf models and wf route",
      "-r role    role with no skill to load, such as implement; recorded like -k without the skill line",
      "-p dir     working directory, the current one by default",
      "-e effort  reasoning effort, where the harness takes one",
      "--plan p   plan the session works on, as <owner/repo>#<number>; read back by wf plan",
      "--write    turn every permission check off; pass a worktree. Without it the session only reads.",
    ],
  },
  status: {
    group: "Launch and watch", args: "", line: "sessions running now and their state",
    detail: [
      "wf status [-a time] [-w window]",
      "-a time    the logs as they stood at YYYY-MM-DDTHH:MM (UTC)",
      "-w window  sessions with an event in the last N minutes, Nh or Nd; 60 by default",
      "States:",
      "  working  events are arriving",
      `  stuck    no event for ${STATUS.quiet} min, or one tool for ${STATUS.tool} min`,
      "  ended    open turn, no process",
      "  waiting  asking the person",
      "  idle     no open turn; hidden once its process exits, except with -a",
    ],
  },
  stop: {
    group: "Launch and watch", args: "<id>", line: "stop a session's process",
    detail: ["wf stop <id>", "Sends SIGTERM to the harness process that writes the session and its tools, and waits up to 10s.", ...ONE_SESSION],
  },
  route: {
    group: "Choose a route", args: "<skill>", line: "rank harness and model for a skill",
    detail: [
      "wf route <skill> [-x author models] [-d when]",
      "-x models  comma-separated author models; an exact match ranks later",
      `${WHEN}; 7 days by default`,
      "Order: plans with headroom, exact author-model match, listed routes, weekly pace,",
      "list position, plans before per-token billing, then most-used route.",
      "Lists and pace margin live in data/routes.json. Unknown pace keeps list order.",
      "Headroom comes from wf usage, or from the logs, marked (logs).",
    ],
  },
  models: {
    group: "Choose a route", args: "", line: "cost, time and pass rate per skill and model",
    detail: [
      "wf models [-k skill] [-d when] [--size]",
      "-k skill   one skill only",
      `${WHEN}; 30 days by default`,
      "Medians per session. Implement rows add judged, passed, blocked and pass rate from GitHub.",
      "Implement rows split by peak-context band: S, M, L or over.",
      "--size shows median code and docs tokens and measured sessions per row.",
    ],
  },
  usage: {
    group: "Choose a route", args: "", line: "plan limits used, time to reset, weekly pace and value",
    detail: [
      "wf usage [-w 7d|5h|all] [--value] | --json",
      "-w window  7d (default), 5h or all",
      "pace       points ahead or behind an even burn to 100% by reset",
      "needs/day  share per day that uses the rest",
      "--value    adds, per weekly window, reading 7 days of logs:",
      "  spent        API-equivalent cost of logged calls since the window started",
      "  full window  spent over the share used",
      "  multiplier   a month of full windows over the plan's price",
      "--json     every window with its pace, as one JSON document",
    ],
  },
  summary: { group: "Inspect one session", args: "<id>", line: "calls, models, tokens, cost, compactions, result", detail: ["wf summary <id> [--size]", "Threads, turns, calls, models, tokens, cost, time, skills, incidents and result link.", "--size shows code and docs tokens at the starting commit.", ...ONE_SESSION] },
  turns: { group: "Inspect one session", args: "<id>", line: "what started each turn and what it cost", detail: ["wf turns <id>", "Each turn's trigger, models, skills, subagents, cost and outcome.", ...ONE_SESSION] },
  cost: { group: "Inspect one session", args: "<id>", line: "cost by turn, token type, model and call", detail: ["wf cost <id>", "Cost by turn, token type, model, subagent and call.", ...ONE_SESSION] },
  tools: { group: "Inspect one session", args: "<id>", line: "tool use, failures and shell programs", detail: ["wf tools <id>", "Tool and shell categories, failures, time and top shell programs.", ...ONE_SESSION] },
  files: { group: "Inspect one session", args: "<id>", line: "files read, repeat reads and their tokens", detail: ["wf files <id> [-a]", "Files read with their turns, repeat reads, reads after a compaction, and edits.", "Then skill and instruction files read, and the largest reads.", "Tokens are result characters over the ratio in data/thresholds.json; a call reading several files splits them evenly.", "Paths show relative to the session directory, ~ for a home folder, and $skills, $session or an alias from data/paths.json for a prefix; the header names each alias used.", "-a lists every file instead of the first 20.", ...ONE_SESSION] },
  time: { group: "Inspect one session", args: "<id>", line: "where turn time went", detail: ["wf time <id>", "Model, tool, subagent and waiting time per turn.", ...ONE_SESSION] },
  ls: {
    group: "Across sessions", args: "[harness]...", line: "find sessions by harness, model, cost, folder",
    detail: [
      `wf ls [${HARNESS_NAMES.join("|")}]... [flags]`,
      `${WHEN}`,
      "-m model   substring of any model the session used",
      "-c usd     5 (at least), 1..5, ..0.5",
      "-p dir     substring of the working directory",
      "-k role    implement, evaluate, critique or another wf run skill, or orchestrator",
      "-s sort    new (default), cost, time, turns",
      "-n count   rows to show, 20 by default",
      "--size     code and docs tokens at each starting commit",
      "-m, -c, -p, -k and -s other than new read the last 30 days unless -d is given.",
      "role is the skill wf run launched the session for, or orchestrator when it launched others.",
    ],
  },
  plan: {
    group: "Across sessions", args: "<plan>", line: "cost of the sessions launched for a plan",
    detail: [
      "wf plan <plan> [-d when]",
      "<plan>     7, 0007, workflow#7 or pepdevs/workflow#0007",
      `${WHEN}; 30 days by default`,
      "Totals the sessions wf run launched with --plan. The sessions that launched them show below, outside the total.",
    ],
  },
  export: {
    group: "Across sessions", args: "", line: "sessions, tokens, cost and time per day as JSON",
    detail: [
      "wf export [-d when] [--root dir]",
      `${WHEN}; 30 days by default`,
      "One JSON document: a row per UTC day, harness, model, skill and repository, with",
      "sessions, tokens by type, cost in USD and wall seconds, then totals.",
      "A session counts once on the day it started, under its main model. Tokens and cost",
      "follow each call's model. skill is the wf run skill, orchestrator, or null.",
      "repository is a name only: the launch header, the logged repository URL, the catalog",
      "worktree glob, or the Git checkout. It is null when none names the directory.",
      "model is null for a placeholder such as compaction or unknown, or a session with no model;",
      "its tokens still count.",
      "OpenRouter vendor prefixes such as x-ai/ are dropped, so one model has one name.",
      "costUsd is null for a model with no list price, such as a free stealth model;",
      "totals add the priced rows and unpricedRows counts the others.",
      "No prompt, reply, file content, path or credential is included. schema rises when a field changes.",
    ],
  },
  prompts: {
    group: "Across sessions", args: "", line: "each session's prompts as JSON",
    detail: [
      "wf prompts [-d when] [--root dir]",
      `${WHEN}; 30 days by default`,
      "One JSON document with each session that started in the range or took a prompt in it.",
      "A session has its start day, parent (the session that launched it with wf run), harness,",
      "repository, skill, model, cost and prompts. A prompt is a root turn the person started",
      "by typing. It has its start time, model, outcome, cost with spawned subagents, launch mark",
      "and text. The output holds prompt text. schema rises when a field changes.",
    ],
  },
  subscriptions: {
    group: "Across sessions", args: "", line: "plan prices, next bills, use this period and this week",
    detail: [
      "wf subscriptions [--history] [--weeks] [--models] [-d when] [-s points] [--root dir]",
      "The running plans: price in euros, next bill, API-equivalent use of this billing period,",
      "its multiplier over the price, and the current weekly window.",
      "--history  value per plan and per billing period, ended plans included",
      "--weeks    each weekly window: share used, cost and full-window value",
      "--models   API-equivalent cost per plan and model",
      "-d when    narrows --history, --weeks and --models: N, Nh, YYYY-MM-DD, MM-DD or a..b;",
      "           a bound may be a moment such as 2026-09-24T01:00+02:00, so",
      "           --models -d2026-09-24T01:00.. is spend since a weekly reset",
      "-s points  instead lists each rise of that many points within a limit window,",
      "           with its cost per 1%, multiplier and main model",
      "--root dir read one directory per harness instead of the default logs",
    ],
  },
  archive: { group: "Maintenance", args: "", line: "copy harness logs into the archive", detail: ["wf archive", "Copies Codex, Claude Code and Pi logs into the archive, so they outlive the harness's cleanup."] },
};

export const HELP_COMMANDS = Object.keys(HELP);

export function helpText(): string {
  const names = Object.keys(HELP);
  const nameWidth = Math.max(...names.map((n) => n.length)) + 2;
  const argsWidth = Math.max(...names.map((n) => HELP[n].args.length)) + 2;
  const lines = ["usage: wf <command> [args]    wf <command> -h for flags and details"];
  let group = "";
  for (const n of names) {
    if (HELP[n].group !== group) {
      group = HELP[n].group;
      lines.push("", group);
    }
    lines.push(`  ${n.padEnd(nameWidth)}${HELP[n].args.padEnd(argsWidth)}${HELP[n].line}`);
  }
  lines.push("", "Use cases behind each command: docs/use-cases.md");
  return lines.join("\n");
}

export function commandHelp(command: string): string {
  const help = HELP[command];
  if (!help) return helpText();
  const [usage, ...rest] = help.detail;
  return [usage, ...rest.map((l) => `  ${l}`)].join("\n");
}
