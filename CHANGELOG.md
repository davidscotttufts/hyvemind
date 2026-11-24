# Changelog

## Unreleased

Added:
- **Protected paths** (`protect.paths`): a change to what decides "done" is recorded by
  `gate`, shown by `evidence`, and with `protect.require: "decision"` is not proof until
  the human approves that exact set of changes.
- `census --since <ref> --fail-on <ceiling>`: only the test files a change touched, for a
  line in your own CI.
- `run` refuses an exit check that passes before any work, an attempt that edits a
  protected file outside the task's `Files:`, a `GO` that contradicts or omits its
  findings, and a reviewer that changes files.

Changed:
- `run`'s reviewer must now list `REQ: … | met: yes|no | evidence: …` lines. A bare
  `VERDICT: GO` is refused. A custom `run.reviewer` prompt wrapper needs no change; a
  custom reviewer command that prints only a verdict does.
- `run` runs each exit check once more, before the agent starts.
- **`status`**: pending decisions for the whole machine, and for each registered repo its
  install drift, worktrees and evidence, on one screen. `--prs` adds open pull requests.
- **`worktrees`**: why each worktree is kept or removable. Removable means landed in
  `origin/<base>`, clean, no live process working in it, and untouched for a day.
  `--prune --write` removes those, re-checking each right before, never with `--force`.
- **The decision queue** (`ask`, `decisions`, `decide`): a question for the human is a
  record under `~/.hyvemind/decisions`, listed for the whole machine, oldest first, with
  its options, the asker's recommendation and what it blocks. Answers are recorded with a
  note and never changed. `ask` notifies (macOS, or `notify.command`). Pending is exit 75.
- `run`: a reviewer can answer `VERDICT: UNSURE — <what it needs>`. The task is parked as
  a decision instead of being blocked, and resumes on `accept` (only for the tree the
  reviewer saw) or retries on `reject`.
- The `decisions` skill: file the question, keep working on what doesn't depend on it,
  and don't treat a pending answer as a yes.
- **`fleet`**: one table of every repository on the machine with hyvemind in it and how
  each has drifted. `fleet --scan <dir>` finds installs, including skill folders copied in
  by hand with no `hyvemind.json`. `fleet update` shows what `update` would change
  everywhere, and writes only with `--write`. `init` and `update` register their repo in
  `~/.hyvemind/registry.json`.
- **`mine --friction`**: counts, over the last `--days` (default 30), the typed messages
  that were only "keep going" or "status?", the `AskUserQuestion` stops, and worktrees
  added against removed. It is the baseline for judging a change to how you work.
- `doctor` warns about a `cli` pin older than the hyvemind running the check, and about
  skill folders that look like hyvemind's but were copied in by hand (no manifest entry).
  The second warning also shows in a repo with no `hyvemind.json`.

Fixed:
- A `hyvemind.json` written for 0.2.0 could not `update`: `skills.include`, `exclude` and
  `defer` still named skills that were renamed in 0.3.0 (`evidence`, `skill-miner`, `pr`,
  `spec`, `plan`, `review`, `ship`, `live-qualify`). Old names now resolve to the current
  skill, with a note from `init`/`update` and a `doctor` warning.

## 0.4.1 (2026-11-02)

Fixed:
- With tracegate-ci's broker configured, every eval run failed: hyvemind asked for the
  class `agent`, which the broker refuses, and `--quiet` hid why. Eval runs now use
  `adhoc`, and a test checks every default class against the ones tracegate accepts.
- `probe` with `format: node` tested nothing on Node 20: the reporter flag went after the
  test file, where Node 20 reads it as another file. It now goes in `NODE_OPTIONS`.
- Docs: the `tracegate run` gate example repeated `vitest run` after `--`.

Changed:
- The docs are rewritten in plain language. The eval details move to
  `docs/evals-guide.md`, and the reference now covers `affected --observe/--status`,
  `gate --wait`, `run --branch`, `train --verbose` and `--cwd`.

## 0.4.0 (2026-10-27)

