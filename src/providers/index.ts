// Plan usage read from each provider through the login a harness already
// holds. Every source runs in parallel; a failed source reports why and
// leaves the other plans intact.
import { subscriptionOf, type Subscription } from "../catalog.ts";
import { LOGINS } from "../harnesses/index.ts";
import { claudeUsage } from "./anthropic.ts";
import type { AccountUsage, UsageWindow } from "./common.ts";
import { chatGptUsage, parseCodexRateLimits } from "./openai.ts";
import { xaiUsage } from "./xai.ts";
import { zaiUsage } from "./zai.ts";

export { parseClaudeUsage } from "./anthropic.ts";
export { parseChatGptUsage, parseCodexRateLimits } from "./openai.ts";
export { parseXaiBilling } from "./xai.ts";
export { parseZaiQuota } from "./zai.ts";
export type { UsageWindow } from "./common.ts";
export { READINGS_FILE, changedLines, parseReadings, readingLines, recordUsage, recordedReadings, windowKey } from "./readings.ts";

export type PlanUsage = { source: string; provider: string; plan: Subscription | null; planType: string | null; windows: UsageWindow[]; error: string | null };

// `provider` is the harness provider name that data/subscriptions.json lists.
const SOURCES: { source: string; provider: string; read: (now: number) => Promise<AccountUsage> }[] = [
  { source: "codex app-server", provider: "openai", read: async () => parseCodexRateLimits(await LOGINS.codexRateLimits()) },
  { source: "pi openai-codex", provider: "openai-codex", read: async (now) => chatGptUsage(await LOGINS.piBearerToken("openai-codex"), now) },
  { source: "claude oauth", provider: "anthropic", read: async () => claudeUsage(LOGINS.claudeToken()) },
  { source: "pi zai", provider: "zai", read: async () => zaiUsage(await LOGINS.piApiKey("zai")) },
  { source: "pi xai", provider: "xai", read: async () => xaiUsage(await LOGINS.piBearerToken("xai")) },
];

export async function readUsage(now: number): Promise<PlanUsage[]> {
  return Promise.all(
    SOURCES.map(async ({ source, provider, read }) => {
      try {
        const u = await read(now);
        const error = u.windows.length ? null : "the response carries no usage share";
        return { source, provider, plan: subscriptionOf(provider, now, u.planType), planType: u.planType, windows: u.windows, error };
      } catch (e) {
        return { source, provider, plan: subscriptionOf(provider, now), planType: null, windows: [], error: (e as Error).message || "failed" };
      }
    }),
  );
}
