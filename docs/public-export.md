# Public export

This repository is the only Workflow source; `pepdevs/workflowarchive` is its archived private
history. `export-allowlist.json` names every published file and its mode. Binary approvals pin the
pseudonymized SQLite fixture and the synthetic Git bundle by SHA-256.

Run `python3 scripts/public-check.py` to verify the approved inventory, generic sensitive
signatures, SQLite text cells and free pages, and binary fingerprints. It adds a private
literal-term audit from `~/.config/workflow/private-terms.json` (or `WORKFLOW_PRIVATE_TERMS`, or
`--denylist <file>`): a JSON array of terms, matched as whole words and without case. Keep those
terms outside the public tree. Pattern scanning supplements review; it cannot establish that
arbitrary prose has no confidential fact.

- The pre-push hook runs it with `--require-denylist`, so a push fails without the terms file, and
  with `--commits` over the pushed commits. It scans every selected tree and message, including
  deleted files and intermediate content, against the current approvals and private terms.
  The selected ref can differ from the checkout. Unreadable objects fail the check.
- Pull request titles, bodies and comments are public as soon as they are posted. Pipe each one
  through `python3 scripts/public-check.py --text -` first.

New files and changed binary fixtures need review and an allowlist update. A raw fixture source
map, original ID mapping, original time anchor, live-session output, personal catalogs, service
files, and private planning history stay out of this repository. `docs/fixtures.md` owns fixture
transformation and its parsed-model equivalence proof.
