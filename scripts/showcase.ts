// Renders the README images: real wf commands over an invented scene of five
// sessions, written as terminal-style SVG files in docs/images/. An empty
// --root keeps every command off real logs, provider usage and GitHub.
// Run with `npm run showcase`; `--print` writes the text to stdout instead.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "../src/harnesses/index.ts";
import { run } from "../src/cli.ts";

type Session = ReturnType<(typeof ADAPTERS)["pi"]["load"]>;
type Call = Session["modelCalls"][number];
type Tool = Session["toolCalls"][number];
type Turn = Session["turns"][number];

const DAY = "2002-03-02";
const at = (hm: string) => Date.parse(`${hm.includes("T") ? hm : `${DAY}T${hm}`}:00Z`);
const NOW = at("10:31");
const min = 60_000;

const usage = (context: number, output: number) => ({ input: 2_000, cacheRead: context - 2_000, cacheWrite: 4_000, cacheWrite1h: 0, output, reasoning: 0 });

// Calls every `every` minutes in [from, to], with context growing from `c0` to `c1`.
function calls(thread: string, turn: string, provider: string, model: string, from: string, to: string, every: number, c0: number, c1: number, endTurn = true): Call[] {
  const out: Call[] = [];
  const start = at(from), end = at(to);
  const n = Math.max(1, Math.floor((end - start) / (every * min)));
  for (let i = 0; i <= n; i++) {
    const t = start + ((end - start) * i) / n;
    out.push({
      id: `${thread}-${turn}-${i}`, threadId: thread, turnId: turn, provider, model, effort: null, startedAt: t - 20_000, startInferred: false,
      endedAt: t, usage: usage(Math.round(c0 + ((c1 - c0) * i) / n), 1_500), stopReason: i === n && endTurn ? "end_turn" : "tool_use", purpose: "turn", reportedCostUsd: null,
    });
  }
  return out;
}

function shell(id: string, thread: string, turn: string, command: string, from: string, minutes: number | null, status: Tool["status"] = "ok"): Tool {
  return {
    id, threadId: thread, turnId: turn, name: "bash", category: "shell", shellCategory: null, command, origin: "model",
    startedAt: at(from), endedAt: minutes === null ? null : at(from) + minutes * min, status, spawnsThreadId: null,
    paths: [], lines: null, web: null, resultChars: 2_000, resultLines: 40, resultWords: 300,
  };
}

const turn = (id: string, thread: string, from: string, to: string | null, promptText: string): Turn => ({
  id, threadId: thread, trigger: "prompt", promptText, startedAt: at(from), endedAt: to === null ? null : at(to), outcome: to === null ? "unknown" : "completed",
});

// A plan window's share used, as a harness log reports it at 10:20.
const quota = (provider: string, windowMinutes: number, usedPercent: number, resets: string) =>
  ({ threadId: "t", at: at("10:20"), provider, plan: null, windowMinutes, usedPercent, resetsAt: at(resets) });

function session(harness: Session["harness"], id: string, cwd: string, parts: Pick<Session, "turns" | "modelCalls" | "toolCalls"> & Partial<Pick<Session, "quotaReadings">>): Session {
  return {
    harness, id, title: null, cwd, harnessVersion: null, threads: [{ id: "t", parentId: null, name: null, agentType: null, spawnedByToolCallId: null }],
    skills: [], incidents: [], compactions: [], quotaReadings: [], reportedCostUsd: null, ...parts,
  };
}

const ORCH = "a7f3c2d1-5b8e-4c6a-9d2f-1e0b7a6c5d4e";
const header = (skill: string) => `[wf run skill=${skill} parent=claude:${ORCH} plan=acme/api#12 repo=acme/api]\nUse the installed ${skill} skill for this task.\n\n`;

