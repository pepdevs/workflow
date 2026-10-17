# Public export

This repository is the only Workflow source; `pepdevs/workflowarchive` is its archived private
history. `export-allowlist.json` names every published file and its mode. Binary approvals pin the
pseudonymized SQLite fixture and the synthetic Git bundle by SHA-256.

Run `python3 scripts/public-check.py` to verify the approved inventory, generic sensitive
signatures, SQLite text cells and free pages, and binary fingerprints. An optional
`--denylist <external-private-terms.json>` adds a private literal-term audit. Keep those terms
outside the public tree. Pattern scanning supplements review; it cannot establish that arbitrary
prose has no confidential fact.

New files and changed binary fixtures need review and an allowlist update. A raw fixture source
map, original ID mapping, original time anchor, live-session output, personal catalogs, service
files, and private planning history stay out of this repository. `docs/fixtures.md` owns fixture
transformation and its parsed-model equivalence proof.
