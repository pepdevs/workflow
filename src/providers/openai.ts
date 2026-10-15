// ChatGPT plans: Codex CLI reports its own account's limits, and the usage
// endpoint answers for any ChatGPT login, such as Pi's openai-codex one.
import { type AccountUsage, getJson, isRecord, UsageError, usageWindow } from "./common.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const AUTH_CLAIM = "https://api.openai.com/auth";

// The result of Codex app-server's account/rateLimits/read.
export function parseCodexRateLimits(payload: unknown): AccountUsage {
  const limits = isRecord(payload) && isRecord(payload.rateLimits) ? payload.rateLimits : null;
  if (!limits) throw new UsageError("malformed response");
  const w = (raw: any) => usageWindow(raw?.windowDurationMins, raw?.usedPercent, raw?.resetsAt);
  const plan = typeof limits.planType === "string" && limits.planType !== "unknown" ? limits.planType : null;
  return { planType: plan, windows: [w(limits.primary), w(limits.secondary)].filter((x) => x.usedPercent !== null) };
}

export function parseChatGptUsage(payload: unknown, now: number): AccountUsage {
  if (!isRecord(payload)) throw new UsageError("malformed response");
  const limit = isRecord(payload.rate_limit) ? payload.rate_limit : {};
  const w = (raw: any) =>
    usageWindow(
      raw?.limit_window_seconds !== undefined ? raw.limit_window_seconds / 60 : raw?.window_minutes,
      raw?.used_percent,
      raw?.reset_at ?? (typeof raw?.reset_after_seconds === "number" ? now + raw.reset_after_seconds * 1000 : null),
    );
  return {
    planType: typeof payload.plan_type === "string" ? payload.plan_type : null,
    windows: [w(limit.primary_window), w(limit.secondary_window)].filter((x) => x.usedPercent !== null),
  };
}

// The ChatGPT account id sits in the bearer token's claims.
function accountId(token: string): string {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const id = claims?.[AUTH_CLAIM]?.chatgpt_account_id;
    if (typeof id === "string" && id) return id;
  } catch {}
  throw new UsageError("token names no ChatGPT account");
}

export async function chatGptUsage(token: string, now: number): Promise<AccountUsage> {
  return parseChatGptUsage(await getJson(USAGE_URL, { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId(token) }), now);
}
