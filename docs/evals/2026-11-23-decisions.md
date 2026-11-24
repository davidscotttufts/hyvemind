> Read this with care. Two of the three scenarios ask for the exact command, which a bare
> model cannot know, so most of this lift is the skill teaching the tool. The one scenario
> about behaviour (`pending-is-not-an-answer`) passes in both arms: today's model already
> treats a pending answer as no answer. Every run started on a busy machine. A first run
> scored both command scenarios 0/3 in both arms because their prompts said "do not run
> anything", and the agent then declined to load the skill; the prompts now forbid only
> shell commands.

# hyvemind skill evals

Agent **claude** · hyvemind 0.4.1+3a0280f-dirty · 2026-11-23T20:16:41.430Z

> **Contended run.** 18 of 18 jobs started on a busy machine (worst: load 7.02 on 10 cores). Failures and timeouts here are not evidence about a skill; re-run when quiet (`--wait <min>`).

Each scenario runs in a fresh scratch repo twice per trial: once **bare** (no skill) and once **with** the skill. Lift = with − bare.
Brackets are 95% intervals (Wilson per arm; Newcombe hybrid score for lift). A lift is **earning** only when its interval excludes 0; otherwise **earning (low n)**.
Words are the rendered skill as installed; tokens ≈ words × 1.3 (approximate).

| Skill | Scenarios | Runs/arm | Bare [95% CI] | With skill [95% CI] | Lift [95% CI] | Words (≈tokens) | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| decisions | 3 | 9 | 33% [12–65%] | 100% [70–100%] | +0.67 [+0.23, +0.88] | 509 (≈662) | **earning** |

## What to do

- **decisions** (earning): Keep.

## Per scenario

| Skill | Scenario | Bare | With skill | Lift | Flags |
|---|---|---:|---:|---:|---|
| decisions | file-and-continue | 0/3 | 3/3 | +1 | — |
| decisions | pending-is-not-an-answer | 3/3 | 3/3 | 0 | — |
| decisions | what-do-you-need | 0/3 | 3/3 | +1 | — |

## Failed runs

- decisions · file-and-continue · bare trial 1: [output](../../.hyve/evals/2026-11-23T20-16-41-430Z/decisions/file-and-continue/bare-1.txt)
- decisions · file-and-continue · bare trial 2: [output](../../.hyve/evals/2026-11-23T20-16-41-430Z/decisions/file-and-continue/bare-2.txt)
- decisions · file-and-continue · bare trial 3: [output](../../.hyve/evals/2026-11-23T20-16-41-430Z/decisions/file-and-continue/bare-3.txt)
- decisions · what-do-you-need · bare trial 1: [output](../../.hyve/evals/2026-11-23T20-16-41-430Z/decisions/what-do-you-need/bare-1.txt)
- decisions · what-do-you-need · bare trial 2: [output](../../.hyve/evals/2026-11-23T20-16-41-430Z/decisions/what-do-you-need/bare-2.txt)
- decisions · what-do-you-need · bare trial 3: [output](../../.hyve/evals/2026-11-23T20-16-41-430Z/decisions/what-do-you-need/bare-3.txt)

Ran with --clean-profile: both arms got the agent's cleanArgs/cleanEnv. See docs/reference.md for what that does and does not exclude.
