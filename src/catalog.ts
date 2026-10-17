// Prices, plans, routes, thresholds and web backends from data/, and the tool categories and
// incident classes shared by every harness.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Usage, WebAction } from "./model.ts";

// Local operator files override whole catalogs; absent files use bundled defaults.
const explicitConfig = process.env.WORKFLOW_CONFIG_DIR;
const configDir = explicitConfig ? resolve(explicitConfig) : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "workflow");
if (explicitConfig && (!existsSync(configDir) || !statSync(configDir).isDirectory())) {
  throw new Error(`WORKFLOW_CONFIG_DIR is not a directory: ${configDir}`);
}
const readData = (name: string) => {
  const local = join(configDir, `${name}.json`);
  return JSON.parse(readFileSync(existsSync(local) ? local : new URL(`../data/${name}.json`, import.meta.url), "utf8"));
};
const prices = readData("prices");
const subscriptions = readData("subscriptions");
const routes = readData("routes");
const thresholds = readData("thresholds");
const webBackends = readData("web-backends");
const paths = readData("paths");
// formerly lists the names a repository had before a rename, each until the ISO time it changed.
export type RepositoryEntry = { path: string; worktrees?: string[]; formerly?: { name: string; until: string }[]; categories?: Partial<Record<"code" | "test" | "test data" | "docs" | "data" | "config", string[]>>; domains?: Record<string, string[]> };
export const repositoryEntries: Record<string, RepositoryEntry> = readData("repos");

// Micro-USD per million tokens. `long` applies to the whole call once its
// prompt (input, cache read and cache write tokens) reaches `from` tokens.
type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Price = Rates & { long?: Rates & { from: number } };

const M = 1_000_000;
const micro = (r: Rates): Rates => ({ input: r.input * M, cacheRead: r.cacheRead * M, cacheWrite: r.cacheWrite * M, output: r.output * M });
const PRICES: Record<string, Price> = Object.fromEntries(
  Object.entries(prices.models as Record<string, Price>).map(([k, p]) => [k, { ...micro(p), ...(p.long ? { long: { ...micro(p.long), from: p.long.from } } : {}) }]),
);

// Harness provider names that route to one billing provider.
const PROVIDER_ALIASES: Record<string, string> = prices.providerAliases;

export function normalizeProvider(provider: string): string {
  return PROVIDER_ALIASES[provider] ?? provider;
}

// OpenRouter names the upstream vendor in the model id and charges its price.
const OPENROUTER_VENDORS: Record<string, string> = prices.openRouterVendors;

// One name per model: OpenRouter's x-ai/grok-4.6 is grok-4.6, as xai logs it.
// A prefix that names no vendor, such as stealth/, stays part of the name.
export function modelName(provider: string, model: string): string {
  const [vendor, ...rest] = model.split("/");
  return provider === "openrouter" && OPENROUTER_VENDORS[vendor] && rest.length ? rest.join("/") : model;
}

// Dated ids such as claude-haiku-4-5-20251001 use the base model's price.
// An OpenRouter model without a price of its own takes its vendor's price.
function priceOf(provider: string, model: string): Price | undefined {
  const key = `${provider}/${model}`;
  const price = PRICES[key] ?? PRICES[key.replace(/-\d{8}$/, "")];
  if (price || provider !== "openrouter") return price;
  const name = modelName(provider, model);
  for (const vendor of new Set(Object.values(OPENROUTER_VENDORS))) {
    const upstream = priceOf(vendor, name);
    if (upstream) return upstream;
  }
  return undefined;
}

export type CostParts = { input: number; cacheRead: number; cacheWrite: number; output: number };

// USD per token type for one call, or null when the model has no price. The
// tier comes from the whole prompt. One-hour cache writes cost twice the input price.
export function costParts(provider: string, model: string, u: Usage): CostParts | null {
  const price = priceOf(normalizeProvider(provider), model);
  if (!price) return null;
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  const p = price.long && prompt >= price.long.from ? price.long : price;
  const usd = (micro: number) => micro / M / M;
  return {
    input: usd(u.input * p.input),
    cacheRead: usd(u.cacheRead * p.cacheRead),
    cacheWrite: usd((u.cacheWrite - u.cacheWrite1h) * p.cacheWrite + u.cacheWrite1h * 2 * p.input),
    output: usd(u.output * p.output),
  };
}

