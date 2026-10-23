// Codex CLI reports its own login's rate limits over the app-server protocol:
// JSON-RPC lines on standard input and output.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 10_000;

// The result of account/rateLimits/read.
export function codexRateLimits(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => finish(new Error("codex app-server timed out")), TIMEOUT_MS);
    let buffer = "";
    let bytes = 0;
    let done = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      error ? reject(error) : resolve(value);
    };
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    child.on("error", () => finish(new Error("codex could not start")));
    child.on("close", () => finish(new Error("codex app-server ended before answering")));
    child.stdout.setEncoding("utf8");
    child.stdin.on("error", () => finish(new Error("codex app-server input closed")));
    child.stdout.on("data", (d: string) => {
      if (done) return;
      bytes += Buffer.byteLength(d);
      if (bytes > 1024 * 1024) return finish(new Error("codex app-server output too large"));
      buffer += d;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error) return finish(new Error("codex app-server refused to start"));
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (m.id === 2) {
          return m.error ? finish(new Error("Codex is not logged in")) : finish(null, m.result);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "workflow", version: "1.0.0" }, capabilities: {} } });
  });
}
