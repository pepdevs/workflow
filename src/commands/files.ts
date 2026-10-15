// uc-19: which files a session read, how often, and what they cost in context.
import { ADAPTERS } from "../harnesses/index.ts";
import { CHARS_PER_TOKEN, displayPath, PATH_ALIASES } from "../catalog.ts";
import { ADAPTER_OF } from "./find.ts";
import { type Session, type ToolCall } from "../model.ts";
import { folderName, oneLine, table, tok } from "./format.ts";
import { peakContext, rootThread, rootTurns, spawnedThreads, sum } from "../facts.ts";

// A skill tool call has a path when its harness logs the SKILL.md it loaded.
const isRead = (t: ToolCall) => (t.category === "file_read" || t.category === "skill" || t.shellCategory === "read") && t.paths.length > 0;
const isWrite = (t: ToolCall) => t.category === "file_write" || t.shellCategory === "file_write";
const INSTRUCTIONS = /(^|\/)(SKILL|AGENTS|CLAUDE)\.md$/;
const FILES_SHOWN = 20;
const LARGEST_SHOWN = 10;
const TURNS_SHOWN = 6;

// Turn numbers in order, each once, with ×n for repeats inside a turn: 3,5×2,7.
function turnList(turns: number[]): string {
  const counts = new Map<number, number>();
  for (const t of turns) counts.set(t, (counts.get(t) ?? 0) + 1);
  const parts = [...counts].sort((a, b) => a[0] - b[0]).map(([t, n]) => (t === 0 ? "-" : String(t)) + (n > 1 ? `×${n}` : ""));
  return parts.length > TURNS_SHOWN ? `${parts.slice(0, TURNS_SHOWN).join(",")},…` : parts.join(",");
}

type Read = { call: ToolCall; path: string; turn: number; thread: string; tokens: number | null; lines: number | null; words: number | null; repeat: boolean; afterCompaction: boolean };

