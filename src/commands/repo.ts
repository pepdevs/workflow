import { existsSync } from "node:fs";
import { measureRepository, formatRepository } from "../repos/index.ts";

export function repoCommand(args: string[]): string {
  const words: string[] = [];
  let depth = 2;
  let largest = 10;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-d" || args[i] === "-n") {
      const value = Number(args[++i]);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("repo: -d and -n need nonnegative integers");
      if (args[i - 1] === "-d") depth = value;
      else largest = value;
    } else words.push(args[i]);
  }
  if (words.length > 2) throw new Error("repo: usage: wf repo [directory] [commit] [-d depth] [-n files]");
  const looksLikePath = (value: string) => value.startsWith(".") || value.startsWith("/") || value.includes("/");
  const directory = words[0] && (existsSync(words[0]) || looksLikePath(words[0]) || words.length === 2) ? words[0] : process.cwd();
  const commit = words[0] && directory === process.cwd() && !existsSync(words[0]) ? words[0] : words[1] ?? "HEAD";
  if (!existsSync(directory)) return `repo: directory does not exist: ${directory}`;
  try { return formatRepository(measureRepository(directory, commit), depth, largest); }
  catch (error) { return `repo: ${error instanceof Error ? error.message.replace(/^repo: /, "") : String(error)}`; }
}
