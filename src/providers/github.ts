// Read PR evaluation comments through the operator's gh login.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Evaluation = { pullRequest: string; headSha: string; verdict: "PASS" | "CHANGES" | "BLOCKED"; createdAt: string };
type Pull = { owner: string; repo: string; number: number; url: string; cursor: string | null };
type Runner = (query: string) => Promise<string>;

const exec = promisify(execFile);
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;
const PULL_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/;
const ISSUE_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9]\d*$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const MARKER = /<!--\s*workflow-evaluation:\s*([\s\S]*?)\s*-->/g;

export async function ghGraphql(query: string): Promise<string> {
  try {
    const { stdout } = await exec("gh", ["api", "graphql", "-f", `query=${query}`], { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT });
    return stdout;
  } catch (error) {
    const output = (error as { stdout?: unknown }).stdout;
    if (typeof output === "string" && output.startsWith("{")) return output;
    throw new Error("GitHub verdicts unavailable");
  }
}

function parseEvaluation(body: unknown, createdAt: unknown, pullRequest: string): Evaluation | null {
  if (typeof body !== "string" || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) return null;
  const markers = [...body.matchAll(MARKER)];
  if (markers.length !== 1) return null;
  try {
    const v: unknown = JSON.parse(markers[0][1]);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const m = v as Record<string, unknown>;
    if (m.schema !== 1 || typeof m.id !== "string" || !UUID.test(m.id) || typeof m.issueUrl !== "string" || !ISSUE_URL.test(m.issueUrl) ||
      m.pullRequest !== pullRequest || typeof m.headSha !== "string" || !SHA.test(m.headSha) ||
      !["PASS", "CHANGES", "BLOCKED"].includes(String(m.verdict)) || !Array.isArray(m.dependencies) || !Array.isArray(m.findings)) return null;
    if (m.dependencies.some((d) => typeof d !== "object" || d === null || !ISSUE_URL.test(d.issueUrl) || !SHA.test(d.headSha))) return null;
    if (m.findings.some((f) => typeof f !== "object" || f === null || typeof f.id !== "string" || typeof f.blocking !== "boolean" ||
      !["open", "closed"].includes(f.state))) return null;
    return { pullRequest, headSha: m.headSha.toLowerCase(), verdict: m.verdict as Evaluation["verdict"], createdAt };
  } catch {
    return null;
  }
}

// A failed page makes the whole read unavailable. Partial counts would look complete.
export async function readGithubEvaluations(urls: string[], runner: Runner = ghGraphql): Promise<Evaluation[]> {
  const deadline = Date.now() + 30_000;
  let pending: Pull[] = [...new Set(urls)].map((url) => {
    const match = PULL_URL.exec(url);
    if (!match) throw new Error("invalid PR link");
    return { owner: match[1], repo: match[2], number: Number(match[3]), url, cursor: null };
  });
  const evaluations: Evaluation[] = [];
  while (pending.length) {
    if (Date.now() > deadline) throw new Error("GitHub verdicts unavailable");
    const next: Pull[] = [];
    const groups = new Map<string, Pull[]>();
    for (const pull of pending) {
      const key = `${pull.owner}/${pull.repo}`;
      groups.set(key, [...(groups.get(key) ?? []), pull]);
    }
    for (const pulls of groups.values()) {
      for (let offset = 0; offset < pulls.length; offset += 10) {
        if (Date.now() > deadline) throw new Error("GitHub verdicts unavailable");
        const batch = pulls.slice(offset, offset + 10);
        const fields = batch.map((p, i) => `p${i}: pullRequest(number: ${p.number}) { comments(first: 100${p.cursor ? `, after: ${JSON.stringify(p.cursor)}` : ""}) { nodes { body createdAt } pageInfo { hasNextPage endCursor } } }`).join(" ");
        const query = `query { repository(owner: ${JSON.stringify(batch[0].owner)}, name: ${JSON.stringify(batch[0].repo)}) { ${fields} } }`;
        let response: any;
        try { response = JSON.parse(await runner(query)); } catch { throw new Error("GitHub verdicts unavailable"); }
        if (!response?.data?.repository || (response.errors !== undefined && !Array.isArray(response.errors))) throw new Error("GitHub verdicts unavailable");
        const missing = new Set<number>();
        for (const error of response.errors ?? []) {
          const alias = error?.path?.[1];
          const index = typeof alias === "string" && /^p\d+$/.test(alias) ? Number(alias.slice(1)) : -1;
          if (error?.type !== "NOT_FOUND" || error?.path?.[0] !== "repository" || index < 0 || index >= batch.length ||
            response.data.repository[alias] !== null) throw new Error("GitHub verdicts unavailable");
          missing.add(index);
        }
        for (const [i, pull] of batch.entries()) {
          if (missing.has(i)) continue;
          const comments = response.data.repository[`p${i}`]?.comments;
          if (!Array.isArray(comments?.nodes) || typeof comments?.pageInfo?.hasNextPage !== "boolean") throw new Error("GitHub verdicts unavailable");
          for (const comment of comments.nodes) {
            const evaluation = parseEvaluation(comment?.body, comment?.createdAt, pull.url);
            if (evaluation) evaluations.push(evaluation);
          }
          if (comments.pageInfo.hasNextPage) {
            if (typeof comments.pageInfo.endCursor !== "string" || comments.pageInfo.endCursor === pull.cursor) throw new Error("GitHub verdicts unavailable");
            next.push({ ...pull, cursor: comments.pageInfo.endCursor });
          }
        }
      }
    }
    pending = next;
  }
  return evaluations;
}
