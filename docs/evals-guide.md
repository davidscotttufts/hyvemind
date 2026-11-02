# Evals guide

`hyvemind eval` measures whether each skill still helps: it runs a skill's scenarios with
and without the skill, and reports the difference. This page covers how verdicts are
reached, how to run evals, and what the clean profile does. Measured results are in
[evals/](evals/).

## Scenarios

Scenarios live in `skills/<skill>/evals/*.json` (bundled) and
`.hyve/scenarios/<skill>/*.json` (yours). Each runs in a fresh scratch git repository
twice: once bare, once with the skill. Both runs are scored mechanically, by output
patterns, files or commands.

Agents are argv templates in `evals.agents`:

```json
"evals": { "agent": "claude", "agents": { "claude": { "command": ["claude", "-p", "{prompt}"] },
                                          "codex":  { "command": ["codex", "exec", "{prompt}"] } } }
```

## Verdicts

| Verdict | Meaning |
|---|---|
| `earning` | Lift is at least `liftThreshold` (default 0.2), and its 95% interval excludes 0. |
| `earning (low n)` | Lift is at least the threshold, but the interval includes 0. Run more trials before citing it. |
| `marginal` | Lift is positive but below the threshold. |
| `saturated` | Both arms pass every run. The scenarios can't measure the skill; write a harder one rather than retire it. |
| `retire-candidate` | Lift is 0 or less, and the bare arm is below 100%. |
| `no-signal` | Neither arm ever passes. The scenario or the skill is broken. |
| `insufficient-data` | Fewer than `minRuns` runs (default 3). Never retire a skill on one run. |

Each arm gets a 95% Wilson interval. The lift interval is Newcombe's hybrid score interval
for a difference of proportions (method 10 in Newcombe 1998), treating the arms as
independent: with skill arm (p₁, l₁, u₁) and bare arm (p₂, l₂, u₂) and d = p₁ − p₂,
`lower = d − √((p₁−l₁)² + (u₂−p₂)²)` and `upper = d + √((u₁−p₁)² + (p₂−l₂)²)`. At 3 runs
per arm, only 3/3 against 0/3 clears 0.

The report has a row per scenario and flags `harmful` (the skill arm passes less often
than bare) and `no-signal`, listed at the top, because a skill-level average hides them.
It also shows each skill's size in words (tokens ≈ words × 1.3) next to its lift.
`--render <report.json>` recomputes everything from an old report's runs with today's
rules.

## Scenario lint

