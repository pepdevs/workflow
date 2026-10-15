// Claude Code keeps its claude.ai OAuth login in ~/.claude/.credentials.json.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDENTIALS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");

// The OAuth access token, or an error naming why it is unusable.
export function claudeToken(now = Date.now()): string {
  let oauth: any;
  try {
    oauth = JSON.parse(readFileSync(CREDENTIALS, "utf8")).claudeAiOauth;
  } catch {
    throw new Error("Claude Code is not logged in to claude.ai");
  }
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) throw new Error("Claude Code is not logged in to claude.ai");
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) throw new Error("Claude Code login expired; run claude once to refresh it");
  return oauth.accessToken;
}
