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