A scenario can carry example answers: `good` (should pass) and `bad` (a plausible wrong
answer, usually the one the prompt's trap invites). `hyvemind eval --lint` checks them
without calling a model, and `npm test` lints every bundled scenario.

- Every `good` must pass all of the scenario's checks, and every `bad` must fail at least
  one.
- A scenario with neither is reported as unlinted, not as an error.
- `file-exists` and `command` checks need the workspace the agent changed, so a scenario
  with them is linted on its output checks only, and marked partial.

The lint also catches prompts that contradict their own checks. It reads the lines the
prompt tells the model to print (such as "end with exactly one line: `GRADE: <letter>`")
and scores each against the checks that name its label, plus every `output-excludes` and
`output-not-matches` check:

| Finding | Level |
|---|---|
| A line dictated word for word fails the checks: obeying the prompt fails the scenario. | error |
| A menu (`a \| b`) where no offered answer passes. | error |
| A placeholder line (`LABEL: <a or b>`) passes when printed verbatim, so copying it can't be told from answering. | error (`placeholder-echo-passes`) |
| A `LABEL: a \| b` menu fails when echoed verbatim. | warning (`menu-echo`) |
| A verbatim echo of the menu passes. | warning (`menu-echo-passes`) |

`menu-echo` exists because one round's prompt said `GRADE: A | unverified`, and the model
printed exactly that in every run of both arms. `LABEL: <a or b>` is unambiguous.

## Running evals

**Consent.** Before any agent starts, `eval` prints the plan: skills, scenarios, trials,
total runs, concurrency, and a duration estimate (an upper bound, plus the median of past
runs when there are any). On a terminal it asks `[y/N]`; otherwise it needs `--yes`.
`--dry-run` prints the plan and stops.

**One scenario.** `hyvemind eval write-spec:do-nothing-alternative` runs one scenario.
`--scenario <id>` (repeatable) filters every named skill. A filter that matches nothing
is an error.

**Environment.** Agents get an allowlisted environment, never the whole of yours: `PATH`,
`HOME`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, `USER` and `HYVE_EVAL_ARM`. Scenario
setup and checks get the same, plus a git identity for setup. If an agent needs a
variable to authenticate, name it in that agent's `env`; only names go in config, never
values:

```json
"evals": { "agents": { "claude": { "env": ["ANTHROPIC_API_KEY"] }, "codex": { "env": ["OPENAI_API_KEY"] } } }
```

**Logins, not API keys.** By default agents run on the login you already have (your Claude
Code or Codex subscription), so a run never bills a key unless you name one. Each
built-in agent has an `authCheck`: its CLI's status command, run with a 15-second timeout.
Only the exit code counts (plus a `match` regex for `opencode`, which exits 0 either way).
The output is never printed or stored, because status commands print account emails. An
agent with no `authCheck` is assumed to be logged in.

**Which agent.** In order: `--agent`, the project's `evals.agent`, the agent hyvemind is
running inside (Claude Code sets `CLAUDECODE=1`; Codex sets nothing documented), then the
default. An agent that isn't logged in is refused before you're asked to start.

**Load.** A run that times out on a busy machine looks like a skill failure. Before each
job, `eval` samples the machine and records the busiest sample on the report as
`contention`. If any job started contended, the report says so, and those failures
should be re-run rather than read. `--wait <min>` waits for the machine to quiet down,
up to that many minutes in total. With a `broker` configured, the broker queues the work
instead.

**Matrix** (`--matrix`, or `--agent a,b,c`). Runs the scenarios once per agent.
`--matrix` uses every configured agent that is installed and logged in; the others are
listed as skipped.

- Nothing is pooled: each agent gets its own runs, verdicts and intervals.
- One consent covers the whole matrix, with each agent's share in the preview.
- The report opens with **disagreements**: skills whose verdict differs between agents.
  That's the reason to run a matrix. A saturated result on one agent says nothing about
  another.
- `--model` is refused for a matrix, because a model id belongs to one vendor. Put the
  model in each agent's `command` instead.

**Kept outputs.** Every failing run's full output (up to 8 MB) is saved under
`.hyve/evals/<run-id>/…`, and linked from the markdown report. `--keep` also keeps passing
runs and the scratch workspaces.

**Version.** Reports are stamped `<version>+<short sha>` from a git checkout (`-dirty` if
it has changes), or the plain version from an installed package.

## The clean profile

By default the bare arm isn't fully bare: an agent CLI loads your own skills, global
instructions, settings, MCP servers and memory in both arms. `--clean-profile` adds the
agent's `cleanArgs` and `cleanEnv` to **both** arms. It's refused for an agent with no
`cleanArgs`.

If the agent's `command` has a `{clean}` argument, the `cleanArgs` go there (and without
`--clean-profile`, `{clean}` expands to nothing). That's for CLIs whose flags must follow
a subcommand, like `["codex", "exec", "{clean}", "{prompt}"]`. Otherwise they go right
after the executable.

**Claude Code:**

```json
"cleanArgs": ["--setting-sources", "project,local", "--strict-mcp-config"],
"cleanEnv": { "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1" }
```

Leaving out the `user` settings source drops your `~/.claude/CLAUDE.md` while keeping
project skills, which the skill arm needs. `--strict-mcp-config` with no `--mcp-config`
loads no MCP servers, and login doesn't depend on settings sources. Measured on
2026-10-26: with a canary instruction in `~/.claude/CLAUDE.md`, plain `claude -p`
followed it and the clean profile didn't. User skills and plugins weren't measured; the
docs imply they're dropped too.

Ruled out: `--safe-mode` (disables project skills, so the skill arm would be bare too),
`--bare` (needs an API key), an empty `CLAUDE_CONFIG_DIR` (loses the login), and copying
credentials into a temporary profile.

**Codex** (from `codex exec --help`, codex-cli 0.164.0):

```json
"command": ["codex", "exec", "{clean}", "{prompt}"],
"cleanArgs": ["--ignore-user-config", "--ephemeral", "--ignore-rules"],
"cleanHome": { "env": "CODEX_HOME", "from": "~/.codex", "keep": ["auth.json"] }
```

The three flags skip `config.toml`, session files and `.rules` files, but measured on
2026-10-26 they do **not** skip `$CODEX_HOME/AGENTS.md`: a canary there was followed with
and without them. So each clean run also gets a fresh private temp directory as
`CODEX_HOME`, holding only a **link** to `auth.json`. Codex logs in through the link and
finds no instructions, config or memory; with the canary in place, the clean run didn't
follow it.

- The login is linked, never copied, read or logged. If Codex refreshes its token by
  replacing the link with a file, that file is moved back in one atomic rename, but only
  if the real file is unchanged since the run started and no other writer holds the
  lock. Otherwise the fresher real file wins.
- The temp directory is removed when the run ends, after a timeout, and on SIGINT or
  SIGTERM.
- The preview says what it will do before anything runs.

**OpenCode** has no clean profile. Its only candidate, `--pure`, drops plugins and
nothing else that the help documents.

hyvemind never reads, copies or prints credential files or tokens. Before citing a clean
baseline on your machine, repeat the canary test: put a uniquely named instruction or
skill in your user profile, run one scenario with `--clean-profile --keep`, and check
that neither arm's output shows it.
