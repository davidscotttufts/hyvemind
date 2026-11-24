// Run a plan: each task goes to a FRESH agent process (fresh context) in a
// dedicated worktree, is accepted only when its own exit check passes, then is
// reviewed by an independent agent before the next task starts.
//
// Plan format (what plan-tasks writes):
//   T2 — Add the parser
//     Depends on: T1
//     Files: src/parse.mjs, test/parse.test.mjs
//     Test first: …
//     Exit check: `node --test test/parse.test.mjs`
//
// The exit check is the first `backticked` command on the "Exit check:" line, or
// the whole value if there are no backticks. Done is decided by that command's
// exit code, never by the agent's own report.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { STATE_DIR } from './config.mjs';
import { argv } from './evals.mjs';
import { ask, list as listDecisions } from './decisions.mjs';
import { git, workingTree } from './git.mjs';
import { home } from './home.mjs';
import { matcher, snapshot, violations } from './protect.mjs';
import { runInSandbox, SANDBOXED_ROLES, sandboxConfig } from './sandbox.mjs';

export function parsePlan(text) {
  const tasks = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^\s*(?:[-*]\s*)?\**(T\d+)\**\s*[—–:-]+\s*(.+?)\s*$/);
    if (h) { cur = { id: h[1], title: h[2].replace(/\*+$/, '').trim(), deps: [], files: [], body: [line] }; tasks.push(cur); continue; }
    if (!cur) continue;
    cur.body.push(line);
    const kv = line.match(/^\s+([A-Za-z ]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const val = kv[2].trim();
    if (key === 'depends on') cur.deps = val.match(/T\d+/g) ?? [];
    else if (key === 'files') cur.files = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'exit check') cur.check = val.match(/`([^`]+)`/)?.[1] ?? val;
  }
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    t.body = t.body.join('\n').trimEnd();
    for (const d of t.deps) if (!ids.has(d)) throw new Error(`${t.id} depends on unknown task ${d}`);
    if (!t.check) throw new Error(`${t.id} has no "Exit check:"; every task needs one`);
  }
  return tasks;
}

// Dependency order (stable: plan order breaks ties). Throws on a cycle.
export function order(tasks) {
  const out = [], state = new Map();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (t, path) => {
    if (state.get(t.id) === 'done') return;
    if (state.get(t.id) === 'busy') throw new Error(`dependency cycle: ${[...path, t.id].join(' → ')}`);
    state.set(t.id, 'busy');
    for (const d of t.deps) visit(byId.get(d), [...path, t.id]);
    state.set(t.id, 'done');
    out.push(t);
  };
  for (const t of tasks) visit(t, []);
  return out;
}

const sh = (cmd, cwd, timeoutSec) => {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
};

function agentRun(command, prompt, cwd, timeoutSec) {
  const [cmd, ...args] = argv(command, { prompt, workdir: cwd });
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim(), error: r.error?.message };
}

export function implementPrompt(task, spec, failure) {
  return [
    'You are implementing ONE task of a larger plan. Change only what this task needs.',
    spec ? `\n## Spec\n${spec}` : '',
    `\n## Your task\n${task.body}`,
    `\n## Done means\nThis command exits 0, run from the repository root:\n    ${task.check}`,
    'Do not commit. Do not edit the exit check or any test to make it pass; fix the code.',
    failure ? `\n## Your previous attempt failed the exit check\n${failure.slice(-2000)}` : '',
  ].join('\n');
}

export function reviewPrompt(task, spec, diff) {
  return [
    'You are an independent reviewer. You did not write this change.',
    spec ? `\n## Spec\n${spec}` : '',
    `\n## Task\n${task.body}`,
    `\n## Diff\n${diff.slice(0, 60000)}`,
    '\nReview only for defects that matter: wrong behaviour, missing acceptance criteria, security, data loss, a test that cannot fail.',
    'Do not change any file.',
    'For each thing the task or spec requires, write one line: "REQ: <requirement> | met: yes|no | evidence: <file and line, or what you ran>".',
    'If you cannot tell from the diff whether a requirement is met, do not guess either way.',
    'End with exactly one line: "VERDICT: GO", "VERDICT: NO-GO — <reason>", or "VERDICT: UNSURE — <what you would need to see to decide>".',
  ].join('\n');
}

