// Claude Code keeps its claude.ai OAuth login in ~/.claude/.credentials.json and
// refreshes it only when claude runs. The usage endpoint needs that login's
// profile scope: the inference-only token of `claude setup-token` gets HTTP 403.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDENTIALS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
const NO_LOGIN = "Claude Code is not logged in to claude.ai; run claude auth login";
// Refresh this long before expiry, so an hourly reader never holds a lapsed token.
const MARGIN_MS = 30 * 60_000;

type OAuth = { accessToken?: unknown; expiresAt?: unknown };

function readLogin(): OAuth | null {
  try {
    return JSON.parse(readFileSync(CREDENTIALS, "utf8")).claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

const usable = (o: OAuth | null, now: number): o is { accessToken: string } =>
  typeof o?.accessToken === "string" && !!o.accessToken && !(typeof o.expiresAt === "number" && o.expiresAt <= now + MARGIN_MS);

// One short headless call, which makes Claude Code refresh its stored login. The
// environment token is dropped, so claude uses and refreshes the stored login.
function refreshLogin() {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    execFileSync("claude", ["-p", "Reply with the single word ok.", "--model", "haiku"], { env, cwd: homedir(), stdio: "ignore", timeout: 120_000 });
  } catch {}
}

// The OAuth access token, refreshed through claude when it is near expiry, or an error naming why it is unusable.
export function claudeToken(now = Date.now()): string {
  let oauth = readLogin();
  if (!oauth?.accessToken) throw new Error(NO_LOGIN);
  if (!usable(oauth, now)) {
    refreshLogin();
    oauth = readLogin();
  }
  if (!usable(oauth, now)) throw new Error("Claude Code login expired and claude could not refresh it; run claude auth login");
  return oauth.accessToken;
}
