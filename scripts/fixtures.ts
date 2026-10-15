// Cut redacted fixtures from an explicit, uncommitted source map.
import { readFileSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ADAPTERS, cutClaudeJobFixture, isHarnessName, type Adapter, type HarnessName } from "../src/harnesses/index.ts";

type Cut = { harness: HarnessName; id: string; out: string; roots?: string[]; options: Parameters<Adapter["cutFixture"]>[3] }
  | { harness: "claude-job"; id: string; out: string; session: string };
const source = process.argv[2];
if (!source) throw new Error("usage: npm run fixtures -- <private-source-map.json>; see docs/fixtures.md");
const input: unknown = JSON.parse(readFileSync(source, "utf8"));
if (!Array.isArray(input) || input.length === 0) throw new Error("fixture source map must be a nonempty array");
const fixtureRoots = ["test/fixtures", "test/fixture-variants", "test/job-fixtures"].map((path) => resolve(path) + sep);
const cuts: Cut[] = input.map((value: unknown) => {
  if (!value || typeof value !== "object" || !("harness" in value) || !("id" in value) || !("out" in value)
    || typeof value.harness !== "string" || typeof value.id !== "string" || typeof value.out !== "string") {
    throw new Error("each fixture source needs string harness, id and out fields");
  }
  const { harness, id, out } = value;
  if (!fixtureRoots.some((root) => resolve(out).startsWith(root))) throw new Error("fixture output must be below a test fixture directory");
  if (harness === "claude-job") {
    if (!("session" in value) || typeof value.session !== "string") throw new Error("a Claude job needs its session");
    return { harness, id, out, session: value.session };
  }
  if (!isHarnessName(harness)) throw new Error(`unknown fixture harness: ${harness}`);
  const roots = "roots" in value ? value.roots : undefined;
  if (roots !== undefined && (!Array.isArray(roots) || !roots.every((root) => typeof root === "string"))) throw new Error("roots must be string paths");
  const options: NonNullable<Parameters<Adapter["cutFixture"]>[3]> = {};
  if ("children" in value) {
    if (!Array.isArray(value.children) || !value.children.every((child) => typeof child === "string")) throw new Error("children must be string ids");
    options.children = value.children;
  }
  if ("omitSignals" in value) {
    if (typeof value.omitSignals !== "boolean") throw new Error("omitSignals must be boolean");
    options.omitSignals = value.omitSignals;
  }
  if ("launchResult" in value) {
    const result = value.launchResult;
    if (!result || typeof result !== "object" || !("prompt" in result) || !("reply" in result)
      || typeof result.prompt !== "string" || typeof result.reply !== "string") throw new Error("launchResult needs prompt and reply strings");
    options.launchResult = { prompt: result.prompt, reply: result.reply };
  }
  return { harness, id, out, roots, options };
});
// Validate the complete source map before replacing any fixture directory.
for (const directory of new Set(cuts.map((cut) => cut.out))) rmSync(directory, { recursive: true, force: true });
for (const cut of cuts) {
  if (cut.harness === "claude-job") cutClaudeJobFixture(cut.id, cut.session, cut.out);
  else ADAPTERS[cut.harness].cutFixture(cut.id, cut.out, cut.roots, cut.options);
  console.log(`${cut.harness}: fixture written to ${cut.out}`);
}
await import("./repo-fixture.ts");
console.log("Review redaction, pseudonymize fixture identities/times, then regenerate the golden files before committing.");
