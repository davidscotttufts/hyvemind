# 0001: Where the release queue's mechanics should live

Status: Proposed
Date: 2026-11-23

## Problem

Releases across openwop-app, casavoga, kicktodo, bookai and myndhyve-app are sequenced by
one agent session (the release manager) following an 851-line skill, with the state in a
prose file, `<git-common-dir>/release-queue.md`, which had grown to about 1 MB. Measured
over 30 days of transcripts (2026-10-25 to 2026-11-23):

- 3,435 shell commands touched the queue file, and 1,092 called the release bus's
  `note.sh`.
- The rules for taking a slot are re-learned as memory notes in each project
  (`silence-is-not-a-go`, `no-push-after-frozen-head` "did it twice",
  `crossed-instructions-duplicate-gate`).
- A 3.5-hour train bisect left two waiting sessions uninformed
  (`bisecting-train-strands-queued-slots`).
- A coordinator session stopped at a usage limit, and another tool had to reconstruct the
  queue's state from the prose.

The queue is state plus rules. Both are held in text that an agent has to read correctly
every time. Nothing checks them.

## Scope

In: who holds which slot (train, deploy, certify cut, publish), in what order others
wait, how a waiter learns its slot moved, and how the human's GO is recorded.

Out (explicitly): what a train or deploy does, test selection, and the release manager's
judgement calls (routing a red test to its owner, deciding what ships together). Those
stay in the skill.

## What already exists

- **tracegate-ci** has most of the mechanics. `tracegate lease` queues heavy work on one
  machine. `tracegate bus claim --kind deploy` / `bus release <id> --result ok` is a
  cross-machine lease with expiry, compare-and-swap writes and a `bus status` view.
  `tracegate bus note` is the message channel. `tracegate train` holds a lease while it
  runs. The bus never makes anything wait: it warns and carries on.
- **hyvemind** (this stack of changes) has the decision queue (`ask`, `decisions`,
  `decide`), which records a human answer once with a note, and `status`, which shows
  what is waiting on the human across repos.
- **openwop-app** has `scripts/merge-train.sh` (with its own lock), the queue file and
  the skill.

So a third implementation in hyvemind would duplicate tracegate's leases and bus.

## Decision

Do not build a slot ledger in hyvemind. Split the work along the line that already
exists:

1. **Slots and order go to tracegate-ci**, as an extension of the bus: an ordered wait
   list per kind, in the same record the leases are in.
2. **The human's GO goes through hyvemind's decision queue.** A slot that needs approval
   files a decision; the grant refers to the decision id.
3. **The release-manager skill keeps the judgement** and loses the bookkeeping: it reads
   `tracegate bus status` and `hyvemind decisions` instead of maintaining a table by hand.

## Acceptance criteria

For the tracegate-ci change (to be specified there in detail):

- WHEN two sessions request a `train` slot THEN `bus status` lists them in request order,
  and only the first can claim.
- WHEN the holder releases with `--result red` or its lease goes stale THEN the next
  waiter's status changes to `ready`, and a note naming it is posted, without any session
  editing a file.
- WHEN a train starts bisecting THEN its lease kind changes to `bisect` with a new
  expected duration, and every waiter's `bus status` line shows the new estimate.
- WHEN a session claims a slot out of order THEN the claim is refused with the id of the
  session ahead of it. (This changes the bus from advisory to ordered for kinds that opt
  in; kinds that don't opt in keep today's warn-and-continue behaviour.)
- WHEN the coordinator session dies THEN a new session reads the same order and holders
  from `bus status`, with no prose to reconcile.

For hyvemind:

- WHEN a slot is configured to need approval THEN requesting it files exactly one
  decision, and `hyvemind decisions` shows it with what it blocks.
- WHEN that decision is decided THEN `hyvemind status` shows the slot as approved, and the
  decision id is what the claim records.
- WHEN `hyvemind status` runs in a repo with a tracegate bus configured THEN it shows the
  current holders and waiters from `tracegate bus status` (read-only, and skipped with a
  one-line note if tracegate is not installed).

## Alternatives considered

**Do nothing.** Debt: the skill and queue file keep growing, and every new project
re-learns the rules. Forecloses nothing. Fully reversible. It lost because the failures
above recur, and because the state cannot survive a coordinator dying. What would change
my mind: if releases drop to one project and one machine.

**A slot ledger in hyvemind.** Debt: a second lease implementation beside tracegate's,
with its own expiry and cross-machine story to get right. Forecloses a single view of
who holds what. Reversible, at the cost of migrating state. It lost because hyvemind has
no cross-machine store and tracegate's already works. What would change my mind:
tracegate-ci being dropped.

**Keep it in openwop-app scripts.** Debt: every consumer repo copies the scripts, which
is the copy-paste distribution problem this plan is removing. Forecloses use outside the
openwop family. Reversible. It lost for that reason.

## Gaps and risks

- Gap: ordered claims make the bus able to block work, which it deliberately never did.
  Path: opt-in per kind, with stale-lease expiry as the escape. Needs a design review in
  tracegate-ci.
- Gap: the decision queue is per machine, and releases span two Macs. Path: point
  `HYVEMIND_HOME` at shared storage, or have `notify.command` post to `tracegate bus
  note`. Unverified which is better.
- Risk: migrating a live queue. Mitigation: run the ordered bus in shadow beside the
  prose queue for a week and compare, before the skill stops writing the table.
- Risk: the 1 MB queue file is also the release history. Nothing here replaces that log;
  the bus keeps events only while leases live. Unverified whether `tracegate sync`'s
  ledger is enough.

## Plan

1. Accept or change this record. Exit check: status set by the human.
2. Spec and design review in tracegate-ci for ordered waits. Exit check: an accepted spec
   there, with the criteria above made concrete.
3. hyvemind: `status` reads `tracegate bus status`. Exit check: a test with a faked
   `tracegate` on PATH, and one with it absent.
4. hyvemind: approval-needing slots file a decision. Exit check: a test that one request
   files one decision and a decided one unblocks the claim.
5. Shadow week, then cut the table out of the release-manager skill. Exit check:
   `hyvemind mine --friction` and the count of queue-file commands, before and after.

## Open questions

- [ ] Should ordering be enforced (a claim out of order is refused) or stay advisory with
      a loud warning? The memory notes argue for enforced; the bus's design argues against.
- [ ] Which kinds need a human GO by default: deploy and publish only, or trains too?
- [ ] Where does the release history live once the prose queue stops being written?