export function computeCostUsd(provider: string, model: string, u: Usage): number | null {
  const parts = costParts(provider, model, u);
  return parts && parts.input + parts.cacheRead + parts.cacheWrite + parts.output;
}

// List price for a harness-reported aggregate of calls, or null when a model has
// no price. Each model's calls are priced at their average prompt, so the long
// tier is an estimate when some calls cross it and others do not.
export function aggregateCostParts(usages: { provider: string; model: string; callCount: number; usage: Usage }[]): CostParts | null {
  const total: CostParts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const m of usages) {
    const n = Math.max(1, m.callCount);
    const each = Object.fromEntries(Object.entries(m.usage).map(([k, v]) => [k, v / n])) as Usage;
    const parts = costParts(m.provider, m.model, each);
    if (!parts) return null;
    for (const k of Object.keys(total) as (keyof CostParts)[]) total[k] += parts[k] * n;
  }
  return total;
}

// ---- subscriptions

// EUR prices convert at this rate, set by hand in data/subscriptions.json.
export const USD_PER_EUR: number = subscriptions.usdPerEur;

export type Subscription = {
  name: string;
  monthly: number;
  currency: "USD" | "EUR";
  // Start of the first billing period, UTC. Start dates not given by the
  // operator are the first call on the plan's providers in the logs.
  from: string;
  // When the plan ended, or null while it runs.
  to: string | null;
  // Harness provider names the plan pays for.
  providers: string[];
  // The plan type the harness reports, for accounts on the same provider.
  plan?: string;
};

// First match wins. Providers missing here are paid per token.
export const SUBSCRIPTIONS: Subscription[] = subscriptions.plans;

export const monthlyUsd = (s: Subscription) => s.monthly * (s.currency === "EUR" ? USD_PER_EUR : 1);

// Subscription billing figures show in euros, converted at the configured rate.
export const monthlyEur = (s: Subscription) => s.monthly / (s.currency === "USD" ? USD_PER_EUR : 1);

// The subscription that paid for a call, or null for a call paid per token.
// `plan` is the plan type the harness reported, when it reports one.
export function subscriptionOf(provider: string, at: number, plan: string | null = null): Subscription | null {
  return (
    SUBSCRIPTIONS.find(
      (s) =>
        s.providers.includes(provider) &&
        at >= Date.parse(s.from) &&
        (s.to === null || at < Date.parse(s.to)) &&
        (plan === null || s.plan === undefined || s.plan === plan),
    ) ?? null
  );
}

export type BillingPeriod = { start: number; end: number; share: number; current: boolean };

// Monthly periods from the plan's first billing day until it ended or until
// `until`, the last call in the logs. A period cut short by the plan's end
// pays its share of the price; the period holding `until` pays in full.
export function billingPeriods(s: Subscription, until: number): BillingPeriod[] {
  const first = new Date(Date.parse(s.from));
  const monthStart = (n: number) => {
    const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + n, 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(first.getUTCDate(), last)) + (first.getTime() % 86_400_000);
  };
  const ended = s.to === null ? Infinity : Date.parse(s.to);
  const out: BillingPeriod[] = [];
  for (let n = 0; monthStart(n) < Math.min(ended, until); n++) {
    const start = monthStart(n);
    const end = monthStart(n + 1);
    if (ended < end) out.push({ start, end: ended, share: (ended - start) / (end - start), current: false });
    else out.push({ start, end, share: 1, current: until < end });
  }
  return out;
}

