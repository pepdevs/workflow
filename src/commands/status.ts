// uc-10: what runs now, and which sessions are stuck or spiralling.
import { ADAPTERS, HARNESS_NAMES, type HarnessName, type RunningSession } from "../harnesses/index.ts";
import { CONTEXT_BUDGET, shellProgram, STATUS } from "../catalog.ts";
import { type Session, type ToolCall } from "../model.ts";
import { type Found, findSessions, parseAt, shortIds } from "./find.ts";
import { dur, folderName, oneLine, table, tok, usd } from "./format.ts";
import { callCost, contextOf, countBy, launchOf, primaryModel, rootThread, rootTurns, sum, titleOf } from "../facts.ts";

// The session as its logs stood at `at`: later events are dropped, and turns
// and tool calls that ended later are still open.
function asOf(s: Session, at: number): Session {
  const open = <T extends { endedAt: number | null }>(x: T): T => (x.endedAt !== null && x.endedAt > at ? { ...x, endedAt: null } : x);
  return {
    ...s,
    turns: s.turns.filter((t) => t.startedAt <= at).map(open),
    modelCalls: s.modelCalls.filter((c) => c.endedAt <= at),
    toolCalls: s.toolCalls.filter((t) => t.startedAt !== null && t.startedAt <= at).map(open),
    incidents: s.incidents.filter((i) => i.at <= at),
  };
}

// Stop reasons of a model call that asked for tools, so its turn goes on.
const TOOL_USE_STOPS = new Set(["tool_use", "toolUse", "tool-calls"]);

// Ended: the logs show an open turn, but no harness process writes the session.
export type SessionState = "working" | "stuck" | "ended" | "waiting" | "idle";

export type FlagKind = "repeated command" | "failed tools" | "hourly cost" | "context budget" | "compactions" | "incidents";

export type Status = {
  state: SessionState;
  lastEventAt: number;
  turnStartedAt: number | null;
  running: { name: string; startedAt: number } | null;
  lastHourUsd: number;
  context: number | null;
  model: string | null;
  flags: string[];
  flagKinds: FlagKind[];
};

// State and warning flags of a session at `at`, from its logs up to then.
// Working: a root turn is open and events keep arriving. Stuck: the open turn
// has had no event for STATUS.quiet minutes, or one tool has run STATUS.tool
// minutes. Waiting: a tool is asking the person. Idle: no root turn is open.
export function sessionStatus(full: Session, at: number): Status {
  const s = asOf(full, at);
  const minute = 60_000;
  const lastEventAt = Math.max(
    -Infinity,
    ...s.turns.flatMap((t) => [t.startedAt, t.endedAt ?? t.startedAt]),
    ...s.modelCalls.map((c) => c.endedAt),
    ...s.toolCalls.flatMap((t) => [t.startedAt!, t.endedAt ?? t.startedAt!]),
  );
  const openTools = s.toolCalls.filter((t) => t.endedAt === null).sort((a, b) => a.startedAt! - b.startedAt!);
  // Adapters close the last turn at its last event. It is still open while
  // Codex has not completed it, its last call asked for tools, or a tool runs.
  const lastTurn = rootTurns(s).at(-1) ?? null;
  const lastCall = s.modelCalls.filter((c) => c.turnId === lastTurn?.id).at(-1);
  const openTurn =
    lastTurn && (lastTurn.endedAt === null || !lastCall || TOOL_USE_STOPS.has(lastCall.stopReason ?? "") || openTools.some((t) => t.turnId === lastTurn.id))
      ? lastTurn
      : null;
  const tool = openTools.find((t) => t.category !== "agent") ?? openTools[0] ?? null;
  let state: SessionState = "idle";
  if (openTurn) {
    if (tool?.category === "user_interaction") state = "waiting";
    else if (tool && tool.category !== "agent" && at - tool.startedAt! >= STATUS.tool * minute) state = "stuck";
    else if ((!tool || tool.category === "agent") && at - lastEventAt >= STATUS.quiet * minute) state = "stuck";
    else state = "working";
  }
  const hourAgo = at - 60 * minute;
  const lastHour = s.modelCalls.filter((c) => c.endedAt > hourAgo);
  const lastHourUsd = sum(lastHour.map((c) => callCost(c) ?? 0));
  const root = rootThread(s);
  // Adapters append subagent calls after the root thread's, so take the latest root call by time.
  const lastRootCall = s.modelCalls.filter((c) => c.threadId === root && c.purpose === "turn").sort((a, b) => a.endedAt - b.endedAt).at(-1);
  const context = lastRootCall ? contextOf(lastRootCall) : null;
  const recent = s.toolCalls.filter((t) => t.startedAt! > hourAgo).sort((a, b) => a.startedAt! - b.startedAt!).slice(-20);
  const flags: string[] = [];
  const flagKinds: FlagKind[] = [];
  const flag = (kind: FlagKind, text: string) => { flagKinds.push(kind); flags.push(text); };
  for (const f of toolFlags(recent)) flag(f.kind, f.detail);
  if (lastHourUsd >= STATUS.costPerHourUsd) flag("hourly cost", `${usd(lastHourUsd)} in the last hour`);
  if (lastRootCall?.kind !== "turn_aggregate" && context !== null && context > CONTEXT_BUDGET) flag("context budget", `context ${tok(context)}`);
  const compactions = lastHour.filter((c) => c.purpose === "compaction").length;
  if (compactions >= STATUS.compactions) flag("compactions", `${compactions} compactions in the last hour`);
  const incidents = countBy(s.incidents.filter((i) => i.at > hourAgo), (i) => i.kind);
  if (incidents.length) flag("incidents", incidents.map(([k, n]) => `${k} ×${n}`).join(", "));
  return {
    state,
    lastEventAt,
    turnStartedAt: openTurn?.startedAt ?? null,
    running: tool ? { name: tool.command ? shellProgram(tool.command) || tool.name : tool.name, startedAt: tool.startedAt! } : null,
    lastHourUsd,
    context,
    model: lastRootCall ? primaryModel(lastRootCall) : lastTurn?.model ?? null,
    flags,
    flagKinds,
  };
}

