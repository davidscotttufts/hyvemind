# hyvemind reference

Every command, the config file and the presets. For what hyvemind is and why, see the
[README](../README.md).

## Install

```bash
npx -y hyvemind@0.4.1 init      # detects the project; writes hyvemind.json, the skills and an AGENTS.md block
npx -y hyvemind@0.4.1 doctor    # checks the setup
npx -y hyvemind@0.4.1 gate      # runs your gates and records the evidence
```

Commit `hyvemind.json`, the installed skills, `AGENTS.md` and `.hyve/manifest.json`. Evidence
and eval reports under `.hyve/` are git-ignored automatically.

Installed skills call the CLI as `npx -y hyvemind@<exact version>`, taken from the `cli`
field in `hyvemind.json`. An exact version means `npx` can't pick up a look-alike package.
To pin hyvemind as a dev dependency instead:

```bash
npm i -D hyvemind@0.4.1                           # from npm
npm i -D github:davidscotttufts/hyvemind#v0.4.1   # or from GitHub
npx hyvemind init                                 # writes "cli": "npx hyvemind"
```

### Pinning the CLI's contents

An exact version doesn't stop different bytes being served under it, or a malicious
release being adopted the day it appears. `hyvemind pin` pins the content too:

```bash
npx -y hyvemind@0.4.1 pin       # writes "cli" and "integrity" into hyvemind.json
```

- **Integrity.** `integrity` is npm's `dist.integrity` for that version. `doctor` checks it
  against the registry and fails on a mismatch. Offline, it warns that it couldn't check.
- **Cooling-off.** `pin` refuses a release younger than `coolingOffDays` (default 14), since
  most malicious releases are caught within days. `--allow-fresh` overrides it for a
  release you've reviewed.
- **Or let a lockfile do it.** Installed as a dev dependency, hyvemind's integrity is in
  your lockfile, and skills call `node_modules/.bin/hyvemind` without downloading
  anything. No `integrity` field is needed then.

### Presets

`init` picks a preset from what the repository has. `--preset` overrides it.

| Preset | Detected by | Gates |
|---|---|---|
| `openwop` | a root `ci` script, `backend/typescript` and `frontend/react` | `npm run ci`, with Vitest probe lanes for both halves |
| `node` | `package.json` | whichever of `lint`, `typecheck`, `test` and `build` exist |
| `python` | `pyproject.toml` or `setup.py` | `python -m pytest -q` |
| `generic` | anything else | none; add your own |

### Choosing skills

Install only some:

```json
{ "version": 1, "skills": { "include": ["evidence-rules", "skill-eval", "mine-skills"] } }
```

Or keep a bundled skill but let one of your own win where it applies:

```json
"skills": { "defer": { "review-change": "review", "open-pr": "pr" } }
```

A deferred skill is still installed, with a note at the top to follow your skill instead
where it applies. Deferring a skill that isn't bundled, or that you excluded, is an error.

### Upgrading

Change the version in `cli` (or bump the dev dependency) and run `update`. It replaces the
skills hyvemind installed, but keeps any you've edited, and any same-named skill that was
there before, and tells you about both. `--force` overwrites them. Skill names are chosen
not to clash with common project skills (`review`, `plan`, `pr`); `skills.prefix` adds a
namespace if you want one.

### A project with its own gate

If the repository already has a merge gate, point hyvemind at it rather than adding a
second definition of done:

```json
"externalGate": { "run": "node scripts/local-ci.mjs --pr <n> --post",
                  "done": "the `ci/local-verify` status is success on the PR head" },
"evidence": { "status": "ci/local-verify" },
"train": { "via": "external", "message": "merges go through the release queue" }
```

- **`externalGate`** is for agents: the AGENTS.md block names your gate and what done
  means. hyvemind runs neither.
- **`evidence.status`** is the same thing for the CLI. `hyvemind evidence` passes only when
  the latest status with that name on HEAD is `success` and the working tree is clean and
  equal to HEAD. `evidence --post` then posts nothing of its own.