const TOOL_CATEGORIES: Record<string, string> = {
  exec: "shell", exec_command: "shell", write_stdin: "shell", wait: "shell", bash: "shell", Bash: "shell",
  read: "file_read", Read: "file_read", view_image: "file_read",
  grep: "search", Grep: "search", glob: "search", Glob: "search", find: "search", ls: "search",
  edit: "file_write", Edit: "file_write", write: "file_write", Write: "file_write", apply_patch: "file_write",
  webfetch: "web", WebFetch: "web", WebSearch: "web", run: "web",
  spawn_agent: "agent", wait_agent: "agent", send_message: "agent", followup_task: "agent",
  list_agents: "agent", interrupt_agent: "agent", Agent: "agent", SendMessage: "agent",
  ListAgents: "agent", SubagentHandback: "agent", TaskStop: "agent", task: "agent",
  skill: "skill", Skill: "skill",
  request_user_input: "user_interaction", request_user_input_async: "user_interaction",
  AskUserQuestion: "user_interaction", ExitPlanMode: "user_interaction", question: "user_interaction",
  update_plan: "planning", todowrite: "planning",
  sleep: "harness", ToolSearch: "harness", Monitor: "harness", ScheduleWakeup: "harness",
  EnterWorktree: "harness", ExitWorktree: "harness", StructuredOutput: "harness", SendUserFile: "harness",
  // GitHub Copilot CLI
  powershell: "shell", read_powershell: "shell", write_powershell: "shell", stop_powershell: "shell", list_powershell: "shell", local_shell: "shell",
  view: "file_read", create: "file_write", str_replace: "file_write", rg: "search", web_fetch: "web", web_search: "web",
  read_agent: "agent", write_agent: "agent", send_inbox: "agent", read_inbox: "agent",
  ask_user: "user_interaction", exit_plan_mode: "user_interaction", sql: "planning",
  report_intent: "harness", task_complete: "harness", tool_search_tool: "harness", fetch_copilot_cli_documentation: "harness",
  rename_session: "harness", store_memory: "harness", vote_memory: "harness", read_memories: "harness", session_store_sql: "harness",
};

export function toolCategory(name: string): string {
  if (name.startsWith("mcp__")) return "mcp";
  return TOOL_CATEGORIES[name] ?? (name in WEB_ACTIONS ? "web" : "other");
}

// What each harness's web tool does when its arguments do not say. Codex's
// web_search logs its action with every call. web-search-prime is Z.ai's MCP in OpenCode.
const WEB_ACTIONS: Record<string, WebAction> = {
  WebSearch: "search", WebFetch: "open",
  websearch: "search", webfetch: "open", "web-search-prime_web_search_prime": "search",
  web_search: "search", web_fetch: "open", "Web search:": "search",
};

export function webAction(name: string): WebAction | null {
  return WEB_ACTIONS[name] ?? null;
}

// The search or fetch behind a harness's web tool, from data/web-backends.json, or `unknown`.
export function webBackend(harness: string, tool: string): string {
  return webBackends.tools.find((t: { harness: string; tool: string }) => t.harness === harness && t.tool === tool)?.backend ?? "unknown";
}

// wf web: the searches that make a chain long, and the word overlap that makes a search a rewording.
export const WEB_LONG_CHAIN: number = thresholds.web?.longChain ?? 3;
export const WEB_REPHRASE_OVERLAP: number = thresholds.web?.rephraseOverlap ?? 0.5;

const SHELL_CATEGORIES: [string, string[]][] = [
  ["vcs", ["git"]],
  ["forge", ["gh"]],
  ["search", ["grep", "rg", "find", "fd"]],
  ["read", ["cat", "sed", "nl", "head", "tail", "ls", "wc", "jq", "pwd", "stat"]],
  ["build_test", ["npm", "npx", "pnpm", "mise", "make", "pytest", "cargo", "go", "tsc", "uv", "prettier", "shellcheck", "actionlint", "yamllint", "ansible-lint"]],
  ["script", ["python", "python3", "node", "bash", "sh"]],
  ["remote", ["ssh", "scp", "docker", "curl", "kubectl", "ansible-playbook", "rsync"]],
  ["process", ["ps", "kill", "sleep", "pgrep", "pkill", "setsid", "nohup", "systemctl", "journalctl"]],
  ["filesystem", ["mkdir", "cp", "mv", "rm", "ln", "chmod", "touch", "du", "tar"]],
  ["database", ["psql", "sqlite3"]],
  ["agent_cli", ["pi", "claude", "codex", "opencode", "grok", "copilot"]],
  ["workflow", ["workflow"]],
];

