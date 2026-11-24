// Protected paths: the machinery that decides whether work passed (gate scripts, CI
// config, hyvemind.json, tests). An agent must not be able to quietly edit what grades
// its own work, so a change to any of them is never silent:
//   - `run` fails an attempt that touches one outside the task's declared Files
//   - `gate` records which ones changed since the base, and evidence says so
//   - with protect.require "decision", evidence is refused until the human approves
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE } from './config.mjs';
import { ask, list as listDecisions, origin } from './decisions.mjs';
import { git } from './git.mjs';
import { home } from './home.mjs';

// Globs: ** any depth, * within a segment, ? one character. Anchored to the repo root.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// hyvemind.json is always protected once anything is: it holds the protect list itself.
export function matcher(cfg) {
  const paths = cfg.protect?.paths ?? [];
  if (!paths.length) return null;
  const res = [...paths, CONFIG_FILE].map(globToRegExp);
  return (file) => res.some((r) => r.test(file));
}

// path → content hash, for every protected file present (tracked or not).
export function snapshot(root, isProtected, except = []) {
  const out = new Map();
  if (!isProtected) return out;
  const skip = new Set(except);
  const files = git(root, ['ls-files', '-co', '--exclude-standard', '-z']).out.split('\0').filter(Boolean);
  for (const f of files) {
    if (!isProtected(f) || skip.has(f) || !existsSync(join(root, f))) continue;
    out.set(f, createHash('sha256').update(readFileSync(join(root, f))).digest('hex'));
  }
  return out;
}

// What differs between two snapshots: [{ path, change: added | removed | modified }].
export function violations(before, after) {
  const out = [];
  for (const [p, h] of after) if (!before.has(p)) out.push({ path: p, change: 'added' }); else if (before.get(p) !== h) out.push({ path: p, change: 'modified' });
  for (const p of before.keys()) if (!after.has(p)) out.push({ path: p, change: 'removed' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const SKIP = /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\(|#\[ignore\]/;

// Protected files that differ between the merge base and the working tree, plus lines
// in them that newly skip a test. base: a ref such as origin/main.
export function protectedChanges(root, cfg, { base = null } = {}) {
  const isProtected = matcher(cfg);
  if (!isProtected) return null;
  const ref = base ?? cfg.protect?.base ?? `origin/${cfg.train?.base ?? 'main'}`;
  const mb = git(root, ['merge-base', ref, 'HEAD']);
  if (mb.status !== 0) return { base: ref, mergeBase: null, changed: [], skips: [], note: `cannot compare with ${ref} (no such ref, or no common history)` };
  const changed = [];
  for (const line of git(root, ['diff', '--name-status', '--no-renames', mb.out]).out.split('\n').filter(Boolean)) {
    const [status, path] = line.split('\t');
    if (isProtected(path)) changed.push({ path, change: status === 'A' ? 'added' : status === 'D' ? 'removed' : 'modified' });
  }
  for (const path of git(root, ['ls-files', '-o', '--exclude-standard']).out.split('\n').filter(Boolean)) if (isProtected(path)) changed.push({ path, change: 'added' });
  changed.sort((a, b) => a.path.localeCompare(b.path));
  const skips = [];
  const paths = changed.filter((c) => c.change === 'modified').map((c) => c.path);
  if (paths.length) {
    let file = null;
    for (const line of git(root, ['diff', '-U0', mb.out, '--', ...paths]).out.split('\n')) {
      if (line.startsWith('+++ b/')) file = line.slice(6);
      else if (line.startsWith('+') && !line.startsWith('+++') && SKIP.test(line)) skips.push({ path: file, line: line.slice(1).trim().slice(0, 120) });
    }
  }
  for (const c of changed.filter((x) => x.change === 'added')) {
    try { for (const l of readFileSync(join(root, c.path), 'utf8').split('\n')) if (SKIP.test(l)) skips.push({ path: c.path, line: l.trim().slice(0, 120) }); } catch { /* binary or gone */ }
  }
  return { base: ref, mergeBase: mb.out, changed, skips };
}

// Identifies one exact set of protected changes, so an approval covers these and no others.
export function fingerprint(root, p) {
  const h = createHash('sha256');
  for (const c of p.changed) {
    const abs = join(root, c.path);
    h.update(`${c.change}\0${c.path}\0${existsSync(abs) ? createHash('sha256').update(readFileSync(abs)).digest('hex') : '-'}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

export function describe(p) {
  if (!p || !p.changed.length) return '';
  const removed = p.changed.filter((c) => c.change === 'removed').length;
  return `${p.changed.length} protected file(s) changed since ${p.base}: ${p.changed.slice(0, 6).map((c) => `${c.path} (${c.change})`).join(', ')}${p.changed.length > 6 ? ', …' : ''}${removed ? ` · ${removed} removed` : ''}${p.skips.length ? ` · ${p.skips.length} newly skipped test(s)` : ''}`;
}

// Does the human's approval cover the protected changes as they are right now?
//   none        nothing protected changed (or protect is off)
//   noted       changed, and protect.require is null: evidence says so and stays green
//   approved | rejected | pending   with protect.require "decision"
//   unavailable require is "decision" but there is no decision queue to ask in
// An approval is tied to the fingerprint of the exact changes: one more edit to a
// protected file is a different fingerprint, and needs its own answer. With `file`,
// a missing question is filed; otherwise it is only reported.
export function approval(root, cfg, { decisions = home(), file = true, notifier = undefined } = {}) {
  const p = cfg ? protectedChanges(root, cfg) : null;
  if (!p) return { state: 'none' };
  if (!p.changed.length) return { state: 'none', protected: p, ...(p.note ? { note: p.note } : {}) };
  const note = describe(p);
  if (cfg.protect.require !== 'decision') return { state: 'noted', protected: p, note };
  if (!decisions) return { state: 'unavailable', protected: p, note };
  const fp = fingerprint(root, p);
  const repo = origin(root).repo;
  const prior = listDecisions({ state: 'all' }, { dir: decisions }).filter((d) => d.ref?.kind === 'protect' && d.ref.repo === repo && d.ref.fingerprint === fp && d.state !== 'withdrawn').at(-1);
  if (prior?.state === 'decided') return { state: prior.decision.choice === 'approve' ? 'approved' : 'rejected', id: prior.id, protected: p, note };
  if (prior) return { state: 'pending', id: prior.id, protected: p, note };
  if (!file) return { state: 'pending', id: null, protected: p, note };
  const d = ask({
    question: `Approve changes to what decides "done" in ${repo?.split('/').pop() ?? 'this repo'}? ${note}`,
    options: ['approve', 'reject'], blocks: 'evidence for this tree (hyvemind evidence)', from: 'hyvemind evidence',
    ref: { kind: 'protect', repo, fingerprint: fp, files: p.changed.map((c) => c.path) }, cwd: root,
  }, { dir: decisions, ...(notifier ? { notifier } : {}) });
  return { state: 'pending', id: d.id, filed: true, protected: p, note };
}
