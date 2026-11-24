// Claude Code's claude.ai OAuth login: CLAUDE_CODE_OAUTH_TOKEN when set, as
// `claude setup-token` prints it for headless use, else ~/.claude/.credentials.json.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDENTIALS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
const NO_LOGIN = "Claude Code is not logged in to claude.ai; run claude setup-token and set CLAUDE_CODE_OAUTH_TOKEN";

// The OAuth access token, or an error naming why it is unusable.
export function claudeToken(now = Date.now()): string {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (env) return env;
  let oauth: any;
  try {
    oauth = JSON.parse(readFileSync(CREDENTIALS, "utf8")).claudeAiOauth;
  } catch {
    throw new Error(NO_LOGIN);
  }
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) throw new Error(NO_LOGIN);
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) throw new Error("Claude Code login expired; run claude once to refresh it, or set CLAUDE_CODE_OAUTH_TOKEN from claude setup-token");
  return oauth.accessToken;
}
