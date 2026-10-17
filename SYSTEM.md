# System

Workflow is the local `wf` CLI. It reads six agent log formats into one session model, derives
session and billing reports, and launches or stops supported agent sessions.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Parse CLI arguments, expose public test entry points, dispatch commands |
| `src/commands/` | Session, file, model, route, usage, billing, run, status, stop, archive, repository, export, prompts and web use cases; help and shared formatting |
| `src/harnesses/` | One adapter per agent; the only code that knows its logs, credentials, processes, launch commands, and fixture cutters |
| `src/harnesses/index.ts` | Public adapter, login, process, launch, and fixture entry points |
| `src/harnesses/common/` | Log/archive helpers, redaction, process and launch types |
| `src/providers/` | Provider usage and GitHub evaluation reads; persistent provider readings |
| `src/repos/` | Local Git trees, repository identity/provenance, categories, token and size measurements |
| `src/model.ts`, `src/facts.ts` | Session tree and derived facts |
| `src/catalog.ts` | Whole-file local catalog overrides, public fallback data, typed lookups, and shared classifications |
| `src/check.ts` | Live-session model validation |
| `data/` | Public prices, thresholds and web tool backends; neutral paths, repositories, routes, and subscriptions defaults |
| `test/config/` | Invented fixture-only catalog overrides |
| `test/fixtures/`, `test/fixture-variants/`, `test/job-fixtures/` | Redacted and pseudonymized adapter records with a shifted timeline |
| `test/fixture-provenance.json` | Fixture transformation format; no original mapping or time anchor |
| `test/golden/` | Output of the use cases on fixtures |
| `test/*.test.ts` | Golden, adapter, guard, and shared table checks |
| `scripts/check.ts`, `scripts/test-config.ts` | Check entry point and isolation from operator configuration |
| `scripts/setup.ts` | Local executable link and pre-push configuration |
| `scripts/fixtures.ts`, `scripts/repo-fixture.ts` | Explicit source-map cutting and synthetic Git bundle generation |
| `scripts/pseudonymize-fixtures.py`, `scripts/compare-fixtures.ts` | Fixture privacy transformation and parsed-model equivalence proof |
| `scripts/bench-repo.ts` | Optional Git-tree read benchmark |
| `scripts/showcase.ts` | README images: real commands over an invented scene, written to `docs/images/` |
| `scripts/public-check.py` | Public-boundary audit |
| `skills/delegate/` | Agent skill that drives `wf route`, `run`, `status` and `stop`; installed with the Skills CLI |
| `export-allowlist.json` | Approved files, modes, and binary fingerprints |
| `.githooks/pre-push`, `.gitattributes`, `.gitignore` | Local checks, line endings, generated-file exclusions |
| `docs/` | Settled use cases, install and local configuration, fixture and export procedures, README images |
| `README.md`, `SYSTEM.md`, `AGENTS.md`, `CLAUDE.md` | Usage, layout, rules, and host instruction pointer |
| `package.json`, `package-lock.json`, `tsconfig.json` | Runtime/dependency declarations and static checking |
| `LICENSE` | MIT terms for authored material |

## How a command runs

1. CLI parsing selects one function in `src/commands/`.
2. Session commands reach logs through `src/harnesses/index.ts` and receive `src/model.ts` sessions.
3. Facts and catalogs supply costs, routes, thresholds, plan associations, and display aliases.
4. Provider usage and GitHub reads go through `src/providers/`. Readings and archives use explicit
   environment overrides or the user's local data directory.
5. Commands format text or JSON. Tests select explicit fixture roots and isolated synthetic catalogs.

Catalog overrides come from `WORKFLOW_CONFIG_DIR` or the default XDG configuration directory.
Missing files use bundled defaults. Repository paths retain their checkout-root base.

## Where new code goes

New behavior belongs to a use case and a command file. Agent-specific formats stay in that agent's
adapter; external reads stay in providers. Operator data stays in local catalog overrides. A public
resource or top-level file gets its entry here and in the reviewed export allowlist.