// The repeated-command and failed-tool flags over a time-ordered window of tool calls.
function toolFlags(recent: ToolCall[]): { kind: "repeated command" | "failed tools"; detail: string }[] {
  const out: { kind: "repeated command" | "failed tools"; detail: string }[] = [];
  // A bare sleep waits for other work, so repeating it is no loop.
  const [command, repeats] = countBy(recent.filter((t) => t.command && !/^sleep\s+[\d.]+[smhd]?$/.test(t.command.trim())), (t) => t.command!)[0] ?? ["", 0];
  if (repeats >= STATUS.repeat) out.push({ kind: "repeated command", detail: `same command ×${repeats}: ${oneLine(command, 40)}` });
  const failed = recent.slice(-10).filter((t) => t.status === "failed").length;
  if (failed >= STATUS.failed) out.push({ kind: "failed tools", detail: `${failed} of the last 10 tool calls failed` });
  return out;
}

export type FlagEvent = { kind: "repeated command" | "failed tools"; at: number; detail: string };

// The first time each tool flag of wf status fired over the whole session: the
// status window evaluated as of each tool call's start.
export function toolFlagHistory(s: Session): FlagEvent[] {
  const calls = s.toolCalls.filter((t) => t.startedAt !== null).sort((a, b) => a.startedAt! - b.startedAt!);
  const seen = new Map<FlagEvent["kind"], FlagEvent>();
  let from = 0;
  for (let i = 0; i < calls.length && seen.size < 2; i++) {
    const at = calls[i]!.startedAt!;
    while (calls[from]!.startedAt! <= at - 60 * 60_000) from++;
    for (const f of toolFlags(calls.slice(Math.max(from, i - 19), i + 1))) if (!seen.has(f.kind)) seen.set(f.kind, { kind: f.kind, at, detail: f.detail });
  }
  return [...seen.values()].sort((a, b) => a.at - b.at);
}

// Reconcile logs with a known process inventory before either command filters rows.
export function observedStatus(s: Session, at: number, pids: number[] | null): Status {
  const st = sessionStatus(s, at);
  if (pids !== null && pids.length === 0 && st.state !== "idle") st.state = "ended";
  return st;
}

export type SubagentStatus = {
  threadId: string;
  depth: number;
  name: string | null;
  model: string | null;
  state: SessionState;
  lastEventAt: number;
  startedAt: number;
  running: { name: string; startedAt: number } | null;
  lastHourUsd: number;
  costUsd: number;
};