// A reviewer's findings, and whether its verdict agrees with them. GO needs at least one
// REQ line and no "met: no": a bare GO is the reviewer's word, and a GO that lists an
// unmet requirement contradicts itself. Returns a refusal reason, or null.
export function reviewFindings(out) {
  return [...out.matchAll(/^\W*REQ:\s*(.+?)\s*\|\s*met:\s*(yes|no)\b\s*(?:\|\s*evidence:\s*(.*))?$/gim)].map((m) => ({ requirement: m[1], met: m[2].toLowerCase() === 'yes', evidence: (m[3] ?? '').trim() }));
}
export function inconsistent(verdict, findings) {
  if (verdict !== 'GO') return null;
  if (!findings.length) return 'GO with no REQ lines: nothing shows what was checked';
  const unmet = findings.filter((f) => !f.met);
  if (unmet.length) return `GO contradicts its own findings: not met: ${unmet.map((f) => f.requirement).join('; ')}`;
  const bare = findings.filter((f) => !f.evidence);
  if (bare.length) return `GO without evidence for: ${bare.map((f) => f.requirement).join('; ')}`;
  return null;
}

// The latest decision a run filed for this task in this worktree, if any.
function parkedDecision(decisions, dir, taskId) {
  if (!decisions) return null;
  return listDecisions({ state: 'all' }, { dir: decisions }).filter((d) => d.ref?.kind === 'run' && d.ref.dir === dir && d.ref.task === taskId).at(-1) ?? null;
}

