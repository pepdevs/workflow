# Fixtures

Adapter fixtures preserve record structure, usage, durations, model identities, statuses, and
error classes. Their prose, paths, titles, and command content are redacted. Session/provider
identifiers are pseudonyms. Their timeline is shifted to a canonical epoch; dates are not actual
operator activity. No original identity map or date anchor is committed.

`test/fixture-provenance.json` records the transformation format. The SQLite fixture is rebuilt
in place with secure deletion and VACUUM after identifiers and times are transformed. The Git
bundle is entirely synthetic, built by `scripts/repo-fixture.ts` with fixture author metadata and
invented files.

## Cut fixtures

`npm run fixtures -- <private-source-map.json>` reads an explicit local source map. It validates
all jobs before replacing any selected output directory. Each entry names an adapter, session,
and output below a test fixture directory. Keep the source map outside this repository:

```json
[
  {
    "harness": "codex",
    "id": "<session-id>",
    "out": "test/fixtures/codex",
    "roots": ["<explicit-log-root>"]
  }
]
```

Grok entries can add `children`, `omitSignals`, or `launchResult` with `prompt` and `reply`.
A Claude job uses `"harness": "claude-job"` and a separate `session` field. The script invokes
the existing adapter cutters. It also regenerates the synthetic repository bundle.
This command reads the chosen logs and is separate from normal checks.
Copilot session identities must be single filename components; linked output directories and files are rejected.

## Review and pseudonymize

1. Cut into an isolated candidate checkout and inspect the redacted output.
2. Run `python3 scripts/pseudonymize-fixtures.py <candidate-checkout>` once on original candidate inputs.
3. Review every filename and textual/SQLite field with an external private-term denylist.
4. Run `node scripts/compare-fixtures.ts <original-candidate-checkout>` to compare parsed structure,
   per-call usage, costs, and exact call durations across golden, variant, and job fixtures.
5. Run `npm run golden:update` and inspect each changed output.
6. Refresh approved file names, checksums, and binary approvals in `export-allowlist.json`.
7. Run `npm run check`.

The transformer preserves raw JSON formatting and identifier widths and timestamp precision. Some adapters
infer boundaries from record structure; the semantic comparison proves the resulting model
instead of assuming text redaction is sufficient. Only temporal numeric fields move; usage and
cost counters remain unchanged. The tool refuses to repeat on a tree carrying its provenance
marker. Restart from original candidate inputs to reproduce the transformation.

## Cut one harness again

The pseudonymizer derives one timeline shift from the earliest stamp in the candidate, and it
rehashes identifiers that are already pseudonyms. A cut of one harness needs a candidate that holds
only that harness, with the committed shift:

1. Export a clean checkout into the candidate and run `npm run fixtures` there with a source map
   for that harness only. Keep at least one session the committed fixture holds, so step 5 can
   prove the shift.
2. Delete `test/fixture-provenance.json`, `test/fixture-variants`, `test/job-fixtures`, and every
   other harness under `test/fixtures` from the candidate.
3. Compute the shift as a committed session's shifted `created_at` minus its original
   `created_at`. Write `{"timestamp": <canonical epoch in Unix seconds minus shift>}` to
   `test/fixtures/anchor.json` in the candidate. The original anchor stays out of the repository.
4. Copy the candidate as the original candidate checkout without `anchor.json`, then pseudonymize
   the candidate and delete `anchor.json`.
5. Confirm that each session kept from the committed fixture is byte-identical. A difference
   means a different shift or cut option, such as `launchResult`.
6. Run `node scripts/compare-fixtures.ts <original-candidate-checkout>` in the candidate.
7. Replace the harness directory in this repository, update `fixtureFiles` in
   `test/fixture-provenance.json`, then follow steps 3 and 5 to 7 of the review above.
