// The architecture guards behind AGENTS.md rules 1, 3 and 5.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

// Harness log and credential locations, however the path is built: ".codex/sessions" or join(".codex", "sessions").
const LOG_LOCATIONS = [/\.codex\W+sessions/, /\.claude\W+projects/, /\.pi\W+agent/, /\.grok\W+sessions/, /(?:events|updates|signals|usage|chat_history)\.jsonl?/, /["'](?:updates|chat)["']\s*,\s*["'](?:jsonl|history)["']/, /\.params\??\.update|\.sessionUpdate/, /opencode\.db/, /\.credentials\.json/];

test("only src/harnesses/ names harness log locations", () => {
  const offenders = ["src", "scripts", "test"]
    .flatMap(files)
    // Skips the harnesses, this file, and the fixtures, which are harness logs themselves.
    .filter((f) => f.endsWith(".ts") && !f.startsWith(join("src", "harnesses")) && f !== join("test", "guards.test.ts"))
    .filter((f) => LOG_LOCATIONS.some((re) => re.test(readFileSync(f, "utf8"))));
  assert.deepEqual(offenders, []);
});

// Remote calls belong to provider connectors.
test("only src/providers/ makes remote calls", () => {
  const offenders = ["src", "scripts"]
    .flatMap(files)
    .filter((f) => !f.startsWith(join("src", "providers")))
    .filter((f) => /https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/|(?:execFile|spawn|execFileSync|spawnSync)\s*\(\s*["']gh["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

const PUBLIC = ["src/harnesses/index.ts", "src/catalog.ts", "src/cli.ts", "src/check.ts"].map((f) => resolve(f));

test("tests import only the public entry points", () => {
  const offenders: string[] = [];
  for (const f of files("test").filter((f) => f.endsWith(".ts"))) {
    for (const [, spec] of readFileSync(f, "utf8").matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)) {
      if (spec.startsWith("node:")) continue;
      if (!PUBLIC.includes(resolve(dirname(f), spec))) offenders.push(`${f}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});
