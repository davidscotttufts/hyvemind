// Worktree hygiene: which worktrees of this repository are finished, and which only
// look finished.
//
// A cleanup sweep once removed worktrees that live sessions were working in. "The PR
// is merged" was the test, and it is not enough. A worktree is removable only when all
// of these hold, each checked by a command and re-checked immediately before removal:
//   - landed:  every commit on it is in origin/<base> (ancestor, or patch-equivalent
//              for a rebase), or a MERGED pull request's head is exactly its HEAD
//   - clean:   no modified, staged or untracked files
//   - idle:    no process has its working directory inside it (a session, a test run)
//   - quiet:   git has not written to it for a day (a worktree made an hour ago for a
//              session about to start is clean, idle and trivially "landed")
//   - not locked, not the main worktree, and not the one this command runs from
import { spawnSync } from 'node:child_process';
import { readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';

export function parseWorktrees(porcelain) {
  return porcelain.split(/\n\n+/).map((b) => b.trim()).filter(Boolean).map((block, i) => {
    const w = { path: null, head: null, branch: null, detached: false, locked: false, prunable: false, main: i === 0 };
    for (const line of block.split('\n')) {
      const [k, ...v] = line.split(' ');
      const val = v.join(' ');
      if (k === 'worktree') w.path = val;
      else if (k === 'HEAD') w.head = val;
      else if (k === 'branch') w.branch = val.replace(/^refs\/heads\//, '');
      else if (k === 'detached') w.detached = true;
      else if (k === 'locked') w.locked = true;
      else if (k === 'prunable') w.prunable = true;
    }
    return w;
  }).filter((w) => w.path);
}

// pid → working directory, for every process this user can see. One lsof call (macOS)
// or /proc (Linux); asking per pid is far too slow on a busy machine.
export function processCwds() {
  const out = new Map();
  try {
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try { out.set(Number(pid), readlinkSync(`/proc/${pid}/cwd`)); } catch { /* gone, or not ours */ }
    }
    if (out.size) return out;
  } catch { /* no /proc: not linux */ }
  const r = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let pid = null;
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) out.set(pid, line.slice(1));
  }
  return out;
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const inside = (dir, p) => p === dir || p.startsWith(`${dir}/`);

