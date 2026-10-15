# Public export

`export-allowlist.json` names every publication file, its approved origin, and executable mode.
Unchanged source inputs carry SHA-256 checksums. Public adaptations come from the reviewed
scaffold. Binary approvals separately pin the pseudonymized SQLite fixture and synthetic bundle.

```sh
python3 scripts/export-public.py <source-checkout> <empty-output> --revision <full-source-commit>
```

The exporter validates all original source checksums before writing an empty destination. It
copies no Git history. Keep private source locations and commit identities in the private audit
report. Compare all output paths, bytes, and modes with the reviewed scaffold before publication.

Run `python3 scripts/public-check.py` to verify the approved inventory, generic sensitive
signatures, SQLite text cells and free pages, and binary fingerprints. An optional
`--denylist <external-private-terms.json>` adds a private literal-term audit. Keep those terms
outside the public tree. Pattern scanning supplements review; it cannot establish that arbitrary
prose has no confidential fact.

New files and changed binary fixtures need renewed review and allowlist updates. A raw fixture
source map, original ID mapping, original time anchor, live-session output, personal catalogs,
service files, and private planning history stay outside this export. `docs/fixtures.md` owns
fixture transformation and its parsed-model equivalence proof.
