# Use cases

Each use case is a question the operator asks about agent sessions, and the command that answers it. Code exists to answer these questions. `test/golden.test.ts` reads this file:

- Each command with `<session>` runs on every fixture, and its output is compared with `test/golden/<use case id>-<harness>.txt`.
- Each command over every session runs on all fixtures together, and its output is compared with `test/golden/<use case id>.txt`.
- A CLI command that no use case names fails the test. Delete the command, or add the use case it serves.
- A golden file that no use case produces fails the test. Removing a use case removes its golden files.

`workflow` stands for `node src/cli.ts`, which `npm run setup` installs as `wf`. The name `workflow` stays with workflow-deprecated until supervision moves here. Candidate use cases, not yet answered, are in `research/use-cases.md`.

## uc-18 Repository size

How large is a committed repository by category, folder and file? The report counts tracked regular files, non-blank lines, `o200k` tokens and markdown characters. It shows test lines as a share of code lines. A directory reads HEAD. `-d` sets folder depth, and `-n` sets the number of largest files.

```
wf repo <repo> -d 2 -n 20
```

## uc-9 Find a session

Which sessions ran in a time window, in which harnesses, with which models, at what cost and in which directory? Each row carries the shortest unique id prefix, which every per-session command accepts in place of a harness and full id, and its role: the skill `wf run` launched it for, or orchestrator when it launched other sessions. Linked Grok Build children appear inside their parent, like Claude Code and Codex subagents. A child without an explicit spawn link remains a separate row. `-k` keeps one role. `wf help ls` lists the filters.

With `--size`, each row shows code and docs tokens at its starting commit. Estimated commits carry `est.`; missing evidence shows `unknown`.

```
wf ls
wf ls codex claude -d2002-02-14..2002-03-15 -c0.1 -s cost
wf ls grok -d2002-02-23..
wf ls copilot -d2002-02-14..
wf ls -k implement -d 2002-02-14..
wf ls codex -d 2002-02-14.. --size
```

## uc-10 What runs now

Which sessions are running now, what is each one doing, and which are stuck or spiralling? Each session with a log change in the last hour shows its state, time since its last event, the running tool, cost in the last hour, flags for repeated commands, failing tools, cost rate, context above the 200k budget and repeated compactions, and the pid of the harness process. The header lists running sessions and their states, then sessions ended without a process, then hidden finished sessions. Sessions started by `wf run` follow the session that launched them, indented, with their skill. Subagents still running follow their session, indented, with skill `agent`, their name, model, state, running tool and cost. A session whose logs show an open turn but whose process is gone is ended and shows `-` in the `running` column. An idle session without a process has finished and is hidden. `-a` evaluates the logs as they were at an earlier time, without processes and keeps the historical output.

```
wf status
wf status -a 2002-03-02T05:00 -w 30d
wf status -a 2002-03-02T14:00 -w 2h
wf status -a 2002-02-23T08:27 -w 2h
```

## uc-11 Stop a session

Stop a session that is stuck or spiralling, from the laptop or over SSH. `stop` sends SIGTERM to the harness process that writes the session and to the tools it runs, and waits up to 10 seconds for them to exit.

```
wf stop <session>
```

## uc-15 Models per skill

Which model does best at which skill, at what cost? Sessions are grouped by skill, harness and model: how many finished their last turn, and median cost, time and peak context, with the count that went over the 200k budget. Implement builds split into one row per harness, model and peak-context band. S is under 60,000 tokens, M is from 60,000 to under 120,000, and L is from 120,000 through the 200k budget. A peak above the budget is an over-budget row. The S and M bounds are in `data/thresholds.json`. Each implement row shows judged, passed and blocked counts and the pass rate, PASS divided by PASS plus CHANGES. Other skills keep one row per harness and model. Each session uses the earliest valid evaluation at the PR and full head SHA in its result link. Only sessions launched with `wf run` count, each for the skill it was launched with, under the model with most calls in its root thread. A session a person started counts for no skill, whatever skills it loaded. With custom log roots or an unavailable GitHub read, the table retains its local columns and reports missing verdicts.

Turn aggregates contribute their reported calls to model selection and routes. Their context observations carry `est.` and do not assign an exact implement size band or budget count. Missing observations show `unknown`.

