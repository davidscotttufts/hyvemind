import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWorktrees, landedProof, parseWorktrees, processCwds, pruneWorktrees } from '../src/worktrees.mjs';
import { repo, sh, write } from './helpers.mjs';

// A repo with a bare "origin", so origin/main exists and can move.
function withOrigin() {
  const root = repo();
  const origin = join(mkdtempSync(join(tmpdir(), 'hyve-origin-')), 'o.git');
  sh(root, 'git', ['init', '-q', '--bare', origin]);
  sh(root, 'git', ['remote', 'add', 'origin', origin]);
  sh(root, 'git', ['push', '-q', '-u', 'origin', 'main']);
  return root;
}
const commit = (dir, file, msg) => { write(dir, { [file]: `${msg}\n` }); sh(dir, 'git', ['add', '-A']); sh(dir, 'git', ['commit', '-q', '-m', msg]); return sh(dir, 'git', ['rev-parse', 'HEAD']); };
function worktree(root, name) {
  const dir = join(mkdtempSync(join(tmpdir(), 'hyve-wt-')), name);
  sh(root, 'git', ['worktree', 'add', '-q', dir, '-b', name, 'origin/main']);
  return realpathSync(dir);
}
// Land a branch on origin/main the way a merge button does.
const land = (root, branch) => { sh(root, 'git', ['merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch]); sh(root, 'git', ['push', '-q', 'origin', 'main']); };
const none = new Map();
const old = { quietHours: 0 }; // these fixtures were made seconds ago
const by = (rows, dir) => rows.find((r) => r.path === dir);

test('parseWorktrees reads paths, branches, detached, locked and prunable entries', () => {
  const rows = parseWorktrees('worktree /a\nHEAD 111\nbranch refs/heads/main\n\nworktree /b\nHEAD 222\ndetached\nlocked reason\n\nworktree /c\nHEAD 333\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n');
  assert.deepEqual(rows.map((r) => [r.path, r.branch, r.detached, r.locked, r.prunable, r.main]), [['/a', 'main', false, false, false, true], ['/b', null, true, true, false, false], ['/c', 'x', false, false, true, false]]);
});

test('removable only when landed AND clean AND idle; each missing condition is named', () => {
  const root = withOrigin();
  const merged = worktree(root, 'merged'); commit(merged, 'a.txt', 'a'); land(root, 'merged');
  const open = worktree(root, 'open'); commit(open, 'b.txt', 'b');
  const dirty = worktree(root, 'dirty'); commit(dirty, 'c.txt', 'c'); land(root, 'dirty'); write(dirty, { 'notes.txt': 'unsaved\n' });
  const locked = worktree(root, 'locked'); commit(locked, 'd.txt', 'd'); land(root, 'locked'); sh(root, 'git', ['worktree', 'lock', locked]);
  const rows = inspectWorktrees(root, { cwds: none, merged: null, self: tmpdir(), ...old });
  assert.equal(by(rows, realpathSync(root)).state, 'main');
  assert.equal(by(rows, merged).state, 'removable');
  assert.equal(by(rows, merged).landed, 'ancestor of origin/main');
  assert.deepEqual(by(rows, open).why, ['not proven landed in origin/main']);
  assert.deepEqual(by(rows, dirty).why, ['1 uncommitted or untracked file(s)'], 'an untracked file is unsaved work');
  assert.deepEqual(by(rows, locked).why, ['locked']);
  assert.match(inspectWorktrees(root, { cwds: none, merged: null, self: merged, ...old }).find((r) => r.path === merged).why[0], /this command is running in it/);
  // By default a worktree git wrote to within a day is kept: it may be about to be used.
  const fresh = by(inspectWorktrees(root, { cwds: none, merged: null, self: tmpdir() }), merged);
  assert.equal(fresh.state, 'keep');
  assert.deepEqual(fresh.why, ['git wrote to it 0h ago (under 24h)']);
  const later = by(inspectWorktrees(root, { cwds: none, merged: null, self: tmpdir(), now: Date.now() + 25 * 3_600_000 }), merged);
  assert.equal(later.state, 'removable');
});

test('a squash-merged branch is landed only when a merged PR has exactly its head', () => {
  const root = withOrigin();
  const wt = worktree(root, 'squashed');
  const first = commit(wt, 'a.txt', 'one');
  const head = commit(wt, 'b.txt', 'two');
  // Squash onto main: no ancestry, and two commits are not patch-equivalent to one.
  sh(root, 'git', ['merge', '-q', '--squash', 'squashed']); sh(root, 'git', ['commit', '-q', '-m', 'squash']); sh(root, 'git', ['push', '-q', 'origin', 'main']);
  const w = { head, branch: 'squashed' };
  assert.equal(landedProof(root, w, 'main', null), null, 'without PR data a squash is not proven');
  assert.equal(landedProof(root, w, 'main', new Map([['squashed', new Set([first])]])), null, 'a PR merged at an OLDER head does not cover the later commit');
  assert.equal(landedProof(root, w, 'main', new Map([['squashed', new Set([head])]])), 'a merged PR has exactly this head');
});

test('a worktree with a live process in it survives, however merged and clean it is', async () => {
  const root = withOrigin();
  const busy = worktree(root, 'busy'); commit(busy, 'a.txt', 'a'); land(root, 'busy');
  const idle = worktree(root, 'idle'); commit(idle, 'b.txt', 'b'); land(root, 'idle');
  const child = spawn('node', ['-e', 'setTimeout(()=>{}, 60000)'], { cwd: busy, stdio: 'ignore' });
  try {
    // The real process table: this is the check that failed in production.
    let cwds;
    for (let i = 0; i < 40; i++) { cwds = processCwds(); if (cwds.has(child.pid)) break; await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(realpathSync(cwds.get(child.pid)), busy, 'processCwds sees the child');
    const rows = inspectWorktrees(root, { merged: null, self: tmpdir(), ...old });
    assert.equal(by(rows, busy).state, 'keep');
    assert.match(by(rows, busy).why[0], /1 live process\(es\) working in it/);
    const out = pruneWorktrees(root, { merged: null, self: tmpdir(), ...old });
    assert.deepEqual(out.map((o) => [o.path, o.removed]), [[idle, true]]);
    assert.ok(existsSync(busy), 'the busy worktree is still there');
    assert.ok(!existsSync(idle));
  } finally { child.kill(); }
});

test('prune re-checks right before removing: a session that started meanwhile keeps its worktree', () => {
  const root = withOrigin();
  const wt = worktree(root, 'late'); commit(wt, 'a.txt', 'a'); land(root, 'late');
  const out = pruneWorktrees(root, { cwds: none, merged: null, self: tmpdir(), ...old, recheckCwds: () => new Map([[999999, wt]]) });
  assert.equal(out[0].removed, false);
  assert.match(out[0].why, /live process/);
  assert.ok(existsSync(wt));
});
