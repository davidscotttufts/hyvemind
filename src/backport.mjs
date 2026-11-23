// Backport: offer a local edit to a sourced skill back to the repository it came from.
//
// A skill installed from a source gets improved where it is used. Without a way back,
// the improvement stays in one repo and the copies drift. The manifest already knows the
// exact commit each file was installed from, so the edit can be put on a branch that
// starts at that commit: the pull request then shows this change and nothing else, and
// git reports a real conflict if the source has moved on in the same lines.
//
// Nothing is pushed unless asked. The source is never written to directly: the branch is
// built in a throwaway clone, and it reaches the source only as a pull request.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readManifest } from './install.mjs';
import { ensureCommit, pinRef } from './sources.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const git = (cwd, args, env = {}) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
const must = (cwd, args) => { const r = git(cwd, args); if (r.status !== 0) throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${r.err}`); return r.out; };

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((e) => { const p = join(dir, e); return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1)]; });
}

// The local edits to one installed skill: files that differ from what was installed, and
// files added beside them. Read from the first skills target that has the skill.
export function localEdits(root, cfg, skill) {
  const manifest = readManifest(root);
  for (const target of cfg.skills.targets) {
    const folder = join(target, skill);
    const tracked = Object.entries(manifest.sources ?? {}).filter(([rel]) => rel.startsWith(`${folder}/`));
    if (!tracked.length) continue;
    const origin = tracked[0][1];
    const srcFolder = dirname(tracked.find(([rel]) => rel === join(folder, 'SKILL.md'))?.[1].path ?? tracked[0][1].path);
    const edits = [];
    for (const [rel, o] of tracked) {
      const abs = join(root, rel);
      if (!existsSync(abs)) { edits.push({ rel, path: o.path, change: 'removed' }); continue; }
      if (sha(readFileSync(abs)) !== manifest.files[rel]) edits.push({ rel, path: o.path, change: 'modified' });
    }
    const known = new Set(tracked.map(([rel]) => rel));
    for (const f of existsSync(join(root, folder)) ? walk(join(root, folder)) : []) {
      const rel = join(folder, f);
      if (!known.has(rel)) edits.push({ rel, path: `${srcFolder}/${f}`, change: 'added' });
    }
    // Every tracked file must share one base commit, or there is no single branch point.
    const refs = new Set(tracked.map(([, o]) => o.ref));
    if (refs.size > 1) throw new Error(`${skill} has files installed from different commits (${[...refs].map((r) => r.slice(0, 12)).join(', ')}); run "hyvemind update" first`);
    return { skill, folder, origin, edits };
  }
  throw new Error(`"${skill}" was not installed from a skill source in this repo (see skills.sources in hyvemind.json)`);
}

// Build the branch in a throwaway clone: start at the installed commit, apply the edits.
// Returns { dir, branch, base, files, stat, patch } without touching the source.
export function prepareBackport(root, cfg, skill, { now = new Date() } = {}) {
  const e = localEdits(root, cfg, skill);
  if (!e.edits.length) return { ...e, nothing: true };
  const cache = ensureCommit(e.origin);
  const dir = mkdtempSync(join(tmpdir(), 'hyve-backport-'));
  must(dir, ['init', '-q']);
  must(dir, ['fetch', '-q', '--no-tags', cache, pinRef(e.origin.ref)]);
  const consumer = basename(root);
  const id = sha(e.edits.map((x) => `${x.change}:${x.path}:${existsSync(join(root, x.rel)) ? sha(readFileSync(join(root, x.rel))) : '-'}`).join('\n')).slice(0, 8);
  const branch = `backport/${skill}-from-${consumer}-${id}`.replace(/[^A-Za-z0-9._/-]+/g, '-');
  must(dir, ['checkout', '-q', '-b', branch, e.origin.ref]);
  for (const x of e.edits) {
    const dest = join(dir, x.path);
    if (x.change === 'removed') { must(dir, ['rm', '-q', '--', x.path]); continue; }
    let content = readFileSync(join(root, x.rel));
    // A prefix was added to the name on install; the source has the plain name.
    if (e.origin.prefix && x.rel.endsWith('/SKILL.md')) content = Buffer.from(content.toString('utf8').replace(/^name:\s*(.*)$/m, (m, n) => `name: ${n.startsWith(e.origin.prefix) ? n.slice(e.origin.prefix.length) : n}`));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    must(dir, ['add', '--', x.path]);
  }
  if (git(dir, ['diff', '--cached', '--quiet']).status === 0) return { ...e, nothing: true };
  const author = { GIT_AUTHOR_NAME: git(root, ['config', 'user.name']).out || 'hyvemind', GIT_AUTHOR_EMAIL: git(root, ['config', 'user.email']).out || 'hyvemind@localhost' };
  const c = git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `${skill}: backport edits made in ${consumer}`, '-m', `Based on ${e.origin.ref}, the commit ${consumer} installed this skill from.\n${now.toISOString().slice(0, 10)} · hyvemind backport`], { ...author, GIT_COMMITTER_NAME: author.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: author.GIT_AUTHOR_EMAIL });
  if (c.status !== 0) throw new Error(`could not commit the backport: ${c.err}`);
  return { ...e, dir, branch, base: e.origin.ref, consumer, stat: must(dir, ['diff', '--stat', `${e.origin.ref}..HEAD`]), patch: must(dir, ['diff', `${e.origin.ref}..HEAD`]) };
}

export function githubSlug(url) {
  const m = String(url).match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Push the prepared branch to the source and open a pull request against its default
// branch. `open` is the PR-creating step, replaceable in tests.
export function pushBackport(prepared, { open = openPr } = {}) {
  const push = git(prepared.dir, ['push', '-q', '--', prepared.origin.from, `${prepared.branch}:refs/heads/${prepared.branch}`]);
  if (push.status !== 0) throw new Error(`could not push ${prepared.branch} to ${prepared.origin.from}: ${push.err}`);
  return { pushed: true, branch: prepared.branch, pr: open(prepared) };
}

function openPr(prepared) {
  const slug = githubSlug(prepared.origin.from);
  if (!slug) return { opened: false, why: `${prepared.origin.from} is not a GitHub repository; the branch ${prepared.branch} is pushed, open the request yourself` };
  const body = `Edits made to \`${prepared.skill}\` in \`${prepared.consumer}\`, offered back.\n\nBased on \`${prepared.base}\`, the commit that repository installed the skill from, so this diff is only the local change.\n\n\`\`\`\n${prepared.stat}\n\`\`\`\n\nOpened by \`hyvemind backport\`.`;
  const r = spawnSync('gh', ['pr', 'create', '--repo', slug, '--head', prepared.branch, '--title', `${prepared.skill}: backport edits from ${prepared.consumer}`, '--body', body], { cwd: prepared.dir, encoding: 'utf8' });
  return r.status === 0 ? { opened: true, url: r.stdout.trim().split('\n').pop() } : { opened: false, why: (r.stderr || r.stdout).trim().slice(0, 300) };
}
