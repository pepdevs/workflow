// SuperGrok: the Grok CLI endpoints that name the user, then its credit use.
import { type AccountUsage, getJson, isRecord, UsageError, usageWindow } from "./common.ts";

const USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export function parseXaiBilling(billing: unknown): AccountUsage {
  if (!isRecord(billing)) throw new UsageError("malformed response");
  const config = isRecord(billing.config) ? billing.config : {};
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const [start, end] = [Date.parse(period.start), Date.parse(period.end ?? config.billingPeriodEnd)];
  const minutes = Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 60_000 : null;
  // Protobuf JSON omits zero values: a period without a share is 0% used.
  const used = config.creditUsagePercent ?? (minutes === null ? undefined : 0);
  const window = usageWindow(minutes, used, period.end ?? config.billingPeriodEnd);
  return { planType: typeof billing.subscriptionTier === "string" ? billing.subscriptionTier : null, windows: window.usedPercent === null ? [] : [window] };
}

export async function xaiUsage(token: string): Promise<AccountUsage> {
  const headers = { Authorization: `Bearer ${token}`, "X-XAI-Token-Auth": "xai-grok-cli", "x-grok-client-version": "1.0.10", "x-grok-client-mode": "interactive" };
  const user = await getJson(USER_URL, headers);
  if (!isRecord(user) || typeof user.userId !== "string") throw new UsageError("malformed response");
  return parseXaiBilling(await getJson(BILLING_URL, { ...headers, "x-userid": user.userId }));
}
