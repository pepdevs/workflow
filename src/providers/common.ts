// Usage windows and the HTTPS reader shared by the provider connectors.

// One limit window of a plan: its length, the share used, and when it resets.
export type UsageWindow = { minutes: number | null; usedPercent: number | null; resetsAt: number | null };
// What a provider reports for one account. `planType` is the plan the
// provider names, matched against data/subscriptions.json.
export type AccountUsage = { planType: string | null; windows: UsageWindow[] };

export const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

// Epoch seconds, epoch milliseconds or an ISO time, as epoch milliseconds.
export function toMs(v: unknown): number | null {
  const n = finite(v);
  if (n !== null) return n >= 10_000_000_000 ? n : n * 1000;
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function usageWindow(minutes: unknown, usedPercent: unknown, resetsAt: unknown): UsageWindow {
  const m = finite(minutes);
  const used = finite(usedPercent);
  return { minutes: m !== null && m > 0 ? Math.round(m) : null, usedPercent: used === null ? null : Math.min(100, Math.max(0, used)), resetsAt: toMs(resetsAt) };
}

// A failure with a class safe to print: it never carries a token or a response body.
export class UsageError extends Error {}

export const TIMEOUT_MS = 10_000;
const MAX_BODY = 256 * 1024;

// Send one HTTPS request with diagnostics that cannot expose its URL or credentials.
export async function request(url: string, options: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new UsageError((e as Error).name === "TimeoutError" ? "timeout" : "network error");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) throw new UsageError(`authentication (HTTP ${res.status})`);
    throw new UsageError(`HTTP ${res.status}`);
  }
  return res;
}

// GET one of the fixed usage endpoints and parse its JSON body.
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await request(url, { headers: { Accept: "application/json", ...headers } });
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) throw new UsageError("response too large");
        chunks.push(value);
      }
    }
  } catch (error) {
    await reader?.cancel().catch(() => {});
    throw error instanceof UsageError ? error : new UsageError((error as Error).name === "TimeoutError" ? "timeout" : "network error");
  } finally { reader?.releaseLock(); }
  const text = Buffer.concat(chunks, size).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError("malformed response");
  }
}
