import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ADAPTERS, type HarnessName } from "../src/harnesses/index.ts";
import { run } from "../src/cli.ts";

const sha = "a".repeat(40);
const marker = (status = "complete", pullRequest: string | null = "https://github.com/fixture/workflow/pull/12", headSha: string | null = sha) =>
  `<!-- workflow-result: ${JSON.stringify({ schema: 1, status, pullRequest, headSha })} -->`;

function editJsonl(file: string, select: (record: any) => boolean, edit: (record: any) => void): void {
  const records = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  const record = records.findLast(select);
  assert.ok(record, `missing record in ${file}`);
  edit(record);
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function addToReply(harness: HarnessName, root: string, ref: string, text: string): void {
  if (harness === "codex") {
    editJsonl(ref, (r) => r.type === "event_msg" && r.payload?.type === "task_complete", (r) => {
      r.payload.last_agent_message = `${r.payload.last_agent_message ?? ""}\n${text}`;
    });
  } else if (harness === "claude") {
    editJsonl(ref, (r) => r.type === "assistant" && r.message?.stop_reason === "end_turn", (r) => {
      const block = r.message.content.find((b: any) => b.type === "text");
      assert.ok(block);
      block.text += `\n${text}`;
    });
  } else if (harness === "pi") {
    editJsonl(ref, (r) => r.type === "message" && r.message?.role === "assistant" && r.message?.stopReason === "stop", (r) => {
      const block = r.message.content.find((b: any) => b.type === "text");
      assert.ok(block);
      block.text += `\n${text}`;
    });
  } else {
    const db = new DatabaseSync(join(root, readdirSync(root).find((name) => name.endsWith(".db"))!));
    try {
      const messages = db.prepare("select id, data from message where session_id = ? order by time_created, id").all(ref) as { id: string; data: string }[];
      const last = messages.findLast((row) => JSON.parse(row.data).role === "assistant" && JSON.parse(row.data).finish === "stop");
      assert.ok(last);
      const parts = db.prepare("select id, data from part where message_id = ? order by time_created, id").all(last.id) as { id: string; data: string }[];
      const part = parts.findLast((row) => JSON.parse(row.data).type === "text");
      assert.ok(part);
      const data = JSON.parse(part.data);
      data.text += `\n${text}`;
      db.prepare("update part set data = ? where id = ?").run(JSON.stringify(data), part.id);
    } finally {
      db.close();
    }
  }
}

function withFixture(harness: HarnessName, use: (root: string, ref: string) => void): void {
  const temp = mkdtempSync(join(tmpdir(), `workflow-result-${harness}-`));
  const root = join(temp, harness);
  try {
    cpSync(`test/fixtures/${harness}`, root, { recursive: true });
    const ref = ADAPTERS[harness].list([root])[0].ref;
    use(root, ref);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test("each harness reads the last root reply's result", () => {
  for (const harness of ["codex", "claude", "pi", "opencode"] as const) {
    withFixture(harness, (root, ref) => {
      assert.equal(ADAPTERS[harness].load(ref, [root]).result, null, harness);
      addToReply(harness, root, ref, marker());
      assert.deepEqual(ADAPTERS[harness].load(ref, [root]).result, {
        status: "complete", pullRequest: "https://github.com/fixture/workflow/pull/12", headSha: sha,
      }, harness);
      const output = run(["summary", harness, ref, "--root", root]);
      assert.equal(typeof output, "string");
      if (typeof output === "string") assert.match(output, new RegExp(`Result\\s+complete · https://github.com/fixture/workflow/pull/12 · ${sha}`));
    });
  }
});

test("invalid and blocked results in a fixture reply", () => {
  const rows: [string, string, string | null][] = [
    ["malformed JSON", "<!-- workflow-result: broken -->", null],
    ["unsupported schema", marker().replace('"schema":1', '"schema":2'), null],
    ["invalid PR URL", marker().replace("github.com", "example.com"), null],
    ["short SHA", marker().replace(sha, "abc1234"), null],
    ["blocked without PR", marker("blocked", null, null), "blocked"],
  ];
  for (const [name, text, expected] of rows) {
    withFixture("pi", (root, ref) => {
      addToReply("pi", root, ref, text);
      assert.equal(ADAPTERS.pi.load(ref, [root]).result?.status ?? null, expected, name);
      if (name === "blocked without PR") {
        const output = run(["summary", "pi", ref, "--root", root]);
        assert.equal(typeof output, "string");
        if (typeof output === "string") assert.match(output, /Result\s+blocked · no PR/);
      }
    });
  }
});

test("prompt, tool output and child replies cannot link a session", () => {
  withFixture("pi", (root, ref) => {
    editJsonl(ref, (r) => r.type === "message" && r.message?.role === "user", (r) => {
      r.message.content.push({ type: "text", text: marker() });
    });
    editJsonl(ref, (r) => r.type === "message" && r.message?.role === "toolResult", (r) => {
      r.message.content.push({ type: "text", text: marker() });
    });
    assert.equal(ADAPTERS.pi.load(ref, [root]).result, null);
  });
  withFixture("claude", (root, ref) => {
    const child = join(root, "project", readdirSync(join(root, "project")).find((name) => name.endsWith(".jsonl"))!.replace(/\.jsonl$/, ""), "subagents");
    const file = join(child, readdirSync(child).find((name) => name.endsWith(".jsonl"))!);
    editJsonl(file, (r) => r.type === "assistant" && r.message?.content?.some((b: any) => b.type === "text"), (r) => {
      r.message.content.find((b: any) => b.type === "text").text += `\n${marker()}`;
    });
    assert.equal(ADAPTERS.claude.load(ref, [root]).result, null);
  });
});
