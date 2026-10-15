// Z.ai GLM Coding plans: the quota endpoint that the plan's API key can read.
import { type AccountUsage, getJson, isRecord, UsageError, usageWindow } from "./common.ts";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
// Z.ai names windows by unit: 3 is five hours, 6 is a week.
const UNITS: [number, number][] = [[3, 300], [6, 10_080]];

export function parseZaiQuota(payload: unknown): AccountUsage {
  if (!isRecord(payload) || payload.code !== 200 || !isRecord(payload.data) || !Array.isArray(payload.data.limits)) {
    throw new UsageError("malformed response");
  }
  const limits: any[] = payload.data.limits.filter(isRecord);
  const windows = UNITS.flatMap(([unit, minutes]) => {
    const raw = limits.find((l) => l.unit === unit);
    return raw ? [usageWindow(minutes, raw.percentage, raw.nextResetTime)] : [];
  });
  return { planType: typeof payload.data.level === "string" ? payload.data.level : null, windows };
}

export async function zaiUsage(key: string): Promise<AccountUsage> {
  return parseZaiQuota(await getJson(QUOTA_URL, { Authorization: `Bearer ${key}` }));
}
