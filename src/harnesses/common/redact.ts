// Redaction shared by the fixture cutters.
import { classifyApiError, shellCategory, shellProgram } from "../../catalog.ts";
import { skillFromPath } from "./logs.ts";

// A SKILL.md path that names only the skill.
export const skillPath = (skill: string) => `skills/${skill}/SKILL.md`;

export const TEXT = "<text>";

// A string that is one token without spaces or slashes: an id, timestamp,
// enum value, model name or tool name. Everything else is replaced.
const TOKEN = /^[A-Za-z0-9_.:+@-]{0,80}$/;

// Model and provider ids stay verbatim, slashes included.
const KEEP_KEYS = new Set(["model", "modelID", "modelId", "providerID", "provider"]);

// Replaces every string that is not a token, and every string under a key in
// `textKeys`, with a placeholder. Object keys that are not tokens become `<key-n>`.
export function redactJson(value: unknown, textKeys: Set<string>, inText = false, key = ""): unknown {
  if (typeof value === "string") return (!inText && TOKEN.test(value)) || KEEP_KEYS.has(key) ? value : TEXT;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, textKeys, inText));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      const key = TOKEN.test(k) ? k : `<key-${++n}>`;
      out[key] = redactJson(v, textKeys, inText || textKeys.has(k), k);
    }
    return out;
  }
  return value;
}

// A shell command reduced to what the classifier reads: its program, a
// `sed -i` flag, and a SKILL.md it reads.
export function redactCommand(command: string): string {
  const skill = /apply_patch|>\s*\S*SKILL\.md/.test(command) ? null : skillFromPath(command);
  return [
    shellProgram(command) || "sh",
    shellCategory(command) === "file_write" ? "-i" : null,
    "...",
    skill ? skillPath(skill) : null,
  ]
    .filter(Boolean)
    .join(" ");
}

// An error message reduced to a phrase that classifies the same way.
const ERROR_PHRASES: Record<string, string> = {
  usage_limit: "usage limit",
  rate_limit: "rate limit",
  overloaded: "overloaded",
  stream_terminated: "terminated",
  connection: "connect",
  unauthorized: "unauthorized",
  server_error: "server",
};
export function redactError(text: string, status: number | null = null): string {
  return ERROR_PHRASES[classifyApiError(text, status)] ?? "<error>";
}