// Subagent threads still running at `at`, each after the thread that spawned it.
// A subagent runs while the tool call that spawned it is open, or while its own
// last turn is open by the same rules as a root turn. State follows the root's rules.
export function subagentStatus(full: Session, at: number): SubagentStatus[] {
  const s = asOf(full, at);
  const minute = 60_000;
  const root = rootThread(s);
  const spawner = new Map(s.toolCalls.filter((t) => t.spawnsThreadId).map((t) => [t.spawnsThreadId!, t]));
  for (const t of s.threads) {
    const tool = t.spawnedByToolCallId ? s.toolCalls.find((x) => x.id === t.spawnedByToolCallId) : undefined;
    if (tool && !spawner.has(t.id)) spawner.set(t.id, tool);
  }
  const out: SubagentStatus[] = [];
  const visit = (parentId: string, depth: number) => {
    for (const thread of s.threads.filter((t) => t.parentId === parentId)) {
      const calls = s.modelCalls.filter((c) => c.threadId === thread.id).sort((a, b) => a.endedAt - b.endedAt);
      const turns = s.turns.filter((t) => t.threadId === thread.id).sort((a, b) => a.startedAt - b.startedAt);
      const tools = s.toolCalls.filter((t) => t.threadId === thread.id);
      const openTools = tools.filter((t) => t.endedAt === null).sort((a, b) => a.startedAt! - b.startedAt!);
      const lastTurn = turns.at(-1);
      const lastCall = calls.filter((c) => c.turnId === lastTurn?.id).at(-1) ?? calls.at(-1);
      const lastTurnCall = calls.filter((c) => c.purpose === "turn").at(-1);
      const spawn = spawner.get(thread.id);
      const open = (spawn !== undefined && spawn.endedAt === null)
        || (lastTurn !== undefined && (lastTurn.endedAt === null || TOOL_USE_STOPS.has(lastCall?.stopReason ?? "") || openTools.length > 0));
      if (!open || calls.length + turns.length + tools.length === 0) continue;
      const lastEventAt = Math.max(
        -Infinity,
        ...turns.flatMap((t) => [t.startedAt, t.endedAt ?? t.startedAt]),
        ...calls.map((c) => c.endedAt),
        ...tools.flatMap((t) => [t.startedAt!, t.endedAt ?? t.startedAt!]),
      );
      const startedAt = Math.min(Infinity, spawn?.startedAt ?? Infinity, ...turns.map((t) => t.startedAt), ...calls.map((c) => c.startedAt ?? c.endedAt));
      const tool = openTools.find((t) => t.category !== "agent") ?? openTools[0] ?? null;
      let state: SessionState = "working";
      if (tool?.category === "user_interaction") state = "waiting";
      else if (tool && tool.category !== "agent" && at - tool.startedAt! >= STATUS.tool * minute) state = "stuck";
      else if ((!tool || tool.category === "agent") && at - lastEventAt >= STATUS.quiet * minute) state = "stuck";
      out.push({
        threadId: thread.id,
        depth,
        name: thread.name,
        model: lastTurnCall ? primaryModel(lastTurnCall) : null,
        state,
        lastEventAt,
        startedAt,
        running: tool ? { name: tool.command ? shellProgram(tool.command) || tool.name : tool.name, startedAt: tool.startedAt! } : null,
        lastHourUsd: sum(calls.filter((c) => c.endedAt > at - 60 * minute).map((c) => callCost(c) ?? 0)),
        costUsd: sum(calls.map((c) => callCost(c) ?? 0)),
      });
      visit(thread.id, depth + 1);
    }
  };
  visit(root, 1);
  return out;
}

const STATE_ORDER: SessionState[] = ["stuck", "ended", "waiting", "working", "idle"];

type StatusRow = Pick<Status, "state"> & { pids: number[]; running: string };

// The header and running cells for listed rows.
// A process makes a row running; an ended row has no process and no running tool.
export function statusPresentation(rows: StatusRow[], finished: number, processesKnown: boolean): { header: string; running: string[] } {
  const hidden = finished ? ` ${finished} finished session${finished === 1 ? "" : "s"} hidden; wf ls -d1h lists them.` : "";
  if (rows.length === 0) return { header: `No active sessions.${hidden}`, running: [] };
  if (!processesKnown) {
    const counts = STATE_ORDER.map((state) => [state, rows.filter((row) => row.state === state).length] as const).filter(([, count]) => count > 0);
    return {
      header: `${rows.length} active session${rows.length === 1 ? "" : "s"}: ${counts.map(([state, count]) => `${count} ${state}`).join(", ")}.${hidden}`,
      running: rows.map((row) => row.running),
    };
  }
  const live = rows.filter((row) => row.pids.length > 0);
  const states = STATE_ORDER.filter((state) => state !== "ended").map((state) => [state, live.filter((row) => row.state === state).length] as const).filter(([, count]) => count > 0);
  const ended = rows.filter((row) => row.state === "ended").length;
  const running = `${live.length} running${states.length ? ` (${states.map(([state, count]) => `${count} ${state}`).join(", ")})` : ""}`;
  return {
    header: `${running}${ended ? `, ${ended} ended without a process` : ""}.${hidden}`,
    running: rows.map((row) => row.state === "ended" ? "-" : row.running),
  };
}