export function filesCommand(s: Session, all = false): string {
  const root = rootThread(s);
  // Operator aliases first, so a harness alias of the same name adds its prefixes.
  const aliases: Record<string, string[]> = { ...PATH_ALIASES };
  for (const [name, prefixes] of Object.entries(ADAPTERS[ADAPTER_OF[s.harness]].pathAliases)) aliases[name] = [...(aliases[name] ?? []), ...prefixes];
  // Each alias shown and the prefixes it stood for in this session.
  const used = new Map<string, Set<string>>();
  const relative = (p: string) => {
    const shown = displayPath(p, s.cwd, s.id, aliases);
    if (shown.alias) used.set(shown.alias[0], (used.get(shown.alias[0]) ?? new Set()).add(shown.alias[1]));
    return shown.path;
  };
  // Root turn number of each turn and of each subagent thread, from 1.
  const turnOf = new Map<string, number>();
  const threadTurn = new Map<string, number>();
  rootTurns(s).forEach((t, i) => {
    turnOf.set(t.id, i + 1);
    for (const id of spawnedThreads(s, t)) threadTurn.set(id, i + 1);
  });
  // A subagent shows as its agent type, or as subagent when the harness logs
  // none. Labels that several subagents share get a number in logged order.
  const subagents = s.threads.filter((t) => t.parentId !== null);
  const baseLabel = (t: (typeof subagents)[number]) => t.agentType ?? "subagent";
  const labels = new Map(subagents.map((t) => {
    const same = subagents.filter((x) => baseLabel(x) === baseLabel(t));
    return [t.id, same.length > 1 ? `${baseLabel(t)} ${same.indexOf(t) + 1}` : baseLabel(t)];
  }));
  const threadName = (id: string) => oneLine(labels.get(id) ?? "root", 24);
  // Harnesses record a compaction as an event or as a model call.
  const compactions = (thread: string) => [
    ...s.compactions.filter((c) => c.threadId === thread).map((c) => c.endedAt),
    ...s.modelCalls.filter((c) => c.threadId === thread && c.purpose === "compaction").map((c) => c.endedAt),
  ];
  // Each path of a read call gets an equal share of the call's result.
  const reads: Read[] = [];
  const lastRead = new Map<string, number | null>();
  const calls = s.toolCalls.filter(isRead).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  for (const call of calls) {
    const share = (n: number | null) => (n === null ? null : n / call.paths.length);
    const tokens = share(call.resultChars === null ? null : call.resultChars / CHARS_PER_TOKEN);
    for (const raw of call.paths) {
      const path = relative(raw);
      const key = `${call.threadId}\u0000${path}`;
      const before = lastRead.get(key);
      const repeat = before !== undefined;
      const afterCompaction = repeat && compactions(call.threadId).some((at) => at > (before ?? -Infinity) && at <= (call.startedAt ?? Infinity));
      lastRead.set(key, call.startedAt);
      reads.push({ call, path, turn: (call.turnId && turnOf.get(call.turnId)) || threadTurn.get(call.threadId) || 0, thread: threadName(call.threadId), tokens, lines: share(call.resultLines), words: share(call.resultWords), repeat, afterCompaction });
    }
  }
  if (!reads.length) return "No file reads with a path in this session.";
  const tokensOf = (rs: Read[]) => sum(rs.map((r) => r.tokens ?? 0));
  const known = reads.some((r) => r.tokens !== null);
  const tokText = (rs: Read[]) => (!rs.length || rs.some((r) => r.tokens !== null) ? tok(Math.round(tokensOf(rs))) : "-");
  // Lines and words summed over reads, or - when no read of them logged the count.
  const count = (rs: Read[], key: "lines" | "words") => (rs.some((r) => r[key] !== null) ? String(Math.round(sum(rs.map((r) => r[key] ?? 0)))) : "-");
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const edited = new Set(s.toolCalls.filter(isWrite).flatMap((t) => t.paths.map(relative)));

  const byPath = new Map<string, Read[]>();
  for (const r of reads) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
  const files = [...byPath].sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  const hidden = files.slice(shown.length);
  const fileRows = shown.map(([path, rs], i) => [
    String(i + 1), path, String(rs.length), turnList(rs.map((r) => r.turn)), count(rs, "lines"), count(rs, "words"), tokText(rs),
    edited.has(path) ? "yes" : "", String(rs.filter((r) => r.afterCompaction).length || ""),
  ]);

  const instructions = reads.filter((r) => INSTRUCTIONS.test(r.path));
  // One row per file and thread, in the order each was first read.
  const byThread = new Map<string, Read[]>();
  for (const r of instructions) byThread.set(`${r.thread}\u0000${r.path}`, [...(byThread.get(`${r.thread}\u0000${r.path}`) ?? []), r]);
  const instructionRows = [...byThread.values()].map((rs, i) => [String(i + 1), rs[0].path, rs[0].thread, String(rs.length), turnList(rs.map((r) => r.turn)), count(rs, "lines"), count(rs, "words"), tokText(rs)]);

  const largest = calls.filter((c) => c.resultChars !== null).sort((a, b) => b.resultChars! - a.resultChars!).slice(0, LARGEST_SHOWN);
  const largestRows = largest.map((c, i) => {
    const r = reads.find((x) => x.call === c)!;
    return [String(i + 1), r.turn ? String(r.turn) : "-", r.thread, oneLine(relative(c.paths[0]), 60) + (c.paths.length > 1 ? ` +${c.paths.length - 1} more` : ""), c.lines ?? "", c.resultLines ?? "-", c.resultWords ?? "-", tok(Math.round(c.resultChars! / CHARS_PER_TOKEN))].map(String);
  });

  const repeats = reads.filter((r) => r.repeat);
  const rootReads = reads.filter((r) => r.call.threadId === root);
  const peak = peakContext(s.modelCalls.filter((c) => c.threadId === root)).tokens;
  const share = peak && known ? `, ${Math.round((tokensOf(rootReads) / peak) * 100)}% of peak context ${tok(peak)}` : "";
  const header = [
    ["Session", `${s.harness} ${s.id}`],
    ["Directory", folderName(s.cwd)],
    ["Reads", `${plural(calls.length, "call")}, ${plural(files.length, "file")}, ${known ? `${tok(Math.round(tokensOf(reads)))} tokens` : "result size unknown"}; root thread ${tokText(rootReads)}${share}`],
    ...[...used].map(([name, prefixes]) => ["Alias", `${name} = ${[...prefixes].join(", ")}`]),
    ["Repeats", `${plural(repeats.length, "read")} of ${plural(new Set(repeats.map((r) => r.path)).size, "file")}, ${tokText(repeats)} tokens; ${repeats.filter((r) => r.afterCompaction).length} after a compaction`],
  ].map(([k, v]) => `${k.padEnd(9)}  ${v}`);

  return [
    ...header,
    "",
    "Files read",
    table(["#", "path", "reads", "turns", "lines", "words", "tokens", "edited", "after compaction"], fileRows, [0, 2, 4, 5, 6, 8]),
    ...(hidden.length ? [`... ${hidden.length} more, ${tokText(hidden.flatMap(([, rs]) => rs))} tokens (-a to list all)`] : []),
    "",
    "Skills and instructions",
    instructionRows.length ? table(["#", "path", "thread", "reads", "turns", "lines", "words", "tokens"], instructionRows, [0, 3, 5, 6, 7]) : "none read",
    "",
    "Largest reads",
    largestRows.length ? table(["#", "turn", "thread", "path", "range", "lines", "words", "tokens"], largestRows, [0, 1, 5, 6, 7]) : "result sizes unknown",
  ].join("\n");
}
