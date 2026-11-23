import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { decide, list as listDecisions } from '../src/decisions.mjs';
import { git } from '../src/git.mjs';
import { inconsistent, order, parsePlan, reviewFindings, runPlan } from '../src/run.mjs';
import { repo, write } from './helpers.mjs';

const PLAN = `# Plan

T1 — Create the greeting
  Files: greet.txt
  Exit check: \`grep -q hello greet.txt\`

T2 — Add a farewell
  Depends on: T1
  Files: bye.txt
  Exit check: \`test -f bye.txt\`
`;

// Fake implementer: writes the file named in the task's "Files:" line, with
// "hello" in it. Its argv is [node, -e, CODE, prompt].
const IMPLEMENT = `const p=process.argv[1];const f=p.match(/Files: (\\S+)/)[1];require('fs').writeFileSync(f,'hello\\n')`;
const LAZY = `/* does nothing */`;
const FLAKY_ONCE = `const fs=require('fs');const p=process.argv[1];const f=p.match(/Files: (\\S+)/)[1];if(p.includes('previous attempt failed'))fs.writeFileSync(f,'hello\\n');else fs.writeFileSync(f,'oops\\n')`;
const GO = `console.log('REQ: the file is written | met: yes | evidence: the diff adds it\\nVERDICT: GO')`;
const NOGO = `console.log('VERDICT: NO-GO — greeting is rude')`;

function setup(implementer, reviewer = GO) {
  const root = repo({ '.gitignore': '.hyve/\n', 'plan.md': PLAN });
  const dir = join(mkdtempSync(join(tmpdir(), 'hyve-run-')), 'wt');
  const cfg = resolveConfig({ version: 1, run: { agent: ['node', '-e', implementer, '{prompt}'], reviewer: ['node', '-e', reviewer, '{prompt}'], maxAttempts: 2 } });
  return { root, dir, cfg };
}

test('parsePlan reads ids, titles, deps, files and the backticked exit check; order respects deps', () => {
  const tasks = parsePlan(PLAN);
  assert.deepEqual(tasks.map((t) => [t.id, t.title, t.deps, t.files, t.check]), [
    ['T1', 'Create the greeting', [], ['greet.txt'], 'grep -q hello greet.txt'],
    ['T2', 'Add a farewell', ['T1'], ['bye.txt'], 'test -f bye.txt'],
  ]);
  const swapped = parsePlan(PLAN.replace(/T1 — /, 'TX — ').replace('T2 — ', 'T1 — ').replace('TX — ', 'T2 — ').replace('Depends on: T1', 'Depends on: T2'));
  assert.deepEqual(order(swapped).map((t) => t.id), ['T2', 'T1']);
  assert.throws(() => parsePlan('T1 — x\n  Depends on: T9\n  Exit check: `true`'), /unknown task T9/);
  assert.throws(() => parsePlan('T1 — x\n  Files: a'), /no "Exit check:"/);
  assert.throws(() => order(parsePlan('T1 — a\n  Depends on: T2\n  Exit check: `true`\nT2 — b\n  Depends on: T1\n  Exit check: `true`')), /cycle/);
});

test('each task: fresh agent, own exit check, independent review, one commit', () => {
  const { root, dir, cfg } = setup(IMPLEMENT);
  const { report } = runPlan(root, cfg, 'plan.md', { dir });
  assert.deepEqual(report.tasks.map((t) => t.status), ['done', 'done']);
  assert.deepEqual(report.tasks.map((t) => t.review), ['GO', 'GO']);
  assert.deepEqual(git(dir, ['log', '--format=%s', '-2']).out.split('\n'), ['T2: Add a farewell', 'T1: Create the greeting']);
});

test('a failing exit check gets one repair attempt fed with the failure output', () => {
  const { root, dir, cfg } = setup(FLAKY_ONCE);
  const { report } = runPlan(root, cfg, 'plan.md', { dir, only: ['T1'] });
  assert.equal(report.tasks[0].status, 'done');
  assert.deepEqual(report.tasks[0].attempts.map((a) => a.checkExit), [1, 0]);
});

