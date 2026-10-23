// Copies raw harness logs into the archive before harnesses delete them.
// uc-6. It reads no record formats: each harness names its live directory and files.
import { closeSync, constants, existsSync, fchmodSync, fstatSync, futimesSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ADAPTERS, ARCHIVE_ROOT, unionFiles } from "../harnesses/index.ts";
import { table } from "./format.ts";

// Copies keep whole milliseconds of the modification time.
const mtime = (file: string) => Math.trunc(statSync(file).mtimeMs);

export type ArchiveResult = { harness: string; files: number; copied: number; shrunk: number };

function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const source = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const target = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(target, 0o600);
      const buffer = Buffer.alloc(64 * 1024);
      let size: number;
      while ((size = readSync(source, buffer)) > 0) {
        let written = 0;
        while (written < size) written += writeSync(target, buffer, written, size - written);
      }
      const s = fstatSync(source);
      futimesSync(target, s.atime, s.mtime);
    } finally { closeSync(target); }
  } finally { closeSync(source); }
}

// Never deletes. Copies a file that is new or has grown. A live file smaller
// than its archived copy is kept next to it as <name>.shrunk-<n>, once.
export function archiveTree(live: string, target: string, include: (rel: string) => boolean): Omit<ArchiveResult, "harness"> {
  const result = { files: 0, copied: 0, shrunk: 0 };
  for (const [rel, from] of unionFiles([live], include)) {
    result.files++;
    const to = join(target, rel);
    const src = statSync(from);
    if (!existsSync(to)) {
      copy(from, to);
      result.copied++;
      continue;
    }
    const dst = statSync(to);
    if (src.size > dst.size || (src.size === dst.size && mtime(from) > mtime(to))) {
      copy(from, to);
      result.copied++;
    } else if (src.size < dst.size) {
      let n = 1;
      for (; existsSync(`${to}.shrunk-${n}`); n++) {
        const kept = `${to}.shrunk-${n}`;
        if (statSync(kept).size === src.size && mtime(kept) >= mtime(from)) break;
      }
      if (!existsSync(`${to}.shrunk-${n}`)) {
        copy(from, `${to}.shrunk-${n}`);
        result.shrunk++;
      }
    }
  }
  return result;
}

export function archiveAll(root = ARCHIVE_ROOT): ArchiveResult[] {
  const out: ArchiveResult[] = [];
  for (const [harness, adapter] of Object.entries(ADAPTERS)) {
    if (!adapter.archive) continue;
    out.push({ harness, ...archiveTree(adapter.archive.live, join(root, harness), adapter.archive.include) });
  }
  return out;
}

export function archiveCommand(): string {
  const rows = archiveAll().map((r) => [r.harness, String(r.files), String(r.copied), String(r.shrunk)]);
  return table(["harness", "files", "copied", "shrunk"], rows, [1, 2, 3]);
}