- **`train.via: "external"`** turns off `hyvemind train`: it refuses, prints
  `train.message`, and changes nothing.

`doctor` warns about real gaps, such as `externalGate` without `evidence.status`. The
reasoning is in [design.md](design.md#one-definition-of-done).

### Optional: tracegate-ci's broker

When several agents share a machine, their test suites starve each other.
[tracegate-ci](https://github.com/davidscotttufts/tracegate-ci)'s broker is one queue for
all of a machine's CI work. Configure it, and hyvemind runs every gate, train gate, probe
and eval run through `tracegate lease`:

```json
"broker": { "command": "tracegate", "tokens": { "eval": 1 } }
```

They use tracegate's `gate`, `train`, `measure` and `adhoc` classes; override them under
`broker.classes`. Without `broker`, commands run directly, and hyvemind never depends on
it. `doctor` checks the broker is reachable.

For a Vitest project, tracegate can also be the gate, running only what a change can
affect once that's been shown safe:
`"gates": [{ "name": "backend", "run": "tracegate run --lane backend" }]`. Arguments after
`--` go to `vitest run`, so don't repeat `vitest run` there.

## Commands

```
hyvemind init | update | doctor | list
hyvemind pin [--allow-fresh] [--dry-run]
hyvemind gate [--only a,b] [--keep-going] [--quiet] [--wait min]
hyvemind evidence [--post [--dry-run]]
hyvemind affected [--base ref] [--json] [--run] [--observe] [--status]
hyvemind census [path…] [--out file] [--md file]
hyvemind train <pr…> [--no-merge] [--no-bisect] [--local] [--base branch] [--verbose]
hyvemind run plan.md [--spec spec.md] [--only T1,T2] [--no-review] [--branch name] [--sandbox podman|docker]
hyvemind probe probes.json [--isolate]
hyvemind eval [skill[:scenario]…] [--agent a] [--matrix] [--trials n] [--yes] [--dry-run] …
hyvemind mine [--all] [--json] [--yes]
```

Every command takes `--cwd <dir>`; the default is the git root of the current directory.
`hyvemind --help` lists every option.

### gate and evidence

`gate` runs your gates and writes `.hyve/evidence/gate-<time>.json`: HEAD, the tree hash
before and after, each gate's exit code and time, and a verdict. `--wait <min>` first waits,
up to that long, for other test suites and load on the machine to clear.

| Verdict | Meaning |
|---|---|
| `green` | Every gate passed, and the tree didn't change. |
| `red` | A gate failed. Later gates are skipped unless you pass `--keep-going`. |
| `invalid` | The tree changed during the run (a formatter, codegen, a concurrent edit), so it proves nothing. |

The tree hash covers tracked and untracked files, minus ignored ones. It's computed in a
throwaway index, so your staging area is never touched.

`evidence` exits 0 only if the current tree has a full green run. `evidence --post` sets a
`hyvemind/gate` commit status on HEAD through `gh` (`success`, `failure` or `error`). It
refuses when the working tree differs from HEAD, when the only run was partial (`--only`),
or when nothing has been gated.

### train

```bash
hyvemind train 412 415 419           # GitHub PRs
hyvemind train --local feat-a feat-b # branches on origin
```

The train is `origin/<base>` with each PR merged in order, gated in a persistent worktree
(`train.dir`, default `../<repo>-hyve-train`) so installed dependencies survive between
trains. `train.setup` (for example `npm ci`) runs before each gate.

- **Green:** it merges each PR, then checks that the base's new tree equals the gated
  tree. If not, it stops with `TREE MISMATCH`.
- **The base moved during the gate:** it rebuilds and gates again (`train.retries`,
  default 1), and otherwise refuses to merge.
- **Red:** it splits the train in half and gates each half. Green halves merge; the
  culprit is named and left open.
- **A PR that doesn't merge cleanly:** reported and skipped.

One train runs per clone at a time. It never deletes branches, because that would close
PRs stacked on them.

### run

`hyvemind run plan.md` runs a plan in the format `plan-tasks` writes:

```
T2 — Add the parser
  Depends on: T1
  Files: src/parse.mjs
  Exit check: `node --test test/parse.test.mjs`
```

For each task, in dependency order, in its own worktree on branch `hyve/run-<plan>`:

1. A fresh agent process implements it (`run.agent`; default Claude Code with
   `acceptEdits`).
2. The task's exit check decides whether it's done. A failed attempt is rolled back and
   retried once, with the failing output given to the agent.
3. A separate reviewer (`run.reviewer`) must answer `VERDICT: GO`.
4. Each task is one commit. Re-running resumes after the last committed task.

**Sandboxed runs.** With `--sandbox podman` (or `docker`, or `run.sandbox`), the code runs
in a container, while the agent itself stays on the host, where your login is.

- Exit checks run with the worktree at `/work`, no network, all capabilities dropped,
  `no-new-privileges`, and memory and CPU limits.
- An optional `run.sandbox.setup` (such as `npm ci`) runs before each exit check, with
  network unless `setupNetwork: false`.
- Only the variables in `run.sandbox.env` get in (default: `CI`, `NODE_ENV`, `LANG`, `TZ`).
  No home directory, tokens or SSH agent.
- The agent loses its shell: the implementer gets `Read,Grep,Glob,Edit,Write` and the
  reviewer `Read,Grep,Glob`, so anything the agent writes runs only inside the container.
  Setting `run.agent` yourself replaces this, and the run report says so.

The image defaults to `node:22-bookworm`. `doctor` checks the runtime. Verified on real
Podman 6.1.4 (macOS arm64, 2026-10-26): exit codes pass through, checks have no network,
variables outside the allowlist are absent, `~/.ssh`, `~/.codex` and `~/.claude` are
absent, files written in `/work` belong to you, and `chown` is refused. Repeat it on
your runtime with `HYVE_SANDBOX_REAL=podman npm test`.

### affected

`hyvemind affected` walks the import graph backwards from what changed: commits since
`--base`, uncommitted edits and untracked files. It follows static and dynamic imports,
`require`, TypeScript's `.js`→`.ts`, `index` files and `affected.aliases`.

It selects every test when a change can't be traced: `package.json`, lockfiles, test or
build config, `.env` (`affected.fullRunOn`), or any other non-code file that isn't
ignored, such as a JSON fixture. Docs and skills select nothing (`affected.ignore`).
`--run` runs `affected.command` with `{tests}`. It's for fast inner loops; the full gate
still decides what's done.

A static guess has to earn trust before you rely on it. `--observe` runs every test and
checks that each failing file was in the selection; `--status` shows where that stands.
`affected` stays advisory (`shadow`) until 20 observations over 7 days with no miss
(`affected.trust.minObservations`, `minDays`), and any miss starts the count again.

### census

`hyvemind census [path…]` reads every test file's syntax tree with your project's own
TypeScript, flags cases that can't fail or claim little, and gives each file a grade
ceiling.

- Flags include cases that assert nothing, assert only inside an `if`, check only a status
  code or a mock call, or duplicate another case.
- `COMMENTED_ASSERT` marks an `expect(` or `assert(` inside a comment: an assertion the
  case meant to make and doesn't run. It counts as a weak claim, which caps the file at B,
  or at C when every case is flagged that way. Quote a call in backticks to write about it
  in prose.
- `UNUSED_LOCAL` is a hint, never a cap: a local the case declares and never reads, often
  the value an assertion was meant to check.

The ledger (`--out`, default `.hyve/census.json`) is keyed on each file's git blob, so a
grade lasts only while the file is unchanged. `--md` writes a summary. Settings:
`census.testPattern`, `census.headerRef`, `census.typescriptFrom`.

### probe

```json
[{ "id": "auth-skip", "src": "src/auth.ts", "old": "if (!user) throw", "new": "if (false) throw",
   "test": "src/auth.test.ts", "lane": "default", "expectRed": ["rejects anonymous"] }]
```

For each probe, hyvemind replaces `old` with `new` in `src` (`old` must appear exactly
once), runs `probe.command` with `{test}` from the lane's directory, then restores the file
and checks the restore. Each probe gets one verdict: `witnessed`, `vacuous`, `other-red`
or `error`.

- `vacuous` means the test stayed green with the code broken. `other-red` means it went
  red, but not in the named cases or output.
- `expectRed` needs `probe.format` set to `vitest` or `node`, and must name cases that
  actually **failed**. Without per-case results the verdict is `error`. `expectOutput`
  only checks that text appears, which a passing case's name can satisfy.
- A failure matching `probe.errorPatterns` (red for the wrong reason) never counts.
- It refuses a file with uncommitted changes, and takes a per-worktree lock. Don't pull or
  check out in that tree while it runs, or use `--isolate` to probe a throwaway worktree of
  HEAD (set up with `probe.setup`, defaulting to `train.setup`).

### eval

`hyvemind eval` runs each skill's scenarios with and without the skill, and reports the
lift and a verdict per skill. It asks before starting, runs agents on your existing login,
and never passes API keys unless you name them. See the [evals guide](evals-guide.md) for
verdicts, scenario lint, the multi-agent matrix and the clean profile, and
[evals/](evals/) for measured results.

### mine

`hyvemind mine` reads your Claude Code transcripts, locally and only after asking, for
skill chains you repeat by hand, and proposes combined skills. It reports aggregates only.

## The skills

| Skill | When | What it does |
|---|---|---|
| `ship-change` | all | Runs a change from spec to PR, sized to the change, stopping at each gate. |
| `write-spec` | requirements | Writes a spec grounded in the existing code, with criteria a test can check. |
| `design-review` | design | Reviews a design; every finding names a concrete failure. Ends GO or NO-GO. |
| `plan-tasks` | planning | Splits work into tasks one fresh agent can do, each with its own exit check. |
| `review-change` | review | Runs the full gate first, then reviews for real defects and accounts for every file. |
| `cleanup` | maintenance | Removes code only when it's proved dead, and reports what looked dead but was kept. |
| `test-necessity` | tests | Grades tests by whether they can fail, using probes; fixes or deletes them with evidence. |
| `grade` | audit | Grades code, data, UX, localization or two lists that should match, A–F, in a tracker that resumes. |
| `open-pr` | release | Opens a PR only with green evidence for this exact commit; asks before the PR or any comment. |
| `release` | release | Cuts a version from the commits, tags the merge commit, and checks the published artifact. |
| `evidence-rules` | always | What counts as proof: a status code doesn't, an empty result is suspect. |
| `parallel-work` | always | Git hygiene when several agents share one repository. |
| `skill-eval` | meta | Measures each skill against the bare model. |
| `mine-skills` | meta | Finds skill chains you repeat by hand. |
| `ai-exchange` | AI review | Grades every place your app talks to an LLM. |
| `live-ai-check` | AI tests | Runs your app's AI features against real models, with keys by name only. |

## Configuration

The full schema is [`schema/hyvemind.schema.json`](../schema/hyvemind.schema.json). Values
merge in this order: defaults, the preset, then `hyvemind.json`. Objects merge; arrays
replace.

## Development

```bash
npm ci                                            # once: the census tests need TypeScript
npm test
node bin/hyvemind.mjs probe test/self-probes.json # hyvemind probes its own tests
```

Each core guarantee has a self-probe that shows its test goes red when the guarantee is
broken.

## Releasing

Releases publish from GitHub Actions with npm Trusted Publishing and provenance, so no npm
token is stored anywhere.

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then `git tag -a vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z`.

[`publish.yml`](../.github/workflows/publish.yml) checks the tag matches the version, runs
the tests and self-probes, and publishes. It won't overwrite a version already on npm with
different contents.

## License

Apache-2.0
