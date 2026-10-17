# Install and configure

## Install

Use Node.js 24 or newer, npm, and Git:

```sh
git clone https://github.com/pepdevs/workflow.git
cd workflow
npm ci
npm run setup
wf help
```

`setup` links the checkout's executable into `~/.local/bin` and enables the checkout's pre-push
check. Add that directory to `PATH`. The link follows this checkout, so keep it after installation.
To choose a different writable bin directory:

```sh
npm run setup -- --bin-dir /path/to/bin
```

Setup refuses to overwrite a regular file. Repeating it keeps the same link. The repository is
published on GitHub; the package remains protected from accidental npm publication.

## Configure local facts

Bundled defaults contain public model prices, thresholds, empty subscriptions and repository
mappings, and empty preferred route lists. The CLI reads optional whole-file overrides from:

1. `WORKFLOW_CONFIG_DIR`, when explicitly set;
2. `$XDG_CONFIG_HOME/workflow`, when XDG_CONFIG_HOME is set;
3. `~/.config/workflow` otherwise.

Create only the JSON files you want to override. An absent file uses its bundled counterpart in
`data/`. An invalid explicit directory or malformed JSON fails visibly. Keep account billing dates,
local clones, path aliases, and personal routing choices in this local directory.
See [configuration](configuration.md) for the six catalog shapes and examples.

`wf help` lists commands; `wf help <command>` shows its flags. Examples:

```sh
wf ls
wf summary <session-prefix>
wf status
wf repo .
wf route implement
wf run codex <model> -i task.md -k implement
```

Session reads use each harness's native log locations. `--root <directory>` selects an explicit log
root instead. The [use cases](use-cases.md) pair operator questions with commands and their
fixture output.

`wf usage` reads provider usage through credentials already held by the supported harnesses.
`wf route` can read provider headroom, and `wf models -k implement` can read GitHub evaluations
through authenticated `gh`. These commands need the corresponding local clients and logins.
`wf run` requires the chosen agent CLI and installed skills; it starts a fresh headless session.
Write mode follows the selected harness's permission behavior. Copilot has no launch adapter.

## Local storage

`wf usage` and `wf route` append changed provider readings to
`~/.local/share/workflow/usage-readings.jsonl`. `WORKFLOW_READINGS` overrides that path.
`wf subscriptions` derives billing and usage comparisons from the local catalogs, session logs,
and readings. Billing displays euros using the configured exchange rate; token costs stay in USD.

`wf archive` copies supported harness logs into `~/.local/share/workflow/archive/`.
`WORKFLOW_ARCHIVE` overrides the archive directory. It keeps new or grown logs and preserves a
shrunk live file beside the older archive. Loaders combine live and archived logs, with live copies
winning. OpenCode's database is read directly and is not archived.
No background service is installed by this repository. Schedule an explicit command through your
own operating-system service configuration when needed.

## Verify and develop

```sh
npm run check
npm run golden:update
```

`check` runs the public file audit, type checks, and the adapter, table, guard, and golden fixtures.
Tests force `test/config/` so they never consume your local catalogs. The fixture suite reads no
live logs, launches no model, and makes no credentialed provider calls. Python 3.10 or newer is
required for the public audit. The pre-push hook runs the same check.

`npm run check:real` archives and loads your real local sessions. It can read gigabytes and writes
the archive; run it deliberately after adapter or catalog changes. Keep its detailed session
output private. A completed run can report incomplete records and unknown prices; those diagnostics
are separate from loader failures.

[Fixture documentation](fixtures.md) explains the explicit source map, redaction,
pseudonymization, shifted timeline, and semantic comparison. [Public export](public-export.md)
explains the approved allowlist and its audit. [SYSTEM.md](../SYSTEM.md) maps the code;
[AGENTS.md](../AGENTS.md) defines editing rules.
