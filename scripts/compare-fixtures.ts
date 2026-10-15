// Compare adapter-level structure and usage before and after fixture pseudonymization.
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ADAPTERS, type HarnessName } from "../src/harnesses/index.ts";
import type { Session } from "../src/model.ts";

const source = process.argv[2];
if (!source) throw new Error("usage: node scripts/compare-fixtures.ts <original-checkout>");
const original = await import(pathToFileURL(join(resolve(source), "src/harnesses/index.ts")).href);
const signature = (session: Session) => ({
  threads: session.threads.length,
  turns: session.turns.length,
  tools: session.toolCalls.length,
  incidents: session.incidents.length,
  compactions: session.compactions.length,
  reportedCost: session.reportedCostUsd,
  calls: session.modelCalls.map((call) => ({
    provider: call.provider, model: call.model, purpose: call.purpose, usage: call.usage,
    reportedCost: call.reportedCostUsd, inferred: call.startInferred,
    duration: call.startedAt === null ? null : call.endedAt - call.startedAt,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
});
const cases: [HarnessName, string][] = [
  ...(Object.keys(ADAPTERS) as HarnessName[]).map((name): [HarnessName, string] => [name, `test/fixtures/${name}`]),
  ["grok", "test/fixture-variants/grok"],
  ["grok", "test/fixture-variants/grok-launch-result/grok"],
  ["grok", "test/fixture-variants/grok-missing-signals"],
  ["claude", "test/job-fixtures/claude"],
];
for (const [name, directory] of cases) {
  const beforeRoot = [join(resolve(source), directory)];
  const afterRoot = [resolve(directory)];
  const before = original.ADAPTERS[name].list(beforeRoot).map((ref: { ref: string }) => JSON.stringify(signature(original.ADAPTERS[name].load(ref.ref, beforeRoot)))).sort();
  const after = ADAPTERS[name].list(afterRoot).map((ref) => JSON.stringify(signature(ADAPTERS[name].load(ref.ref, afterRoot)))).sort();
  assert.deepEqual(after, before, `${name}: fixture semantics changed`);
  console.log(`${directory}: ${after.length} root sessions preserve structure, usage, costs, and call durations.`);
}