With `--size`, each row shows the median code and docs tokens at its sessions' starting commits and the measured count out of all sessions in that row. Unknown sizes stay out of the median; a row without a measurement shows `unknown`. A median containing estimated sizes carries `est.`.

```
wf models -d 2002-02-14..
wf models -k clarify -d 2002-02-14..
wf models -k implement -d 2002-03-05..
wf models -k implement -d 2002-03-05.. --size
```

## uc-17 What a plan cost

What did building a plan cost, split into the orchestrator, builders, evaluators and critics? `wf run --plan <owner/repo>#<number>` writes the plan into the launch line, and `workflow-plan` and `workflow-build` pass it on every launch. `wf plan` totals the sessions that name the plan, per skill, and lists each with its harness, main model, cost, time and pull request. The sessions that launched them follow as orchestrators, outside the total, because an orchestrator session also holds work outside the plan. A plan number without a repo matches that number in every repo. Sessions launched before the marker carried a plan do not count. The fixtures hold no plan marker yet, so the golden file shows the empty answer until `npm run fixtures` cuts a session that has one.

```
wf plan 7 -d 2002-02-14..
```

## uc-20 Agent practice as JSON

How do I work with agents, day by day, in a form another tool can keep? `wf export` prints one JSON document for the range: a row per UTC day, harness, model, skill and repository, with sessions, tokens by type (uncached input, cache read, cache write and output, which includes reasoning), cost in USD and wall seconds, then the totals. Career's `career evidence` stores it. `schema` rises when a field changes meaning or goes away, and `range` gives the window's bounds, with `null` for an open end.

- A session counts once, on the UTC day it started, under the model with most turn calls in its root thread, with the wall time of its root turns. Tokens and cost follow each call's model, so a subagent on another model adds a row with zero sessions.
- `skill` is the skill `wf run` launched the session with, `orchestrator` when it launched other sessions, or `null` for a session a person started.
- `repository` is a name without owner or path, from the first source that names one: the launch header, the repository URL the harness logged at start (Codex, Copilot), the catalog clone whose worktree or worktree glob in `data/repos.json` holds the directory, then, while the directory exists, its Git origin or main checkout. A session reports the same repository after its worktree is removed when a logged URL or catalog glob covers it. Otherwise `repository` is `null`, as for a directory outside any repository. Custom log roots skip the Git reads.
- `model` is `null` for a placeholder a harness writes when its log names no model, such as Pi's `compaction` or Codex's `unknown`. Its tokens still count, so the token totals hold. A session with no model call takes the model its root turns name, as Grok Build logs at turn start; a session that ended before any reply, such as a local `/clear` in Claude Code or a launch stopped before the first answer, counts under `null`.
- One model has one name: OpenRouter's vendor prefix is dropped, so OpenCode's `x-ai/grok-4.6` and Pi's `grok-4.6` share a row. A prefix that names no vendor, such as `stealth/`, stays.
- Cost and estimated compaction tokens follow `wf summary`. `costUsd` is `null` for a row whose model has no list price in `data/prices.json` and no positive charge from the harness, such as an OpenRouter stealth model, which OpenRouter serves at $0. The totals add the priced rows, and `unpricedRows` counts the others. The document holds no prompt, reply, file content, path or credential.

```
wf export -d 2002-02-14..2002-03-15
```

## uc-14 Plan usage now

How much of each plan's limit windows is used right now, including use outside these logs, and am I on pace to use each weekly limit up before it resets? Weekly windows show by default with the time to reset, points ahead or behind an even burn to 100%, and the share per day that uses the rest; `-w 5h` or `-w all` shows other windows, and a plan without the chosen window says so. Each provider reports its plan's windows through the login a harness already holds: Codex CLI's app-server, Pi's openai-codex, zai and xai logins, and Claude Code's claude.ai login. SuperGrok appears once for both Grok Build and Pi calls. With `--value`, each weekly row also shows the API-equivalent cost of the logged calls since the window started, that cost over the share used as the value of a full window, and a month of full windows as a multiple of the plan's price. A source that fails names the reason, and the other plans still print. It has no golden file because it reads the network.

```
wf usage
wf usage -w all
wf usage --value
```

## uc-13 Choose a model for a skill

