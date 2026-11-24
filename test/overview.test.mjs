import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask } from '../src/decisions.mjs';
import { fleetUpdate, register } from '../src/fleet.mjs';
import { overview, renderOverview } from '../src/overview.mjs';
import { repo, sh, write } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/hyvemind.mjs', import.meta.url));
const config = (dir, extra = {}) => writeFileSync(join(dir, 'hyvemind.json'), JSON.stringify({ version: 1, gates: [{ name: 't', run: 'true' }], skills: { include: ['open-pr'], targets: ['.claude/skills'] }, agentsMd: { paths: [] }, ...extra }));

test('status: pending decisions for the whole machine, and each repo\'s install, worktrees and evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyve-ov-home-'));
  const a = repo({ '.gitignore': '.hyve/\n' }); config(a);
  const b = repo(); config(b, { externalGate: { run: 'make verify', done: 'ci/verify is green' }, gates: undefined, evidence: { status: 'ci/verify' }, train: { via: 'external' } });
  register(a, 'init', { dir }); register(b, 'init', { dir });
  fleetUpdate({ dir, write: true });
  sh(a, 'git', ['worktree', 'add', '-q', join(mkdtempSync(join(tmpdir(), 'hyve-ov-wt-')), 'side'), '-b', 'side']);
  write(a, { 'scratch.txt': 'unsaved\n' });
  ask({ question: 'Cut 1.2.0 now?', options: ['now', 'later'], recommend: 'later', cwd: a }, { dir, notifier: () => {} });

  const calls = [];
  const view = overview({ dir, cwds: new Map(), evidence: (path) => { calls.push(path); return { ok: false, message: 'no gate has run on this tree' }; } });
  assert.equal(view.pending.length, 1);
  const [ra, rb] = [realpathSync(a), realpathSync(b)].map((p) => view.repos.find((r) => r.path === p));
  assert.equal(ra.decisions, 1);
  assert.equal(rb.decisions, 0);
  assert.deepEqual(ra.worktrees, { total: 2, busy: 0, unsaved: 1, removable: 0 });
  assert.deepEqual(ra.evidence, { ok: false, message: 'no gate has run on this tree' });
  assert.deepEqual(calls, [realpathSync(a)], 'a commit-status repo is not read without --prs: that needs the network');
  assert.match(rb.evidence.message, /proof is the commit status "ci\/verify" \(shown with --prs\)/);
  assert.equal(ra.prs, undefined);

  const withPrs = overview({ dir, prs: true, cwds: new Map(), evidence: () => ({ ok: true, message: 'green' }), pullRequests: () => [{ number: 7, title: 'fix the thing', draft: false, branch: 'x', checks: 'red' }, { number: 8, title: 'wip', draft: true, branch: 'y', checks: 'none' }] });
  const text = renderOverview(withPrs);
  assert.match(text, /WAITING ON YOU \(1\)/);
  assert.match(text, /Cut 1\.2\.0 now\?.*\[recommended: later\]/);
  assert.match(text, /worktrees {2}2 · 0 with a live process · 1 with unsaved files · 0 removable/);
  assert.match(text, /PRs {8}2 open · 1 red · 0 pending · 0 green · 1 draft/);
  assert.match(text, /red: #7 fix the thing/);
  assert.match(renderOverview({ pending: [], repos: [] }), /Nothing is waiting on you\.[\s\S]*No repositories registered/);
});

test('CLI: status and worktrees run end to end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyve-ov-home2-'));
  const a = repo({ 'package.json': '{"name":"a","scripts":{"test":"true"}}' });
  const env = { ...process.env, HYVEMIND_HOME: dir, HYVEMIND_NOTIFY: 'off' };
  const run = (...args) => spawnSync('node', [BIN, ...args], { cwd: a, encoding: 'utf8', env });
  assert.equal(run('init').status, 0);
  const st = run('status');
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /Nothing is waiting on you\./);
  assert.match(st.stdout, /install {4}current/);
  const wt = run('worktrees');
  assert.equal(wt.status, 0, wt.stderr);
  assert.match(wt.stdout, /the main worktree/);
  assert.match(run('worktrees', '--prune').stdout, /nothing is removable/);
  assert.match(run('worktrees', '--quiet-hours', 'x').stderr, /--quiet-hours must be a number/);
});
