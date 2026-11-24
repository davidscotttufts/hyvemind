// The fleet: every repository on this machine that hyvemind is installed in, and how far
// each has drifted. One registry (~/.hyvemind/registry.json), written by init/update and
// by `fleet --scan`. Without it, a stale pin or a hand-copied skill folder is found only
// when someone happens to look.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, STATE_DIR, isObject, pkgVersion, resolveConfig } from './config.mjs';
import { olderThan } from './doctor.mjs';
import { git } from './git.mjs';
import { home, readJsonStrict, writeAtomic } from './home.mjs';
import { installAgentsMd, installSkills, readManifest, renamedSkills, unmanagedCopies } from './install.mjs';

export const REGISTRY = 'registry.json';
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

function check(data) {
  if (!isObject(data)) return 'expected an object';
  const extra = Object.keys(data).filter((k) => !['version', 'repos'].includes(k));
  if (extra.length) return `unknown key(s): ${extra.join(', ')}`;
  if (data.version !== 1) return 'version must be 1';
  if (!isObject(data.repos)) return 'repos must be an object keyed by absolute path';
  for (const [path, r] of Object.entries(data.repos)) {
    if (!path.startsWith('/')) return `repos key "${path}" is not an absolute path`;
    if (!isObject(r)) return `repos["${path}"] must be an object`;
    const bad = Object.keys(r).filter((k) => !['addedAt', 'via'].includes(k));
    if (bad.length) return `repos["${path}"] has unknown key(s): ${bad.join(', ')}`;
    if (!ISO.test(r.addedAt ?? '')) return `repos["${path}"].addedAt must be an ISO time`;
    if (!['init', 'update', 'scan'].includes(r.via)) return `repos["${path}"].via must be init, update or scan`;
  }
  return null;
}

export function readRegistry(dir = home()) {
  if (!dir) return { version: 1, repos: {} };
  const file = join(dir, REGISTRY);
  return existsSync(file) ? readJsonStrict(file, check) : { version: 1, repos: {} };
}

// A repo is registered once, as its MAIN worktree: linked worktrees share its skills
// through git, and counting each would make one repo look like eleven.
export function mainWorktree(root) {
  const r = git(root, ['worktree', 'list', '--porcelain']);
  return r.status === 0 ? r.out.match(/^worktree (.+)$/m)?.[1] ?? null : null;
}

export function worktreeCount(root) {
  const r = git(root, ['worktree', 'list', '--porcelain']);
  return r.status === 0 ? (r.out.match(/^worktree /gm) ?? []).length : 0;
}

// Returns the registered path, or null when there is no home (tests) or no repo.
export function register(root, via, { dir = home(), now = new Date() } = {}) {
  if (!dir) return null;
  const path = mainWorktree(root);
  if (!path) return null;
  const reg = readRegistry(dir);
  if (reg.repos[path]) return path;
  reg.repos[path] = { addedAt: now.toISOString(), via };
  writeAtomic(join(dir, REGISTRY), JSON.stringify(reg, null, 2) + '\n');
  return path;
}

export function forget(path, { dir = home() } = {}) {
  const reg = readRegistry(dir);
  if (!dir || !reg.repos[path]) return false;
  delete reg.repos[path];
  writeAtomic(join(dir, REGISTRY), JSON.stringify(reg, null, 2) + '\n');
  return true;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'vendor']);

// Directories under `start` (to `depth`) that hold a hyvemind.json, a manifest, or
// hand-copied hyvemind skills. Linked worktrees collapse onto their main worktree.
export function scan(start, { depth = 3 } = {}) {
  const found = new Set();
  const walk = (dir, left) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name));
    if (names.has(CONFIG_FILE) || existsSync(join(dir, STATE_DIR, 'manifest.json')) || (names.has('.git') && unmanagedCopies(dir).length)) {
      const main = mainWorktree(dir);
      if (main) found.add(main);
    }
    if (left === 0) return;
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), left - 1);
  };
  walk(start, depth);
  return [...found].sort();
}

