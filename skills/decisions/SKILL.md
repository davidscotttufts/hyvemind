---
name: decisions
description: "Put a question for the human in the machine-wide decision queue instead of stopping on it: file it with its options, your recommendation and what it blocks, keep working on everything that does not depend on the answer, and read the answer back later. Use whenever you need a choice, an approval or a missing fact from the human; when several sessions run at once; before you would otherwise stop and wait; and when the human asks what is waiting on them."
---

# Decisions

A question asked inside one session is invisible everywhere else. The human has to find
the session, and until they do, everything behind the question waits. One such question
parked a session for 18 hours. The queue is one list for the whole machine.

## When you need the human

1. **File it, don't stop on it.**

   ```bash
   {{cli}} ask "Export format for the audit log?" \
     --option "CSV" --option "JSON" \
     --recommend "JSON" \
     --blocks "T3 (the export endpoint)" \
     --from "<your session or agent name>"
   ```

   - Ask one question per decision, answerable by picking an option. Two questions
     are two `ask` calls.
   - Always give `--recommend`. If you have no view, say what you would need to form one.
   - `--blocks` names the work that waits, so the human can see what an answer unlocks.
   - Put the facts the human needs in the question itself. They will read it without
     your session open.

2. **Keep working.** Do every task that does not depend on the answer. Stop only when
   nothing is left that is independent of it, and say so in one line with the id.

3. **Read the answer.** `{{cli}} decisions --for <id>` exits 0 with the answer, or 75
   while it is still pending. 75 is not an error and not a "no". Do not re-ask, and do
   not act on your recommendation as if it had been accepted.

4. **Act on exactly what was chosen.** The note is context for that choice, not
   permission for anything else. If the answer makes the question moot, do nothing more
   with it. If you no longer need an answer: `{{cli}} decisions withdraw <id> --note "<why>"`.

## What does not go in the queue

- Anything you can find out yourself: read the code, run the command, check the gate.
- Routine, reversible steps inside the task you were given.
- A request for approval of work that the gate decides. Evidence answers that
  ({{skill:evidence-rules}}), not the human.

An approval the human must give in person (a destructive or outward-facing action) is
still filed here, so it is visible. A filed question is not an approval: wait for the
answer.

## When the human asks "what do you need from me?"

Run `{{cli}} decisions` and report what it prints: every pending question on this
machine, oldest first, with its recommendation. Do not answer from memory of this
session; other sessions have questions too. `--here` limits it to this repository.
