# Local configuration

Workflow loads six JSON catalogs through `src/catalog.ts`. A local file replaces one complete
bundled catalog. Missing local files fall back to `data/`; files are not recursively merged.
Tests explicitly select `test/config/` and are independent of the default local directory.

| File | Shape and purpose |
| --- | --- |
| `subscriptions.json` | `{ "usdPerEur": 1, "plans": [] }`; purchased plans with name, monthly price, currency, from/to dates, providers, and optional reported plan type |
| `repos.json` | Repository identity to clone path, optional worktree patterns, category overrides, and domains |
| `paths.json` | `{ "aliases": {} }`; display aliases for path prefixes |
| `routes.json` | Provider mapping, paceMargin, ordered per-skill/default routes, reserved plan names, and retired model identities |
| `prices.json` | Public per-model token prices, provider aliases, vendor mapping, and their source dates |
| `thresholds.json` | Context budget, size bands, token estimate ratio, and status thresholds |

The bundled catalogs and `test/config/` provide concrete examples. Test subscription names,
amounts, dates, and exchange rate are invented. Test routes exercise ranking; they are not a
recommendation for current models or a record of any operator's setup.

In `routes.json`, optional `reservedPlans` lists exact subscription names, for example
`"reservedPlans": ["SuperGrok"]`. `wf route` excludes every route billed to a reserved plan,
across all skills, including routes from session logs. `wf run` still accepts those routes directly.
Omitting the field or using `[]` reserves no plans. Bundled routes reserve SuperGrok; include that
entry in a local override to keep the reservation.

For example, create `~/.config/workflow/subscriptions.json`:

```json
{
  "usdPerEur": 1.1,
  "plans": [
    {
      "name": "Example plan",
      "monthly": 25,
      "currency": "EUR",
      "from": "2030-01-01",
      "to": null,
      "providers": ["anthropic"]
    }
  ]
}
```

Those values are examples. Use your own billing and exchange-rate facts. The first matching plan
wins; a provider without a matching plan is treated as paid per token. Record a plan change by
ending the old record at the transition and starting its replacement at the same instant.

Repository clone paths and worktree patterns keep their existing base: the Workflow checkout
root. Absolute paths are suitable for a configuration shared across installations.
JSON parse and filesystem errors propagate; correct the named file before rerunning the command.
`WORKFLOW_CONFIG_DIR` lets a command or service select another directory without editing the
checkout. The default config path uses XDG configuration conventions.