Added:
- **Sandboxed `run`** (`--sandbox podman|docker`): exit checks run in a container with no
  network, dropped capabilities and an allowlisted environment, and the agent can only
  read and edit files. Verified on real Podman.
- **`eval --matrix`**: runs the scenarios once per installed, logged-in agent, with
  separate verdicts and a list of skills whose verdict differs between agents.
- **Clean profiles** for evals (`--clean-profile`), measured with a canary instruction.
  Claude Code's flags drop the user's `CLAUDE.md`. Codex's don't skip
  `~/.codex/AGENTS.md`, so each clean Codex run gets a temporary `CODEX_HOME` holding only
  a link to the login.
- **Honest verdicts:** `saturated` when both arms always pass, Wilson and Newcombe
  intervals, `earning (low n)` when the lift interval includes 0, and per-scenario
  `harmful` and `no-signal` flags.
- **Safer evals:** a cost preview and consent before running, an allowlisted
  environment, agents on their own login rather than API keys, failing outputs kept, and
  machine load recorded.
- **Scenario lint** (`eval --lint`, and in `npm test`): `good` and `bad` examples, and
  checks that a prompt doesn't contradict its own checks. All 58 bundled scenarios are
  clean.
- `probe --isolate` and a per-worktree probe lock.
- Census flags `COMMENTED_ASSERT` and `UNUSED_LOCAL`.
- `train` prints a summary and saves the full log; `--verbose` streams it.

Changed:
- 30 bundled scenarios now ask for `LABEL: <a or b>` instead of a copyable `LABEL: a | b`
  menu. Their lift isn't comparable with earlier rounds, which partly measured whether
  the model copied the menu.

## 0.3.1 (2026-10-26)

Fixed:
- `externalGate` now replaces a preset's gates, instead of conflicting with them.
- `pin --allow-fresh` records a waiver that `doctor` honours for that version only.

## 0.3.0 (2026-10-26)

Added:
- **One definition of done:** `externalGate`, `evidence.status` and `train.via:
  "external"` let a repository keep its own gate and merge path.
- **`hyvemind pin`**, with `integrity` and a 14-day cooling-off period.
- **`census`:** an AST census of every test case, with a grade ceiling per file.
- **`affected` earns trust:** it stays advisory until 20 observations over 7 days with no
  miss.
- `gate` records machine load, and `--wait` waits for quiet.
- `skills.defer`, and the optional tracegate-ci `broker`.
- Probes check that the named test case **failed**, not just that its name appeared.
- New skills: `cleanup`, `release` and `grade`.
- Evals round 2: `write-spec` and `mine-skills` sharpened until they earned.

Changed:
- **Skills dropped the `bee-` prefix** for distinct names (`ship-change`, `write-spec`,
  `plan-tasks`, `review-change`, `open-pr`, `evidence-rules`, `mine-skills`,
  `live-ai-check`). `update` removes the old ones it installed and keeps edited copies.
- `mine` asks before reading transcripts.
- The reference moved to `docs/reference.md`.

Fixed:
- `ENOBUFS` from git in repositories with tens of thousands of files.

## 0.2.0 (2026-10-26)

Added:
- `evidence --post`: gate evidence as a GitHub commit status.
- `train`: a merge queue that gates several PRs at once, checks the merged tree equals the
  gated one, and bisects a red train.
- `run`: a fresh agent per plan task, with the task's exit check and an independent
  reviewer.
- `affected`: test selection from the import graph.
- Evals: 33 scenarios across 13 skills, `no-signal`, `--concurrency`, `--report` and
  `--render`. The first real run: `spec` +0.50, `pr` +0.67, `plan` +0.50 after a rewrite,
  and the other ten saturated on those scenarios.
- 20 self-probes.

## 0.1.0 (2026-10-25)

First release, briefly published as `evidence-harness`.

- `init`, `update`, `doctor`, `list`, `gate`, `evidence`, `probe`, `eval` and `mine`.
- Gate verdicts bound to a working-tree hash.
- Sabotage probes, skill evals, and a transcript miner.
- 11 skills, and the `openwop`, `node`, `python` and `generic` presets.