test('an agent that never satisfies the check stops the run; nothing is committed', () => {
  const { root, dir, cfg } = setup(LAZY);
  const { report } = runPlan(root, cfg, 'plan.md', { dir });
  assert.equal(report.tasks[0].status, 'failed-check');
  assert.equal(report.tasks.length, 1, 'T2 never starts');
  assert.equal(git(dir, ['log', '--format=%s', '-1']).out, 'init');
});

test('a NO-GO review blocks the commit and leaves the change for a human', () => {
  const { root, dir, cfg } = setup(IMPLEMENT, NOGO);
  const { report } = runPlan(root, cfg, 'plan.md', { dir });
  assert.equal(report.tasks[0].status, 'review-blocked');
  assert.match(report.tasks[0].review, /NO-GO/);
  assert.ok(existsSync(join(dir, 'greet.txt')), 'change left in the worktree');
  assert.match(readFileSync(join(dir, '.hyve-review-T1.txt'), 'utf8'), /rude/);
  assert.equal(git(dir, ['log', '--format=%s', '-1']).out, 'init');
});

test('re-running resumes: committed tasks are skipped', () => {
  const { root, dir, cfg } = setup(IMPLEMENT);
  runPlan(root, cfg, 'plan.md', { dir, only: ['T1'] });
  const { report } = runPlan(root, cfg, 'plan.md', { dir });
  assert.deepEqual(report.tasks.map((t) => t.status), ['already-done', 'done']);
});

const UNSURE = `console.log('VERDICT: UNSURE — proof that greet.txt is read by the app; the diff only creates it')`;
const decisionsHome = () => mkdtempSync(join(tmpdir(), 'hyve-run-dec-'));
const quiet = { notifier: () => {} };

test('an UNSURE review files a decision and stops as waiting; accepting it commits exactly that change', () => {
  const { root, dir, cfg } = setup(IMPLEMENT, UNSURE);
  const decisions = decisionsHome();
  const first = runPlan(root, cfg, 'plan.md', { dir, decisions, ...quiet }).report;
  assert.deepEqual(first.tasks.map((t) => t.status), ['waiting']);
  const [d] = listDecisions({}, { dir: decisions });
  assert.equal(first.tasks[0].decision, d.id);
  assert.match(d.question, /T1 \(Create the greeting\): the reviewer could not decide\. It needs: proof that greet\.txt is read/);
  assert.deepEqual(d.options, ['accept', 'reject']);
  assert.equal(git(dir, ['log', '--format=%s', '-1']).out, 'init', 'nothing is committed while it waits');
  assert.ok(existsSync(join(dir, 'greet.txt')), 'the change is kept for the human to look at');

  const again = runPlan(root, cfg, 'plan.md', { dir, decisions, ...quiet }).report;
  assert.deepEqual(again.tasks.map((t) => t.status), ['waiting'], 'still pending: no agent runs, no second question');
  assert.equal(listDecisions({ state: 'all' }, { dir: decisions }).length, 1);

  decide(d.id, 'accept', { note: 'wired up in T2' }, { dir: decisions });
  // The reviewer would still say UNSURE; the accepted task must not be reviewed again.
  const done = runPlan(root, cfg, 'plan.md', { dir, decisions, only: ['T1'], ...quiet }).report;
  assert.deepEqual(done.tasks.map((t) => t.status), ['done']);
  assert.match(done.tasks[0].review, /UNSURE, accepted by the human \(d-\d{8}-[0-9a-f]{4}: wired up in T2\)/);
  assert.match(git(dir, ['log', '--format=%B', '-1']).out, /^T1: Create the greeting/);
});

