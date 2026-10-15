# Agent rules

Workflow reads local agent logs, derives a session model, and launches, lists, and stops sessions.
`SYSTEM.md` maps the code; these rules state their reason and when to revisit them.

1. Read harness logs, processes, commands, and credentials only in `src/harnesses/`, one folder per harness, so each format change has one owner. `test/guards.test.ts` enforces this.
2. Derive results from logs and the archive on each run, so adapter fixes correct existing data. Revisit when `npm run check:real` read time exceeds 60 seconds.
3. Ask before adding a server, network upload, database, or cache; local reading keeps operational state on one machine. Provider and GitHub reads belong in `src/providers/`, enforced by guards. Revisit when another remote source is needed.
4. Keep the session tree as the model's core, with optional plans, issues, and launches, so other workflows need no schema replacement.
5. In tests, import only `src/harnesses/index.ts`, `src/catalog.ts`, `src/cli.ts`, and `src/check.ts`, so internal code can move. `test/guards.test.ts` enforces this.
6. Start behavior as a use case in `docs/use-cases.md`, regenerate its golden output, and add pure-function cases to the shared table, so tests prove operator questions.
7. Delete a removed use case's commands and golden files, so the command inventory remains accountable. The golden check enforces this.
8. Keep `npm run check` below ten seconds where practical, because pre-push feedback must stay usable. Revisit the checks when that warning appears.
9. Run the check through `.githooks/pre-push`, so local pushes validate the same artifact. Revisit when the project adopts another CI policy.
10. After changing `src/harnesses/`, `data/`, `src/catalog.ts`, or `src/model.ts`, run `npm run check:real` and report aggregate results; real logs reveal gaps absent from fixtures. Keep detailed output private.
11. Cut fixtures through `npm run fixtures`, then redact, pseudonymize, shift their timeline, and inspect the diff, because fixtures originate in private logs. `docs/fixtures.md` defines the proof.
12. Keep operator facts in local catalog overrides and public defaults in `data/`, so personal settings stay outside the source tree. Revisit when another configuration format is needed.
13. Keep approved publication files and binary checksums in `export-allowlist.json`, so a new file cannot bypass review. `scripts/public-check.py` enforces this.