// One repo's state, read-only. Every problem is a string in `issues`, so a table and a
// JSON consumer agree on what "needs attention" means.
export function inspect(path) {
  const row = { path, issues: [] };
  if (!existsSync(path)) return { ...row, state: 'missing', issues: ['path no longer exists; "hyvemind fleet forget <path>"'] };
  row.worktrees = worktreeCount(path);
  const copies = unmanagedCopies(path);
  const file = join(path, CONFIG_FILE);
  if (!existsSync(file)) {
    row.state = 'unmanaged';
    row.issues.push(copies.length ? `${copies.length} hand-copied skill folder(s), no ${CONFIG_FILE}; run "hyvemind init" there` : `no ${CONFIG_FILE}`);
    return row;
  }
  let cfg, raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); cfg = resolveConfig(raw); } catch (e) {
    return { ...row, state: 'broken', issues: [e.message.split('\n').slice(0, 2).join(' ')] };
  }
  // No "cli" key means skills call whichever hyvemind installed them, not a pin.
  row.cli = raw.cli === undefined ? 'default' : cfg.cli.match(/hyvemind@(\d+\.\d+\.\d+)/)?.[1] ?? 'unpinned';
  row.installed = readManifest(path).version;
  let plan;
  try { plan = installSkills(path, cfg, { dryRun: true }); } catch (e) { return { ...row, state: 'broken', issues: [e.message] }; }
  const n = (a) => plan.filter((p) => p.action === a).length;
  row.files = { stale: n('write') + n('update') + n('remove'), modified: n('modified') + n('orphan-modified'), foreign: n('foreign') };
  const left = copies.filter((c) => !plan.some((p) => p.rel.startsWith(`${c}/`)));
  if (row.installed === null) row.issues.push('skills not installed');
  else if (olderThan(row.installed, pkgVersion())) row.issues.push(`skills installed by ${row.installed}`);
  if (/^\d/.test(row.cli) && olderThan(row.cli, pkgVersion())) row.issues.push(`cli pinned to ${row.cli}`);
  if (row.files.stale) row.issues.push(`${row.files.stale} file(s) would change on update`);
  if (row.files.modified) row.issues.push(`${row.files.modified} edited locally`);
  if (row.files.foreign) row.issues.push(`${row.files.foreign} name collision(s)`);
  if (left.length) row.issues.push(`${left.length} hand-copied skill folder(s)`);
  const renamed = renamedSkills(cfg);
  if (renamed.length) row.issues.push(`${renamed.length} old skill name(s) in ${CONFIG_FILE}`);
  row.state = row.issues.length ? 'drifted' : 'current';
  return row;
}

export function fleet({ dir = home() } = {}) {
  return Object.keys(readRegistry(dir).repos).sort().map(inspect);
}

// The update plan for every repo with a valid config. Nothing is written unless
// `write` is set: other sessions work in these checkouts, so the default is to show.
export function fleetUpdate({ dir = home(), write = false } = {}) {
  return Object.keys(readRegistry(dir).repos).sort().map((path) => {
    const file = join(path, CONFIG_FILE);
    if (!existsSync(file)) return { path, skipped: existsSync(path) ? `no ${CONFIG_FILE}` : 'missing' };
    try {
      const cfg = resolveConfig(JSON.parse(readFileSync(file, 'utf8')));
      const actions = [...installSkills(path, cfg, { dryRun: !write }), ...installAgentsMd(path, cfg, { dryRun: !write })];
      const counts = {};
      for (const a of actions) if (a.action !== 'same') counts[a.action] = (counts[a.action] ?? 0) + 1;
      return { path, counts, written: write };
    } catch (e) { return { path, skipped: e.message.split('\n')[0] }; }
  });
}

export function renderFleet(rows) {
  if (!rows.length) return 'no repositories registered; run "hyvemind fleet --scan <dir>" or "hyvemind init" in a repo';
  const w = Math.max(...rows.map((r) => r.path.length));
  const lines = rows.map((r) => `${r.state === 'current' ? '✓' : r.state === 'drifted' ? '!' : '✗'} ${r.path.padEnd(w)}  ${(r.state ?? '').padEnd(9)} ${r.installed ? `skills ${r.installed}` : ''}${r.cli ? ` · cli ${r.cli}` : ''}${r.worktrees > 1 ? ` · ${r.worktrees} worktrees` : ''}${r.issues.length ? `\n    ${r.issues.join('; ')}` : ''}`);
  const by = (s) => rows.filter((r) => r.state === s).length;
  lines.push(`\n${rows.length} repo(s) · ${by('current')} current · ${by('drifted')} drifted · ${by('unmanaged')} unmanaged · ${by('broken') + by('missing')} broken or missing · this is hyvemind ${pkgVersion()}`);
  return lines.join('\n');
}