test('an accepted decision covers only the tree the reviewer saw; a rejected one is retried with the reason', () => {
  const a = setup(IMPLEMENT, UNSURE);
  const decisions = decisionsHome();
  runPlan(a.root, a.cfg, 'plan.md', { dir: a.dir, decisions, ...quiet });
  const [d] = listDecisions({}, { dir: decisions });
  decide(d.id, 'accept', {}, { dir: decisions });
  write(a.dir, { 'greet.txt': 'hello\nand something nobody reviewed\n' });
  const changed = runPlan(a.root, a.cfg, 'plan.md', { dir: a.dir, decisions, ...quiet }).report;
  assert.equal(changed.tasks[0].status, 'waiting', 'a different tree goes through review again, and is parked again');
  assert.equal(listDecisions({ state: 'all' }, { dir: decisions }).length, 2);
  assert.equal(git(a.dir, ['log', '--format=%s', '-1']).out, 'init');

  // Reject: the next attempt starts clean and is told why.
  const SEES_REASON = `const fs=require('fs');const p=process.argv[1];fs.writeFileSync('greet.txt', p.includes('the human rejected it: wrong file') ? 'hello told\\n' : 'hello\\n')`;
  const b = setup(SEES_REASON, UNSURE);
  const home2 = decisionsHome();
  runPlan(b.root, b.cfg, 'plan.md', { dir: b.dir, decisions: home2, ...quiet });
  decide(listDecisions({}, { dir: home2 })[0].id, 'reject', { note: 'wrong file' }, { dir: home2 });
  const cfgGo = resolveConfig({ version: 1, run: { agent: b.cfg.run.agent, reviewer: ['node', '-e', GO, '{prompt}'], maxAttempts: 2 } });
  const retried = runPlan(b.root, cfgGo, 'plan.md', { dir: b.dir, decisions: home2, only: ['T1'], ...quiet }).report;
  assert.equal(retried.tasks[0].status, 'done');
  assert.equal(readFileSync(join(b.dir, 'greet.txt'), 'utf8'), 'hello told\n', 'the retry saw the human\'s reason');
});

test('with no decision queue, UNSURE blocks like any verdict that is not GO', () => {
  const { root, dir, cfg } = setup(IMPLEMENT, UNSURE);
  const { report } = runPlan(root, cfg, 'plan.md', { dir, decisions: null });
  assert.equal(report.tasks[0].status, 'review-blocked');
  assert.match(report.tasks[0].review, /^UNSURE/);
});

test('an exit check that passes before any work stops the task: no agent runs, nothing is committed', () => {
  const root = repo({ '.gitignore': '.hyve/\n', 'plan.md': 'T1 — Add a greeting\n  Files: greet.txt\n  Exit check: `test -f README.md`\n' });
  const dir = join(mkdtempSync(join(tmpdir(), 'hyve-run-')), 'wt');
  const MARK = `require('fs').writeFileSync('agent-ran.txt','x')`;
  const cfg = resolveConfig({ version: 1, run: { agent: ['node', '-e', MARK, '{prompt}'], reviewer: ['node', '-e', GO, '{prompt}'] } });
  const { report } = runPlan(root, cfg, 'plan.md', { dir, decisions: null });
  assert.equal(report.tasks[0].status, 'check-already-passes');
  assert.equal(report.tasks[0].baselineExit, 0);
  assert.ok(!existsSync(join(dir, 'agent-ran.txt')), 'the agent was never started');
  assert.equal(git(dir, ['log', '--format=%s', '-1']).out, 'init');
});