Which harness and model should run this skill now? The skill's ordered list in `data/routes.json`, or its default list, supplies routes even without recent calls. Each list entry names a valid `<harness> <model>` route; Pi and OpenCode models include a provider prefix. Routes seen in the window also appear; retired models do not. Plans with headroom rank before exhausted plans. Within that standing, a route using an author's exact model follows other routes. Listed routes on plans more than `paceMargin` points ahead of weekly pace follow listed routes within the margin; routes within the margin keep list order. A plan without a 7-day provider reading counts as within the margin, and its pace shows as unknown. Unlisted routes follow listed routes. A plan ranks before per-token billing, then the most-used route breaks ties. Headroom comes from providers (`wf usage`) or logs, marked `(logs)`. The table shows pace beside used percentage, plus list position, calls, and judged counts and pass rates for implement. Grok Build uses `grok-4.6` and Pi uses `xai/grok-4.6`; both routes lose rank when SuperGrok is exhausted. Pass rate does not change the order. An unavailable verdict read reports missing verdicts. The last line is the `wf run` command for the first route. An empty list with no sessions prints `No routes found in this window.` without a run command.

```
wf route critique -d 2002-02-14.. -x claude-opus-5
wf route implement -d 2002-02-14..
```

## uc-12 Run a skill with another model

Run a skill such as critique with a chosen model in the harness that suits it, in a fresh session, and get its reply, session id and cost. Read mode allows reading tools only; `--write` turns every permission check off, so the caller passes a worktree with `-p`. Grok Build read mode allows `read_file`, `list_dir` and `grep` under plan permission mode. Grok Build write mode approves tool calls without prompting. `wf run` records the skill, the launching session and, with `--plan`, the plan in the first line of the prompt, which `wf status` and `wf summary` read back. The same line records `repo=<owner/name>` from the effective directory's `origin` and `commit=<full HEAD sha>` when each is available. Grok Build exposes its launching session as `GROK_SESSION_ID` to tools. It has no golden file because it launches a model.

```
wf run <harness> <model> -i <task file> -k <skill>
```

## uc-1 Session at a glance

Which repository and starting commit did this session use? `wf summary` shows the launch header, harness SHA, or estimated branch commit as its source. Catalog worktree globs identify sessions from removed worktrees. Missing evidence appears as `unknown`. Custom log roots use only their logs.

With `--size`, the summary shows code and docs tokens beside the repository and commit. Estimated commits carry `est.`; missing evidence shows `unknown`.

What did this session do, what did it cost, what went wrong, and which PR and head did it publish? Threads, turns, calls, models, measured tokens, peak context against the 200k budget, computed against reported cost, time split, skills, incidents and an optional result link. Claude Code job ids and unique prefixes resolve to their transcript; unknown and ambiguous ids report an error. Claude compactions show their trigger, tokens before and after, and a price marked `est.` based on cache-read input and output rates. Their estimated tokens stay out of the measured token totals and context cost share; Pi and OpenCode compaction usage stays in both. Grok Build compactions show recorded tokens before and after with an unreported charge; they do not add a model call. Grok Build sessions without usage or turn timing show those measures as unknown. A result link comes from a valid schema-1 `workflow-result` marker in the last root assistant reply. If that reply contains several markers, the last marker decides; an invalid last marker leaves the session unlinked. A blocked result may have no PR or head.

Grok Build children join their parent through recorded session IDs and spawning tool calls. Resumed children contribute inherited calls and tools once. Missing child logs appear as incomplete coverage in incidents; displayed totals cover the available logs. Historical status includes active child threads.

For turn aggregates, calls means the reported call count. The context line shows a timestamped estimate or `unknown`. Cost is the list price in `data/prices.json`, marked `est.`: each model's tokens are priced at its average call, so summed input never triggers the long-context rate. The harness's reported charge shows beside it; Grok Build reports its own rate card for `-build` models, a fraction of list price. Summed input stays in token totals and never becomes context.

GitHub Copilot CLI sessions are read only: workflow neither launches, stops nor watches them, and they carry no plan usage or routes. Copilot reports usage per agent and model only when a session shuts down, so each thread has one turn aggregate, in its turn when the thread has one turn and outside any turn otherwise, and a session still running or ended by a crash shows no usage. Copilot's models have no list price, so the cost is the charge Copilot reports in AI credits of one US cent. Copilot compactions show tokens before and after with an unreported charge.