// Sessions with an event in the `window` minutes before `at`.
export function statusCommand(flags: Record<string, string>, base: string | undefined, now: number): string {
  const at = flags.a === undefined ? now : parseAt(flags.a);
  const window = flags.w === undefined ? STATUS.window : parseMinutes(flags.w);
  const from = at - window * 60_000;
  const short = shortIds(findSessions(base).map((f) => f.id));
  // Processes exist only now and only for the default log locations.
  const live = flags.a === undefined && base === undefined ? runningSessions() : null;
  const rows: { found: Found; s: Session; st: Status; pids: number[] }[] = [];
  let finished = 0;
  for (const found of findSessions(base).filter((f) => f.updatedAt >= from)) {
    let s: Session;
    try {
      s = ADAPTERS[found.harness].load(found.ref, found.roots);
    } catch {
      continue;
    }
    if (s.threads.length === 0) continue;
    const pids = live?.filter((r) => r.harness === found.harness && r.id === found.id).map((r) => r.pid) ?? [];
    const st = observedStatus(s, at, live === null ? null : pids);
    if (st.lastEventAt < from || st.lastEventAt > at) continue;
    // An idle session without a process has finished.
    if (live && pids.length === 0 && st.state === "idle") {
      finished++;
      continue;
    }
    rows.push({ found, s, st, pids });
  }
  rows.sort((a, b) => STATE_ORDER.indexOf(a.st.state) - STATE_ORDER.indexOf(b.st.state) || b.st.lastEventAt - a.st.lastEventAt);
  const presentation = statusPresentation(rows.map(({ st, pids }) => ({ state: st.state, pids, running: st.running ? `${oneLine(st.running.name, 16)} ${dur(at - st.running.startedAt)}` : "-" })), finished, live !== null);
  if (rows.length === 0) return presentation.header;
  // Sessions launched by a listed session follow it, indented.
  const key = (harness: string, id: string) => `${harness}:${id}`;
  const listed = new Set(rows.map((r) => key(r.found.harness, r.found.id)));
  const parentKey = (r: (typeof rows)[number]) => {
    const p = launchOf(r.s)?.parent;
    return p && listed.has(key(p.harness, p.id)) ? key(p.harness, p.id) : null;
  };
  const ordered: { row: (typeof rows)[number]; depth: number }[] = [];
  const emit = (parent: string | null, depth: number) => {
    for (const row of rows.filter((r) => parentKey(r) === parent)) {
      ordered.push({ row, depth });
      emit(key(row.found.harness, row.found.id), depth + 1);
    }
  };
  emit(null, 0);
  const indent = (depth: number) => (depth ? `${"  ".repeat(depth - 1)}└ ` : "");
  const out = ordered.flatMap(({ row, depth }) => {
    const { found, s, st, pids } = row;
    // A background subagent can run while its session is idle; an ended session runs none.
    const agents = st.state === "ended" ? [] : subagentStatus(s, at);
    return [[
    found.harness,
    `${indent(depth)}${short.get(found.id) ?? found.id}`,
    launchOf(s)?.skill ?? "-",
    oneLine(folderName(s.cwd), 20),
    oneLine(titleOf(s), 30),
    st.model ?? "-",
    st.state,
    pids.join(",") || "-",
    dur(at - st.lastEventAt),
    st.turnStartedAt === null ? "-" : dur(at - st.turnStartedAt),
    presentation.running[rows.indexOf(row)],
    usd(st.lastHourUsd),
    usd(sum(s.modelCalls.filter((c) => c.endedAt <= at).map((c) => callCost(c) ?? 0))),
    st.flags.join("; ") || "-",
    ], ...agents.map((a) => [
      found.harness,
      `${indent(depth + a.depth)}${a.threadId.slice(0, 8)}`,
      "agent",
      "-",
      oneLine(a.name ?? "-", 30),
      a.model ?? "-",
      a.state,
      "-",
      dur(at - a.lastEventAt),
      dur(at - a.startedAt),
      a.running ? `${oneLine(a.running.name, 16)} ${dur(at - a.running.startedAt)}` : "-",
      usd(a.lastHourUsd),
      usd(a.costUsd),
      "-",
    ])];
  });
  return [
    presentation.header,
    "",
    table(["harness", "id", "skill", "directory", "title or first prompt", "model", "state", "pid", "quiet", "turn", "running", "last hour", "cost", "flags"], out, [7, 8, 9, 11, 12]),
  ].join("\n");
}

// Every live harness process with the root session it writes.
function runningSessions(): (RunningSession & { harness: HarnessName })[] {
  return HARNESS_NAMES.flatMap((harness) => ADAPTERS[harness].running().map((r) => ({ ...r, harness })));
}

// Minutes from `-w`: N minutes, Nh or Nd.
function parseMinutes(text: string): number {
  const m = /^(\d+(?:\.\d+)?)([mhd]?)$/.exec(text);
  if (!m) throw new Error(`bad window ${text}: use N (minutes), Nh or Nd`);
  return Number(m[1]) * ({ "": 1, m: 1, h: 60, d: 1440 } as Record<string, number>)[m[2]];
}