export function runPlan(root, cfg, planFile, opts = {}) {
  const log = opts.log ?? (() => {});
  // Where an UNSURE review parks its question. Without a home (a test with none set),
  // UNSURE blocks like a missing verdict.
  const decisions = opts.decisions === undefined ? home() : opts.decisions;
  const sb = sandboxConfig(cfg, opts.sandbox);
  // Sandboxed: roles default to read/edit-only tools, so the agent cannot execute
  // anything on the host; code runs only inside the container, via the exit check.
  const roles = sb ? { agent: SANDBOXED_ROLES.implementer, reviewer: SANDBOXED_ROLES.reviewer } : { agent: ['claude', '-p', '--permission-mode', 'acceptEdits', '{prompt}'], reviewer: ['claude', '-p', '{prompt}'] };
  const runCfg = { ...roles, maxAttempts: 2, timeoutSec: 1800, ...(cfg.run ?? {}) };
  delete runCfg.sandbox;
  const check = (command) => {
    if (!sb) return sh(command, dir, runCfg.timeoutSec);
    if (sb.setup) {
      const s = runInSandbox(sb, dir, sb.setup, runCfg.timeoutSec, { network: sb.setupNetwork });
      if (s.code !== 0) return { code: s.code, out: `sandbox setup \`${sb.setup}\` failed:\n${s.out}` };
    }
    return runInSandbox(sb, dir, command, runCfg.timeoutSec, { network: false });
  };
  const tasks = order(parsePlan(readFileSync(resolve(root, planFile), 'utf8')));
  const spec = opts.spec ? readFileSync(resolve(root, opts.spec), 'utf8') : null;
  const name = basename(planFile).replace(/\.[^.]+$/, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  const branch = opts.branch ?? `hyve/run-${name}`;
  const dir = resolve(root, opts.dir ?? join('..', `${basename(root)}-hyve-run-${name}`));
  const base = opts.base ?? 'HEAD';
  const only = opts.only ? new Set(opts.only) : null;

  if (!existsSync(dir)) {
    const exists = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).status === 0;
    const add = exists ? ['worktree', 'add', '-q', dir, branch] : ['worktree', 'add', '-q', '-b', branch, dir, base];
    const r = git(root, add);
    if (r.status !== 0) throw new Error(`git ${add.join(' ')}: ${r.err}`);
  }
  const done = new Set(git(dir, ['log', '--format=%s']).out.split('\n').map((s) => s.match(/^(T\d+):/)?.[1]).filter(Boolean));
  const report = { plan: planFile, branch, dir, startedAt: new Date().toISOString(), tasks: [],
    ...(sb ? { sandbox: { runtime: sb.runtime, image: sb.image, checkNetwork: 'none', setup: sb.setup, agentShell: Boolean(cfg.run?.agent) ? 'as configured in run.agent' : 'none (read/edit tools only)' } } : {}) };

  for (const task of tasks) {
    if (only && !only.has(task.id)) continue;
    if (done.has(task.id)) { report.tasks.push({ id: task.id, status: 'already-done' }); log(`${task.id} already committed on ${branch}; skipping`); continue; }
    const blocked = task.deps.find((d) => !done.has(d));
    if (blocked) { report.tasks.push({ id: task.id, status: 'blocked', on: blocked }); log(`${task.id} blocked on ${blocked}`); break; }

    const entry = { id: task.id, title: task.title, check: task.check, attempts: [] };
    report.tasks.push(entry);
    let failure = null;
    // An earlier run's reviewer was unsure about this task and asked the human.
    const parked = parkedDecision(decisions, dir, task.id);
    let accepted = null;
    if (parked?.state === 'pending') {
      entry.status = 'waiting'; entry.decision = parked.id;
      log(`${task.id} is waiting on decision ${parked.id}: hyvemind decide ${parked.id} <accept|reject>`);
      break;
    }
    if (parked?.state === 'decided' && parked.decision.choice === 'accept') {
      // The human accepted exactly the change the reviewer saw. Anything else on disk
      // is a different change, and goes through the check and the review again.
      if (workingTree(dir) === parked.ref.tree) accepted = parked;
      else log(`${task.id}: decision ${parked.id} accepted a different tree than the one on disk; running the task again`);
    } else if (parked?.state === 'decided' && parked.decision.choice === 'reject' && workingTree(dir) === parked.ref.tree) {
      failure = `A reviewer could not verify your previous attempt (${parked.question}) and the human rejected it${parked.decision.note ? `: ${parked.decision.note}` : ''}`;
      git(dir, ['checkout', '-q', '--', '.']);
      git(dir, ['clean', '-q', '-fd']);
    }
    // Red baseline: an exit check that passes before any work proves nothing about the
    // work. Either the task is already done or the check is too weak to tell.
    if (!accepted && git(dir, ['status', '--porcelain']).out === '') {
      entry.baselineExit = check(task.check).code;
      if (entry.baselineExit === 0) {
        entry.status = 'check-already-passes';
        log(`${task.id}: the exit check passes before any work (${task.check}). Either the task is already done or the check cannot fail; fix the plan. No agent was run.`);
        break;
      }
    }
    // The task may write the files it declares; every other protected path is off limits.
    const guarded = matcher(cfg);
    for (let a = 1; a <= (accepted ? 0 : runCfg.maxAttempts); a++) {
      log(`${task.id} — ${task.title} · attempt ${a}/${runCfg.maxAttempts}`);
      const before = snapshot(dir, guarded, task.files);
      const agent = agentRun(runCfg.agent, implementPrompt(task, spec, failure), dir, runCfg.timeoutSec);
      const touched = violations(before, snapshot(dir, guarded, task.files));
      if (touched.length) {
        // Not run through the check at all: a pass bought by editing the grader is not a pass.
        entry.attempts.push({ agentExit: agent.code, protectedTouched: touched, checkExit: -1 });
        failure = `You changed protected files, which decide whether work passes and are not part of this task: ${touched.map((t) => `${t.path} (${t.change})`).join(', ')}. Leave them alone and fix the code. If one of them really must change, say so and stop.`;
        log(`${task.id}: attempt ${a} touched protected files (${touched.map((t) => t.path).join(', ')}); rolled back`);
        git(dir, ['checkout', '-q', '--', '.']);
        git(dir, ['clean', '-q', '-fd']);
        continue;
      }
      const result = check(task.check);
      entry.attempts.push({ agentExit: agent.code, ...(agent.error ? { agentError: agent.error } : {}), checkExit: result.code });
      if (result.code === 0) break;
      // Always non-empty: a check that fails silently (grep -q, test -f) still tells
      // the next attempt THAT it failed and with which command.
      failure = `\`${task.check}\` exited ${result.code}${result.out ? `:\n${result.out}` : ' with no output'}`;
      git(dir, ['checkout', '-q', '--', '.']); // a failed attempt leaves nothing behind
      git(dir, ['clean', '-q', '-fd']);
    }
    if (accepted) {
      // The exit check still decides: an accepted change that no longer passes is not done.
      const result = check(task.check);
      entry.attempts.push({ resumedFrom: accepted.id, checkExit: result.code });
    }
    if (entry.attempts.at(-1).checkExit !== 0) {
      entry.status = entry.attempts.at(-1).protectedTouched ? 'touched-protected' : 'failed-check';
      log(entry.status === 'touched-protected' ? `${task.id} STOPPED: every attempt changed protected files` : `${task.id} FAILED its exit check after ${runCfg.maxAttempts} attempt(s): ${task.check}`);
      break;
    }
    git(dir, ['add', '-A']);
    const diff = git(dir, ['diff', '--cached']).out;
    if (!diff) {
      entry.status = 'no-change';
      log(`${task.id}: exit check passes with no change; nothing to commit (was it already done, or is the check vacuous?)`);
      done.add(task.id);
      continue;
    }
    if (accepted) {
      entry.review = `UNSURE, accepted by the human (${accepted.id}${accepted.decision.note ? `: ${accepted.decision.note}` : ''})`;
    } else if (opts.review !== false) {
      const treeReviewed = workingTree(dir);
      const rev = agentRun(runCfg.reviewer, reviewPrompt(task, spec, diff), dir, runCfg.timeoutSec);
      let verdict = rev.out.match(/VERDICT:\s*(GO|NO-GO|UNSURE)\b(.*)$/m);
      entry.review = verdict ? `${verdict[1]}${verdict[2]}`.trim() : 'no verdict';
      entry.findings = reviewFindings(rev.out);
      // A reviewer reads. One that changed the tree reviewed something other than what is committed.
      const refused = workingTree(dir) !== treeReviewed ? 'the reviewer changed files in the worktree' : inconsistent(verdict?.[1], entry.findings);
      if (refused) { entry.review = `refused: ${refused}`; verdict = null; }
      if (verdict?.[1] === 'UNSURE' && decisions) {
        // The reviewer could not decide, and says what it would need. That is a question
        // for the human, not a NO-GO: park the task, keep the change, stop the run.
        git(dir, ['reset', '-q']);
        const needs = verdict[2].replace(/^[\s—–:-]+/, '').trim() || 'it did not say what it needs';
        const d = ask({ question: `${task.id} (${task.title}): the reviewer could not decide. It needs: ${needs}`, options: ['accept', 'reject'], blocks: `${planFile}: ${task.id} and every task after it`, from: `hyvemind run ${planFile}`, ref: { kind: 'run', dir, plan: planFile, task: task.id, tree: workingTree(dir) }, cwd: dir }, { dir: decisions, ...(opts.notifier ? { notifier: opts.notifier } : {}) });
        entry.status = 'waiting'; entry.decision = d.id;
        log(`${task.id} review: ${entry.review}. Filed ${d.id}; the change is uncommitted in ${dir}. Answer with: hyvemind decide ${d.id} <accept|reject>, then re-run.`);
        break;
      }
      if (!verdict || verdict[1] !== 'GO') {
        entry.status = 'review-blocked';
        writeFileSync(join(dir, `.hyve-review-${task.id}.txt`), rev.out);
        git(dir, ['reset', '-q']);
        log(`${task.id} review: ${entry.review}. Changes left uncommitted in ${dir} for you.`);
        break;
      }
    }
    const c = git(dir, ['commit', '-q', '-m', `${task.id}: ${task.title}`, '-m', `Exit check: ${task.check}\nReview: ${entry.review ?? 'skipped'}`]);
    if (c.status !== 0) throw new Error(`commit failed: ${c.err}`);
    entry.status = 'done';
    done.add(task.id);
    log(`${task.id} done${entry.review ? ` · review ${entry.review}` : ''}`);
  }
  report.finishedAt = new Date().toISOString();
  const out = join(root, STATE_DIR, 'runs');
  mkdirSync(out, { recursive: true });
  const file = join(out, `run-${name}-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return { report, file };
}