test('an implementer that edits a protected file fails the attempt, even though the exit check would pass', () => {
  const plan = 'T1 — Make the total right\n  Files: src/total.js\n  Exit check: `node test/total.test.js`\n';
  const files = { '.gitignore': '.hyve/\n', 'plan.md': plan, 'src/total.js': 'module.exports = () => 1;\n', 'test/total.test.js': "if (require('../src/total.js')() !== 2) process.exit(1);\n" };
  // Cheats on the first try by rewriting the test; fixes the code once told off.
  const CHEAT_THEN_FIX = `const fs=require('fs');const p=process.argv[1];if(p.includes('You changed protected files'))fs.writeFileSync('src/total.js','module.exports = () => 2;\\n');else fs.writeFileSync('test/total.test.js','process.exit(0)\\n')`;
  const mk = (agent, protect) => ({ root: repo(files), dir: join(mkdtempSync(join(tmpdir(), 'hyve-run-')), 'wt'), cfg: resolveConfig({ version: 1, protect, run: { agent: ['node', '-e', agent, '{prompt}'], reviewer: ['node', '-e', GO, '{prompt}'], maxAttempts: 2 } }) });

  const a = mk(CHEAT_THEN_FIX, { paths: ['test/**'] });
  const { report } = runPlan(a.root, a.cfg, 'plan.md', { dir: a.dir, decisions: null });
  assert.equal(report.tasks[0].status, 'done');
  assert.deepEqual(report.tasks[0].attempts[0].protectedTouched, [{ path: 'test/total.test.js', change: 'modified' }]);
  assert.equal(report.tasks[0].attempts[0].checkExit, -1, 'the cheated attempt was never scored by the check it rewrote');
  assert.match(readFileSync(join(a.dir, 'test/total.test.js'), 'utf8'), /!== 2/, 'the test is back as it was');

  const ALWAYS_CHEAT = `require('fs').writeFileSync('test/total.test.js','process.exit(0)\\n')`;
  const b = mk(ALWAYS_CHEAT, { paths: ['test/**'] });
  assert.equal(runPlan(b.root, b.cfg, 'plan.md', { dir: b.dir, decisions: null }).report.tasks[0].status, 'touched-protected');
  assert.equal(git(b.dir, ['log', '--format=%s', '-1']).out, 'init');

  // Without protect the same cheat is accepted: this is the hole the setting closes.
  const c = mk(ALWAYS_CHEAT, { paths: [] });
  assert.equal(runPlan(c.root, c.cfg, 'plan.md', { dir: c.dir, decisions: null }).report.tasks[0].status, 'done');

  // A task that declares a test file in its Files may write it.
  const d = mk(`const fs=require('fs');fs.writeFileSync('src/total.js','module.exports = () => 2;\\n');fs.appendFileSync('test/total.test.js','// covers the new total\\n')`, { paths: ['test/**'] });
  write(d.root, { 'plan.md': plan.replace('Files: src/total.js', 'Files: src/total.js, test/total.test.js') });
  assert.equal(runPlan(d.root, d.cfg, 'plan.md', { dir: d.dir, decisions: null }).report.tasks[0].status, 'done');
});

test('a GO must agree with its own findings, and a reviewer may not change files', () => {
  assert.deepEqual(reviewFindings('REQ: adds greet | met: yes | evidence: greet.txt:1\n- REQ: handles empty | met: no | evidence: no test'), [
    { requirement: 'adds greet', met: true, evidence: 'greet.txt:1' }, { requirement: 'handles empty', met: false, evidence: 'no test' }]);
  assert.match(inconsistent('GO', []), /no REQ lines/);
  assert.match(inconsistent('GO', [{ requirement: 'x', met: false, evidence: 'e' }]), /contradicts its own findings: not met: x/);
  assert.match(inconsistent('GO', [{ requirement: 'x', met: true, evidence: '' }]), /without evidence for: x/);
  assert.equal(inconsistent('GO', [{ requirement: 'x', met: true, evidence: 'a.js:3' }]), null);
  assert.equal(inconsistent('NO-GO', []), null, 'only an approval has to show its work');

  const run = (reviewer) => { const { root, dir, cfg } = setup(IMPLEMENT, reviewer); return { dir, task: runPlan(root, cfg, 'plan.md', { dir, decisions: null }).report.tasks[0] }; };
  const bare = run(`console.log('looks fine\\nVERDICT: GO')`);
  assert.equal(bare.task.status, 'review-blocked');
  assert.match(bare.task.review, /refused: GO with no REQ lines/);
  const selfContradicting = run(`console.log('REQ: says hello | met: no | evidence: file says hi\\nVERDICT: GO')`);
  assert.match(selfContradicting.task.review, /refused: GO contradicts its own findings/);
  const meddling = run(`require('fs').writeFileSync('greet.txt','hello, fixed it for you\\n');console.log('REQ: says hello | met: yes | evidence: greet.txt\\nVERDICT: GO')`);
  assert.equal(meddling.task.status, 'review-blocked');
  assert.match(meddling.task.review, /refused: the reviewer changed files/);
  assert.equal(git(meddling.dir, ['log', '--format=%s', '-1']).out, 'init', 'nothing a reviewer rewrote is committed');
});
