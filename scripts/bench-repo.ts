// Time twenty committed workflow trees and count distinct regular blobs across them.
import { spawnSync } from "node:child_process";
import { measureRepository } from "../src/repos/index.ts";

const directory = process.argv[2] ?? ".";
const git = (args: string[], input?: string): Buffer => {
  const result = spawnSync("git", args, { cwd: directory, input, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return result.stdout;
};
const commits = git(["rev-list", "-n", "20", "HEAD"]).toString().trim().split("\n");
if (commits.length < 20) throw new Error("Need at least 20 commits");
const blobs = new Set<string>();
let gitMs = 0;
let tokenMs = 0;
for (const commit of commits) {
  const start = performance.now();
  for (const record of git(["ls-tree", "-rz", "--full-tree", commit]).toString().split("\0")) {
    const match = /^(100644|100755) blob ([0-9a-f]+)\t/s.exec(record);
    if (match) blobs.add(match[2]);
  }
  const listingMs = performance.now() - start;
  const report = measureRepository(directory, commit);
  gitMs += listingMs + report.gitMs;
  tokenMs += report.tokenMs;
}
const sizes = git(["cat-file", "--batch-check=%(objectsize)"], [...blobs].join("\n") + "\n").toString().trim().split("\n");
const bytes = sizes.reduce((sum, size) => sum + Number(size), 0);
console.log(`commits=${commits.length} unique_blobs=${blobs.size} bytes=${bytes} git_ms=${gitMs.toFixed(1)} tokenise_ms=${tokenMs.toFixed(1)}`);
