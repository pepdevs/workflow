# Routing

`wf route <skill>` ranks listed routes and routes used in the last 7 days. A listed route appears
even without recent calls. The command prints the `wf run` command for the first row. Run that
route by default. The table keeps every candidate, including routes moved down by a ranking key.
Retired models are excluded. Order:

1. A plan at its limit goes last until its window resets.
2. A route using an author's exact model goes after other routes with the same exhaustion standing.
3. Routes listed for the skill go before unlisted routes.
4. A listed route on a plan more than the weekly pace margin ahead goes after listed routes within
   the margin. A missing 7-day provider reading counts as within the margin and shows `unknown`.
5. Listed routes keep their list position within the preceding groups.
6. A subscription goes before per-token billing.
7. The most-used route goes first when the preceding keys tie.

The operator edits route lists, retired models and the pace margin in Workflow's `data/routes.json`.

## Escalation

Match the builder tier to the task shape. A fast or small tier (`flash`, `mini`, `haiku`) suits
mechanical work: moves, renames, tests, and documentation. An outcome with a design choice or a
security property starts on the family's full model. Raise the tier before a third repair of one
finding.

Choose a later listed route when the PR deletes data or changes access or credentials. A
user-named model also overrides the first route. Record the reason for any later route in your
report.

## Independence

- `cross family`: another vendor trained the model.
- `distinct model`: same vendor, a model that authored nothing.
- `same model`: an author judging in fresh context. Treat it as no model independence and say so
  in your report.

List every author of the judged work in `-x`: the orchestrator model, each builder model, and each
critic model that revised the plan.

## Diagnose

```bash
wf usage                 # each plan's windows now, or why its provider did not answer
wf models -k <skill>     # how each model did at the skill: sessions, finished, cost, time, context
wf route <skill> -d 30   # include routes used in a wider window of logs
```

A missing model has no calls in the window. Credential repair and logins stay with the operator.
