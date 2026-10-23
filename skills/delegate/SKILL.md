---
name: delegate
description: Run a plan critique or a build in a fresh session with another harness and model through wf, then check what it published.
---

# Delegate

`wf` (the Workflow CLI) ranks routes, launches one fresh headless session, and watches it. The
caller writes the bounded task and checks the result. Apply `writing-style` to every capsule,
report, and publication.

## Choose the route

```bash
wf route <role> -x <author models, comma-separated>
```

`<role>` is `critique`, `implement`, or another role in Workflow's `data/routes.json`. Take the
first row unless the user named a model or [routing](references/routing.md) calls for escalation.
Pass every model that authored the work to `-x`: yours, each builder's, and each critic's that
revised the plan. Record why you took a later route.

## Prepare the workspace

Commit the source the worker must read. Create a git worktree for a worker that edits, runs checks
or publishes, at the target's actual head after fetching it:

```bash
git worktree add ../<repo>-<role>-<short-id> <base-or-pr-branch>
```

Write a capsule with the task, artifact identity, exact revision, evidence worth reading, permitted
checks, expected result, and human boundaries. Start from [the capsule](assets/task-capsule.md).
Keep conversation history out and link durable artifacts instead. Keep it under 64 KiB.

## Launch

```bash
wf run <harness> <model> -i <capsule.md> (-k <skill> | -r <role>) -p <worktree> [--plan <owner/repo>#<number>] [--write] [-e <effort>] > <run.txt>
```

Claude read mode exposes only `Read,Grep,Glob,WebFetch,WebSearch` and excludes configured MCP servers.

- `-k <skill>` tells the session to use that installed skill. `-r <role>` records a role with no
  skill, such as `implement`. Both feed `wf models` and `wf route`.
- Without `--write` the session may only read: use it for research and review that publishes nothing.
- With `--write` every permission check is off, so the worktree and the capsule are the only
  limits. Use it only inside the worktree.
- `wf run` waits for the session. Run it in the background when the host allows and keep working.
- Pass `--plan` when the work serves a numbered plan, so `wf plan <number>` counts its cost.
- For a long task, pair `--max-attempts <count>` with `--done-file <path>` or `--done-command '<shell command>'`.
  The count includes the first session. Checks run before launch and after each attempt in the worktree.
  Continuations get the original capsule and a short note to continue the saved work.
  Every attempt prints its session id, cost and reply. A passing check exits 0; exhaustion exits non-zero.

## Critique a plan

Use this after `clarify` has published a drafted plan PR.

1. Launch `critique` with `-k critique --write` in a worktree of the plan branch. Pin the plan
   revision and PR in the capsule. Present the user's interview decisions as current choices, and
   ask the critic to propose a simpler design where one would serve the outcome.
2. Read the critic's commits and review on the PR. Resolve evidence-based findings. Resume the
   `clarify` interview for consequential choices the review left open.
3. Run another fresh critique when a finding changes a foundational decision. Stop when the same
   boundary needs the user or progress stalls.
4. Present the revised plan. Confirmation follows `clarify`; never report an unperformed critique.

## Hand off a build

Launch with `-r implement --write` in a worktree at the base or the existing PR head. The capsule
names the issue, the confirmed plan revision, and the checks that prove acceptance. Tell the builder:

- Follow the `git` skill. Link the issue with a closing reference.
- Keep the PR in draft until you accept it.
- When work stops early, push useful progress to the same PR and state the remaining criteria and
  the next step.

Continue a stopped build with a new `wf run` on the same PR and a fresh worktree at its head, never
a resumed provider session.

## Watch

```bash
wf status
```

The run appears indented under the caller's session. `stuck` means no event for 10 minutes or one
tool running 30; a spiralling flag names the pattern. End a run that makes no progress with
`wf stop <session-id-prefix>`, then relaunch with a narrower capsule or another route.

## Check the result

`<run.txt>` holds each session id, exit, cost, peak context and reply. Money uses one decimal;
elapsed time uses h:mm:ss. With a done check, require the check to pass; it can pass after a failed
harness exit. Otherwise, require exit code 0 and a reply.
Then judge the actual artifacts yourself: the worktree, the pushed branch, the PR head and
its comments. A successful exit is not acceptance. For a failed or stopped run, read
`wf summary <session-id-prefix>` and the worktree before another launch.