// An orchestrator in Claude Code plans rate limiting for an API and launches a
// critic in Codex, a builder in Pi and a researcher in OpenCode. The researcher
// repeats one command and has gone quiet. A person works on docs in Grok Build.
const scene: Session[] = [
  session("claude-code", ORCH, "/work/api", {
    turns: [turn("o1", "t", "08:58", null, "Add rate limiting to the public API and ship it behind a flag")],
    modelCalls: calls("t", "o1", "anthropic", "claude-opus-5", "09:00", "10:24", 3, 40_000, 168_000, false),
    toolCalls: [
      shell("o-crit", "t", "o1", "wf run codex gpt-6.1-sol -i critique.md -k critique --plan acme/api#12", "09:08", 28),
      shell("o-res", "t", "o1", "wf run opencode zai-coding-plan/glm-5.3-flash -i research.md -k research", "09:58", 2),
      shell("o-impl", "t", "o1", "wf run pi zai/glm-5.3 -i build.md -k implement -p ../api-o1 --write", "10:25", null),
    ],
    quotaReadings: [quota("anthropic", 300, 71, "12:00"), quota("anthropic", 10_080, 64, "2002-03-05T09:00")],
  }),
  session("codex", "019a6e2b-7c3d-7f10-b5a4-2e8d9c0f1a3b", "/work/api", {
    turns: [turn("c1", "t", "09:09", "09:35", `${header("critique")}Review docs/plans/0012-rate-limits.md.`)],
    modelCalls: calls("t", "c1", "openai", "gpt-6.1-sol", "09:10", "09:35", 2, 30_000, 96_000),
    toolCalls: [],
    quotaReadings: [quota("openai", 300, 22, "13:10"), quota("openai", 10_080, 48, "2002-03-06T09:00")],
  }),
  session("opencode", "ses_4f2a9c81e3d7bQ5xKp0vTn6wYz", "/work/api", {
    turns: [turn("r1", "t", "09:59", null, `${header("research")}Find the rate limits the upstream provider documents.`)],
    modelCalls: calls("t", "r1", "zai-coding-plan", "glm-5.3-flash", "10:00", "10:17", 2, 20_000, 61_000, false),
    toolCalls: [1, 2, 3, 4, 5].map((i) => shell(`r${i}`, "t", "r1", "curl -s api/limits", `10:${String(2 + i * 3).padStart(2, "0")}`, 0.2, i > 2 ? "failed" : "ok")),
    quotaReadings: [quota("zai-coding-plan", 300, 100, "11:40")],
  }),
  session("pi", "019a6e9f-1d2c-7e4b-8a90-5c3b2d1e0f6a", "/work/api-o1", {
    turns: [turn("p1", "t", "10:26", null, `${header("implement")}Build the token bucket from the plan.`)],
    modelCalls: calls("t", "p1", "zai", "glm-5.3", "10:26", "10:30", 1, 25_000, 58_000, false),
    toolCalls: [shell("p-test", "t", "p1", "npm test", "10:30", null)],
  }),
  session("grok", "019a6d11-3e4f-7a2b-9c8d-0f1e2d3c4b5a", "/work/docs", {
    turns: [turn("g1", "t", "09:40", "10:05", "Rewrite the quickstart for the new CLI flags")],
    modelCalls: calls("t", "g1", "xai", "grok-4.6", "09:41", "10:05", 2, 15_000, 44_000),
    toolCalls: [],
    quotaReadings: [quota("xai", 10_080, 12, "2002-03-07T09:00")],
  }),
];

for (const adapter of Object.values(ADAPTERS)) adapter.list = () => [];
const byAdapter = { claude: "claude-code", codex: "codex", opencode: "opencode", pi: "pi", grok: "grok" } as const;
for (const [name, harness] of Object.entries(byAdapter)) {
  const mine = scene.filter((s) => s.harness === harness);
  ADAPTERS[name as keyof typeof ADAPTERS].list = () => mine.map((s) => ({ id: s.id, ref: s.id, updatedAt: NOW }));
  ADAPTERS[name as keyof typeof ADAPTERS].load = (ref: string) => mine.find((s) => s.id === ref)!;
}

// Each image: its file name, the command line shown, the arguments run, the lines
// kept, and the table columns left out so the image stays readable at README width.
const SHOTS: [string, string, string[], number, string[]][] = [
  ["status", "wf status", ["status", "-a", `${DAY}T10:31`, "-w", "2h"], Infinity, ["directory", "pid", "turn", "running", "last hour"]],
  ["plan", "wf plan 12", ["plan", "12", "-d", DAY], Infinity, []],
  ["cost", "wf cost a7f3", ["cost", "a7f3"], 14, []],
  ["route", "wf route implement -x claude-opus-5", ["route", "implement", "-d", DAY, "-x", "claude-opus-5"], Infinity, []],
];