// MERGED pull requests by head branch → the head commit that was merged. Optional:
// without gh, or off GitHub, a squash-merged branch simply stays "not landed".
export function mergedHeads(root, { gh = 'gh' } = {}) {
  const r = spawnSync(gh, ['pr', 'list', '--state', 'merged', '--limit', '300', '--json', 'headRefName,headRefOid'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return null;
  const by = new Map();
  try { for (const p of JSON.parse(r.stdout)) { if (!by.has(p.headRefName)) by.set(p.headRefName, new Set()); by.get(p.headRefName).add(p.headRefOid); } } catch { return null; }
  return by;
}

// Is everything on `head` already in origin/<base>? Returns the proof, or null.
export function landedProof(root, w, base, merged) {
  const ref = `origin/${base}`;
  if (git(root, ['rev-parse', '--verify', '-q', ref]).status !== 0) return null;
  if (git(root, ['merge-base', '--is-ancestor', w.head, ref]).status === 0) return `ancestor of ${ref}`;
  const cherry = git(root, ['cherry', ref, w.head]);
  if (cherry.status === 0 && cherry.out && !cherry.out.split('\n').some((l) => l.startsWith('+'))) return `every commit is patch-equivalent to one in ${ref}`;
  // A squash merge leaves no ancestry. The proof is a merged PR whose head IS this commit:
  // a merged PR for the same branch at an older commit does not cover later commits.
  if (w.branch && merged?.get(w.branch)?.has(w.head)) return 'a merged PR has exactly this head';
  return null;
}

// When git last wrote to this worktree's own state (checkout, add, commit, reset).
export function lastGitWrite(path) {
  const dir = git(path, ['rev-parse', '--absolute-git-dir']).out;
  let latest = 0;
  for (const f of ['', 'index', 'HEAD', 'logs/HEAD']) { try { latest = Math.max(latest, statSync(join(dir, f)).mtimeMs); } catch { /* absent */ } }
  return latest;
}

export const QUIET_HOURS = 24;

export function inspectWorktrees(root, { base = 'main', cwds = processCwds(), merged = undefined, self = process.cwd(), now = Date.now(), quietHours = QUIET_HOURS, lastWrite = lastGitWrite } = {}) {
  const list = parseWorktrees(git(root, ['worktree', 'list', '--porcelain']).out);
  const prs = merged === undefined ? mergedHeads(root) : merged;
  const here = real(self);
  return list.map((w) => {
    const path = real(w.path);
    const row = { ...w, path };
    if (w.prunable) return { ...row, state: 'gone', why: ['its directory is missing; "git worktree prune" clears the record'] };
    // Measured BEFORE anything below runs, and status must not refresh the index:
    // looking at a worktree must not make it look recently used.
    row.quietHours = Math.max(0, Math.floor((now - lastWrite(path)) / 3_600_000));
    const status = git(path, ['--no-optional-locks', 'status', '--porcelain']);
    row.dirty = status.status !== 0 ? null : status.out ? status.out.split('\n').length : 0;
    row.processes = [...cwds].filter(([pid, dir]) => pid !== process.pid && inside(path, real(dir))).map(([pid]) => pid);
    row.landed = w.main ? null : landedProof(root, w, base, prs);
    const t = Number(git(path, ['log', '-1', '--format=%ct']).out);
    row.ageDays = t ? Math.floor((now / 1000 - t) / 86400) : null;
    const why = [];
    if (w.main) why.push('the main worktree');
    if (inside(path, here)) why.push('this command is running in it');
    if (w.locked) why.push('locked');
    if (!w.main && !row.landed) why.push(`not proven landed in origin/${base}`);
    if (row.dirty === null) why.push('git status failed');
    else if (row.dirty) why.push(`${row.dirty} uncommitted or untracked file(s)`);
    if (!w.main && row.quietHours < quietHours) why.push(`git wrote to it ${row.quietHours}h ago (under ${quietHours}h)`);
    if (row.processes.length) why.push(`${row.processes.length} live process(es) working in it (pid ${row.processes.slice(0, 3).join(', ')})`);
    return { ...row, why, state: why.length ? (w.main ? 'main' : 'keep') : 'removable' };
  });
}

// Remove the removable ones. Each is inspected AGAIN right before it is removed (a
// session may have started in it since the list was made), and `git worktree remove`
// runs without --force, so git refuses too if anything is uncommitted.
export function pruneWorktrees(root, opts = {}) {
  const out = [];
  for (const w of inspectWorktrees(root, opts).filter((x) => x.state === 'removable')) {
    const again = inspectWorktrees(root, { ...opts, cwds: opts.recheckCwds ? opts.recheckCwds() : processCwds() }).find((x) => x.path === w.path);
    if (!again || again.state !== 'removable') { out.push({ path: w.path, removed: false, why: again ? again.why.join('; ') : 'no longer a worktree' }); continue; }
    const r = git(root, ['worktree', 'remove', w.path]);
    out.push({ path: w.path, branch: w.branch, removed: r.status === 0, ...(r.status === 0 ? { proof: w.landed } : { why: r.err }) });
  }
  return out;
}

export function renderWorktrees(rows, base) {
  const w = Math.max(...rows.map((r) => r.path.length));
  const lines = rows.map((r) => {
    const mark = r.state === 'removable' ? '✓' : r.state === 'gone' ? '✗' : ' ';
    const what = r.state === 'removable' ? `removable · ${r.landed}` : r.why.join('; ');
    return `${mark} ${r.path.padEnd(w)}  ${(r.branch ?? (r.detached ? '(detached)' : '')).padEnd(28)} ${r.ageDays === null || r.ageDays === undefined ? '' : `${r.ageDays}d`.padStart(4)}  ${what}`;
  });
  const n = rows.filter((r) => r.state === 'removable').length;
  lines.push(`\n${rows.length} worktree(s) · ${n} removable (landed in origin/${base} as of the last fetch, clean, nothing running in them, untouched for a day)`);
  return lines.join('\n');
}
