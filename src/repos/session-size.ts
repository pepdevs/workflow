import type { Session } from "../model.ts";
import { measureRepository } from "./index.ts";
import { ProvenanceCall, type Provenance } from "./provenance.ts";

const INCLUDED = new Set(["code", "test", "docs"] as const);

export type SessionSize = { provenance: Provenance; tokens: number | null; gitMs: number; tokenMs: number };

export class SessionSizeCall {
  private readonly provenance = new ProvenanceCall();
  private readonly commits = new Map<string, { tokens: number; gitMs: number; tokenMs: number } | null>();
  private readonly blobs = new Map<string, { lines: number; tokens: number; markdown: number }>();

  prepare(sessions: readonly Session[], readClones: boolean): void {
    this.provenance.prepare(sessions, readClones);
  }

  measure(session: Session, readClones: boolean): SessionSize {
    const started = performance.now();
    const provenance = this.provenance.resolve(session, readClones, true);
    const provenanceMs = performance.now() - started;
    if (!provenance.clone || !provenance.sha) return { provenance, tokens: null, gitMs: provenanceMs, tokenMs: 0 };
    const key = `${provenance.clone}:${provenance.sha}`;
    if (this.commits.has(key)) return { provenance, tokens: this.commits.get(key)?.tokens ?? null, gitMs: provenanceMs, tokenMs: 0 };
    try {
      const report = measureRepository(provenance.clone, provenance.sha, INCLUDED, this.blobs);
      const tokens = [...INCLUDED].reduce((total, category) => total + report.categories[category].tokens, 0);
      this.commits.set(key, { tokens, gitMs: report.gitMs, tokenMs: report.tokenMs });
      return { provenance, tokens, gitMs: provenanceMs + report.gitMs, tokenMs: report.tokenMs };
    } catch {
      this.commits.set(key, null);
      return { provenance, tokens: null, gitMs: provenanceMs, tokenMs: 0 };
    }
  }
}