const root = mkdtempSync(join(tmpdir(), "wf-showcase-"));
const shots = await Promise.all(SHOTS.map(async ([name, shown, args, keep, drop]) => {
  const lines = String(await run([...args, "--root", root], NOW)).trimEnd().split("\n").filter((l) => !l.startsWith("Verdicts missing")).slice(0, keep);
  return [name, shown, withoutColumns(lines, drop).join("\n").trimEnd()] as const;
}));
rmSync(root, { recursive: true, force: true });
if (process.argv.includes("--print")) {
  for (const [, shown, text] of shots) console.log(`$ ${shown}\n${text}\n`);
} else {
  mkdirSync("docs/images", { recursive: true });
  for (const [name, shown, text] of shots) writeFileSync(`docs/images/${name}.svg`, svg(shown, text));
}

// Removes the named columns from each table: the dash row under a header marks the
// column spans, and the table runs to the next blank line.
function withoutColumns(lines: string[], names: string[]): string[] {
  if (!names.length) return lines;
  const out = [...lines];
  for (let i = 1; i < out.length; i++) {
    if (!/^-[- ]+$/.test(out[i])) continue;
    const spans = [...out[i].matchAll(/-+/g)].map((m) => [m.index!, m.index! + m[0].length + 2]);
    const gone = spans.filter(([a, b]) => names.includes(out[i - 1].slice(a, b).trim()));
    let end = i + 1;
    while (end < out.length && out[end].trim()) end++;
    for (let j = i - 1; j < end; j++) out[j] = gone.reduceRight((l, [a, b]) => l.slice(0, a) + l.slice(b), out[j].padEnd(spans.at(-1)![1])).trimEnd();
  }
  return out;
}

// A terminal window: a title bar, the command line, then the output.
function svg(shown: string, text: string): string {
  const lines = [`$ ${shown}`, ...text.split("\n")];
  const charW = 8.4, lineH = 19, pad = 18, bar = 34;
  const cols = Math.max(...lines.map((l) => l.length));
  const width = Math.ceil(cols * charW + pad * 2), height = bar + pad + lines.length * lineH + pad - 4;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const color = (line: string, i: number) => {
    if (i === 0) return "#7ee787";
    if (/^-[- ]+$/.test(line)) return "#484f58";
    if (i > 0 && lines[i + 1] !== undefined && /^-[- ]+$/.test(lines[i + 1])) return "#8b949e";
    return "#e6edf3";
  };
  const marks: [RegExp, string][] = [[/\bworking\b/g, "#7ee787"], [/\bstuck\b/g, "#ff7b72"], [/\bidle\b/g, "#8b949e"], [/same command ×\d+[^│]*$|\d+ of the last 10 tool calls failed/g, "#e3b341"]];
  const tspans = (line: string) => {
    const spans: { from: number; to: number; fill: string }[] = [];
    for (const [re, fill] of marks) for (const m of line.matchAll(re)) spans.push({ from: m.index!, to: m.index! + m[0].length, fill });
    spans.sort((a, b) => a.from - b.from);
    let out = "", pos = 0;
    for (const s of spans) {
      if (s.from < pos) continue;
      out += esc(line.slice(pos, s.from)) + `<tspan fill="${s.fill}">${esc(line.slice(s.from, s.to))}</tspan>`;
      pos = s.to;
    }
    return out + esc(line.slice(pos));
  };
  const body = lines.map((l, i) => `<text x="${pad}" y="${bar + pad + i * lineH + 12}" fill="${color(l, i)}" xml:space="preserve">${tspans(l)}</text>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="14">
<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
<rect width="${width}" height="${bar}" rx="10" fill="#161b22"/><rect y="${bar - 10}" width="${width}" height="10" fill="#161b22"/>
<circle cx="20" cy="17" r="6" fill="#ff5f56"/><circle cx="40" cy="17" r="6" fill="#ffbd2e"/><circle cx="60" cy="17" r="6" fill="#27c93f"/>
${body}
</svg>
`;
}