// Shell setup that runs before the real command in a segment chain.
const SETUP = new Set(["cd", "export", "set", "source", ".", "for", "while", "if", "then", "do", "local", "true", "echo", "printf", "date", "test", "[", "command", "unset", "trap", "pwd", "timeout", "time", "env", "sudo"]);

// First real program of the command. Segments split on `&&`, `||`, `;` and
// `|`; setup segments (cd, export, loops, echo) and env assignments are skipped.
export function shellProgram(command: string): string {
  let first = "";
  for (const line of command.split("\n")) {
    for (const segment of line.split(/&&|\|\||;|\|/)) {
      const words = segment.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      const program = (words[0] ?? "").replace(/.*\//, "");
      if (!program) continue;
      if (!first) first = program;
      if (program === "for" || program === "while") {
        // `for x in …; do cmd` and `while …; do cmd`: the command follows `do`.
        continue;
      }
      if (program === "do" || program === "then") {
        const inner = (words[1] ?? "").replace(/.*\//, "");
        if (inner && !SETUP.has(inner)) return inner;
        continue;
      }
      if (program === "timeout" || program === "time" || program === "env" || program === "sudo") {
        const inner = words.slice(1).find((w) => !/^-|^\d/.test(w));
        if (inner && !SETUP.has(inner)) return inner.replace(/.*\//, "");
        continue;
      }
      if (!SETUP.has(program)) return program;
    }
  }
  return first;
}

// Branches a shell command creates or publishes: git checkout -b, git switch -c,
// git worktree add -b, git push to origin, and gh pr create --head.
const BRANCH_COMMANDS = [
  /\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|switch)\s+(?:-[bBcC]|--create|--force-create)\s+["']?([^\s"';&|]+)/g,
  /\bgit\s+(?:-C\s+\S+\s+)?worktree\s+add\s+(?:[^;&|]*?\s)?-[bB]\s+["']?([^\s"';&|]+)/g,
  /\bgit\s+(?:-C\s+\S+\s+)?push\s+(?:-{1,2}[\w-]+\s+)*origin\s+["']?(?:HEAD:)?(?:refs\/heads\/)?([^\s"';&|:]+)/g,
  /\bgh\s+pr\s+create\b[^;&|]*?--head[\s=]["']?([^\s"';&|]+)/g,
];

export function commandBranches(command: string): string[] {
  return BRANCH_COMMANDS.flatMap((re) => [...command.matchAll(re)].map((m) => m[1]!)).filter((b) => !b.startsWith("-") && !b.startsWith("$"));
}

export function shellCategory(command: string): string {
  const program = shellProgram(command);
  if (program === "sed" && /\ssed\s+-i|^sed\s+-i/.test(command)) return "file_write";
  for (const [category, programs] of SHELL_CATEGORIES) if (programs.includes(program)) return category;
  return "other";
}

// Maps free-text or HTTP API failures to incident kinds.
export function classifyApiError(text: string, status: number | null = null): string {
  const t = text.toLowerCase();
  if (status === 404) return "model_unavailable";
  if (t.includes("usage limit") || t.includes("spending-limit") || t.includes("limit exhausted")) return "usage_limit";
  if (status === 429 || t.includes("rate limit") || t.includes("rate-limit")) return "rate_limit";
  if (t.includes("overloaded")) return "overloaded";
  if (t.includes("terminated") || t.includes("finish_reason")) return "stream_terminated";
  if (t.includes("connect")) return "connection";
  if (t.includes("unauthorized") || status === 401) return "unauthorized";
  if (t.includes("provider returned error") || t.includes("server")) return "server_error";
  return "other";
}

// Models do their best work within the first 200k tokens of context.
export const CONTEXT_BUDGET: number = thresholds.contextBudgetTokens;

// Path prefix patterns per alias, such as `$repos`, that the operator keeps.
export const PATH_ALIASES: Record<string, string[]> = paths.aliases;

// A home folder on Linux, macOS or Windows, after separators become `/`.
const HOME = /^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root|[a-z]:\/users\/[^/]+)(?=\/|$)/i;
const WINDOWS = /^[a-z]:[\\/]/i;
const escape = (s: string) => s.replace(/[.+^$(){}|[\]\\?]/g, "\\$&");

// A path as wf shows it: relative inside the working directory, `~` for a
// home folder, and `$alias/...` for the longest matching alias prefix, with
// the prefix it stood for. Windows paths use `/` and match without case.
export function displayPath(path: string, cwd: string | null, session: string, aliases: Record<string, string[]>): { path: string; alias: [string, string] | null } {
  const windows = WINDOWS.test(path) || (cwd !== null && WINDOWS.test(cwd));
  const norm = (p: string) => (windows ? p.replace(/\\/g, "/") : p);
  const p = norm(path);
  const dir = cwd === null ? null : norm(cwd).replace(/\/$/, "");
  if (dir && (windows ? p.toLowerCase() : p).startsWith(`${windows ? dir.toLowerCase() : dir}/`)) return { path: p.slice(dir.length + 1), alias: null };
  const home = p.replace(HOME, "~");
  let best: { path: string; alias: [string, string] | null } = { path: home, alias: null };
  for (const [name, patterns] of Object.entries(aliases)) {
    for (const pattern of patterns) {
      const source = pattern.split(/(\*|\{session\})/).map((part) => (part === "*" ? "[^/]+" : part === "{session}" ? escape(session) : escape(part))).join("");
      const m = new RegExp(`^${source}(?=/|$)`, windows ? "i" : "").exec(home);
      if (m && m[0].length > (best.alias?.[1].length ?? 0)) best = { path: name + home.slice(m[0].length), alias: [name, m[0]] };
    }
  }
  return best;
}

// Characters per token, to estimate the tokens of a tool result from its length.
export const CHARS_PER_TOKEN: number = thresholds.charsPerToken;

// Upper bounds for implement peak-context bands. L runs through the context budget.
// Days after a merge at which wf changes counts the lines still credited to the change.
export const REWORK_DAYS: number = thresholds.reworkDays ?? 14;
export const SIZE_BAND_S_MAX: number = thresholds.sizeBandSMaxTokens;
export const SIZE_BAND_M_MAX: number = thresholds.sizeBandMMaxTokens;
export type SizeBand = "S" | "M" | "L" | "over";

export function sizeBand(peak: number): SizeBand {
  if (peak < SIZE_BAND_S_MAX) return "S";
  if (peak < SIZE_BAND_M_MAX) return "M";
  if (peak <= CONTEXT_BUDGET) return "L";
  return "over";
}

// Thresholds behind `wf status`, in minutes unless named otherwise; data/thresholds.json explains each.
export const STATUS: { window: number; quiet: number; tool: number; repeat: number; failed: number; costPerHourUsd: number; compactions: number } =
  thresholds.status;

// Ordered routes for each skill, with a default for skills without their own list.
export const ROUTE_PROVIDERS: Record<string, string> = routes.providers;
export const ROUTE_PACE_MARGIN: number = routes.paceMargin;
export const routeList = (skill: string): string[] => routes.skills[skill] ?? routes.default;
const RETIRED: string[] = routes.retired;

// Dated ids such as claude-haiku-4-5-20251001 take the base model's status.
const baseModel = (model: string) => model.replace(/-\d{8}$/, "");
export const isRetired = (model: string): boolean => RETIRED.includes(model) || RETIRED.includes(baseModel(model));

// The vendor that trained a model, for independence between author and judge.
export function familyOf(model: string): string {
  const name = model.split("/").at(-1)!;
  if (name.startsWith("claude")) return "anthropic";
  if (name.startsWith("gpt") || /^o\d/.test(name)) return "openai";
  if (name.startsWith("glm")) return "zai";
  if (name.startsWith("grok")) return "xai";
  return name;
}

// Watch polling and HTTPS delivery bounds, kept below one poll interval.