```
wf summary <session>
wf summary <session> --size
```

## uc-2 Cost over the life of a session

Which turns, token types, models, subagents and calls made this session expensive? Subagent cost counts in the turn that spawned it. The most expensive calls mark estimated Claude compaction prices with `est.`.

Turn aggregates split their list price by token type like single calls, and show the reported charge as one amount only when a model has no list price.

```
wf cost <session>
```

## uc-3 What started each turn

Which prompt, command or notification started each turn, and which models, skills and subagents did the turn use, at what cost and with what outcome?

```
wf turns <session>
```

## uc-4 Where tool calls go

Which tool and shell categories does the agent use, how often do they fail, how long do they take, and which shell programs run most?

```
wf tools <session>
```

## uc-5 Where turn time goes

How much of each turn is the model, tools, subagents, and waiting on the person, and how long does the person take between turns?

Model time for a turn aggregate uses its reported API duration. Root-turn wall time uses turn endpoints.

```
wf time <session>
```

## uc-19 Files a session read

Which files did the session read, in which turns, how many reads repeated a file the same thread had already read, how many came after a compaction, which skill and instruction files did each thread read, and which reads were largest? Each table gives the lines and words a read returned beside its tokens, without the line numbers a read tool adds; a read of several files splits them equally, and `-` marks a count the log does not keep. Threads show as `root`, or as the subagent's agent type, such as `code-review`, or `subagent` when the harness logs no type; subagents that share a label are numbered in logged order. Tokens are estimated from result characters with the ratio in `data/thresholds.json`, and the header gives the root thread's read tokens as a share of its peak context. Paths inside the session directory show relative to it, a home folder on Linux, macOS or Windows shows as `~`, and a prefix shows as its alias: `$skills` and `$session` for the folders each harness names, or an alias kept in `data/paths.json`. The header names the prefix behind each alias used. `-a` lists every file.

```
wf files <session>
```

## uc-6 Keep sessions after harnesses delete logs

Codex, Claude Code, Pi, Grok Build and GitHub Copilot CLI can delete old logs. Copy them to the archive so every command still answers for old sessions and Grok Build subagents. `npm run check:real` runs it on real logs; it has no golden file.

```
wf archive
```

## uc-7 Value from each subscription

What do my plans cost me each month, when does each bill next, and how much of each plan have I used? Which plan gives the most usage per euro, and what did each plan and model cost since a moment? Plans and their prices are in `data/subscriptions.json`. Billing figures are in euros, the currency the operator pays in, with USD plans converted at `usdPerEur`; API-equivalent costs stay in dollars.

- By default, the plans running at the latest call or reading: the monthly price, the next billing date and the days to it, the API-equivalent use of the current billing period, its multiplier over the price, and the current weekly window's share used and reset time. A total row sums the prices and the use.
- `--history`: per plan, the logged use against the price paid, so an underused plan scores low, and the value of a full weekly limit with a month of them against the price. The gap between the two multipliers is the plan left unused. Limit hits show which plans capped the work. Then per billing period, the same use against the price, one row per month, ended plans included.
- `--weeks`: per weekly window, newest first: the share used and its cost, counted from the window's start, so plans compare across a plan change. Codex logs report the share used; Claude Code logs report only limit hits, which count as 100%; `wf usage` and `wf route` record every provider's share in a readings file, and a window seen in the logs and the file counts once. A provider that resets a window early ends the old one where the new one starts. The fixtures carry a readings file with an example subscription week below its limit.
- `--models`: per plan and model, calls that ended in the range, each plan's row totalling its models, and providers without a plan paid per token. A range bound with a time of day, UTC unless it carries an offset, gives the spend since a weekly reset.
- `-d` narrows the `--history`, `--weeks` and `--models` tables.
- `-s N` lists instead each rise of N points within a limit window, with its cost, cost per 1%, multiplier and the model that spent most of it, so the operator sees whether an allowance holds within a week and whether it follows the model.

```
wf subscriptions
wf subscriptions --history
wf subscriptions --weeks
wf subscriptions --models -d2002-03-05..
wf subscriptions --models -d2002-02-23T08:00+02:00..
wf subscriptions -s 5
```
