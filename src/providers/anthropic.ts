// Claude plans: the OAuth usage endpoint that Claude Code's login can read.
import { type AccountUsage, getJson, isRecord, UsageError, usageWindow } from "./common.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const WINDOWS: [string, number][] = [["five_hour", 300], ["seven_day", 10_080], ["seven_day_opus", 10_080], ["seven_day_sonnet", 10_080]];

export function parseClaudeUsage(payload: unknown): AccountUsage {
  if (!isRecord(payload)) throw new UsageError("malformed response");
  const windows = WINDOWS.filter(([key]) => isRecord(payload[key])).map(([key, minutes]) =>
    usageWindow(minutes, payload[key].utilization, payload[key].resets_at),
  );
  return { planType: null, windows: windows.filter((w) => w.usedPercent !== null) };
}

export async function claudeUsage(token: string): Promise<AccountUsage> {
  return parseClaudeUsage(
    await getJson(USAGE_URL, { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" }),
  );
}
