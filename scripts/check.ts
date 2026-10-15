// Type checks and runs every test, then prints the duration. Above 10 seconds
// it warns: AGENTS.md rule 8 asks to delete or merge tests before adding more.
import { spawnSync } from "node:child_process";

const LIMIT_SECONDS = 10;
const started = Date.now();
const steps: [string, string[]][] = [
  [process.platform === "win32" ? "python" : "python3", ["scripts/public-check.py"]],
  ["npx", ["tsc", "-p", "."]],
  [process.execPath, ["--import", "./scripts/test-config.ts", "--test", "test/*.test.ts"]],
];
let failed = false;
for (const [cmd, args] of steps) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(`${cmd}: ${result.error.message}`);
    failed = true;
    break;
  }
}
const seconds = (Date.now() - started) / 1000;
console.log(`\ncheck ${failed ? "failed" : "passed"} in ${seconds.toFixed(1)}s`);
if (seconds > LIMIT_SECONDS) {
  console.log(`warning: check took over ${LIMIT_SECONDS}s. Delete or merge tests before adding more (AGENTS.md rule 8).`);
}
process.exit(failed ? 1 : 0);
