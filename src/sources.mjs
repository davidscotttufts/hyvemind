// Skill sources: skills that live in another repository, installed through the same
// manifest as the bundled ones.
//
// The skills that carry a team's real workflow are usually its own, and they spread by
// copy-paste: one repo's .claude/skills copied into the next, then kept in step by hand.
// A source names where they come from and pins the exact commit:
//
//   "skills": { "sources": [ { "from": "git@github.com:acme/app.git",
//                              "ref": "<40-hex commit>", "path": ".claude/skills",
//                              "include": ["release-manager", "code-review"] } ] }
//
// The commit is fetched into a cache (~/.hyvemind/cache) and read with `git show`; no
// checkout is made and nothing from the source is executed. Files are copied as they are.
// The pin is a full commit hash, never a branch: what gets installed cannot change
// until the config does.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isObject } from './config.mjs';
import { home } from './home.mjs';

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9][a-z0-9._-]*$/i;

// Problems with skills.sources, as strings (config validation calls this).
export function sourceErrors(sources) {
  if (sources === undefined) return [];
  if (!Array.isArray(sources)) return ['skills.sources must be an array'];
  const errs = [];
  sources.forEach((s, i) => {
    const at = `skills.sources[${i}]`;
    if (!isObject(s)) { errs.push(`${at} must be an object`); return; }
    const extra = Object.keys(s).filter((k) => !['from', 'ref', 'path', 'include', 'prefix'].includes(k));
    if (extra.length) errs.push(`${at} has unknown key(s): ${extra.join(', ')}`);
    if (typeof s.from !== 'string' || !s.from.trim() || s.from.startsWith('-')) errs.push(`${at}.from must be a git URL or a path to a repository`);
    if (!SHA.test(s.ref ?? '')) errs.push(`${at}.ref must be a full 40-character commit hash (a branch or tag can move)`);
    if (s.path !== undefined && (typeof s.path !== 'string' || s.path.startsWith('/') || s.path.split('/').includes('..'))) errs.push(`${at}.path must be a relative path inside the source`);
    if (s.include !== undefined && s.include !== 'all' && !(Array.isArray(s.include) && s.include.every((n) => typeof n === 'string' && NAME.test(n)))) errs.push(`${at}.include must be "all" or a list of skill folder names`);
    if (s.prefix !== undefined && !/^[a-z0-9-]*$/.test(s.prefix)) errs.push(`${at}.prefix must be lowercase letters, digits or "-"`);
  });
  return errs;
}

const run = (args, opts = {}) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return { status: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
};

export const pinRef = (sha) => `refs/hyvemind-pin/${sha}`;

let scratch = null;
export function cacheDir() {
  const h = home();
  if (h) return join(h, 'cache', 'sources');
  scratch ??= mkdtempSync(join(tmpdir(), 'hyve-sources-')); // a test process with no home
  return scratch;
}

// A bare repository holding the pinned commit. Network is used only when the commit is
// not already in the cache.
export function ensureCommit(source, { cache = cacheDir() } = {}) {
  const dir = join(cache, createHash('sha256').update(source.from).digest('hex').slice(0, 16));
  if (!existsSync(join(dir, 'HEAD'))) {
    mkdirSync(dir, { recursive: true });
    const init = run(['init', '-q', '--bare', dir]);
    if (init.status !== 0) throw new Error(`could not create the source cache at ${dir}: ${init.err}`);
  }
  const has = () => run(['--git-dir', dir, 'cat-file', '-e', `${source.ref}^{commit}`]).status === 0;
  if (has()) { run(['--git-dir', dir, 'update-ref', pinRef(source.ref), source.ref]); return dir; }
  // Ask for exactly the pinned commit; a server that refuses a bare hash gets a full fetch.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  let f = run(['--git-dir', dir, 'fetch', '-q', '--depth', '1', '--no-tags', '--', source.from, source.ref], { env });
  if (!has()) f = run(['--git-dir', dir, 'fetch', '-q', '--no-tags', '--', source.from, '+refs/heads/*:refs/hyvemind-source/*'], { env });
  if (!has()) throw new Error(`skill source ${source.from}: commit ${source.ref.slice(0, 12)} could not be fetched (${f.err.split('\n').pop() || 'not found in the source'})`);
  // A named ref keeps the commit from being collected, and lets a clone fetch it by name.
  run(['--git-dir', dir, 'update-ref', pinRef(source.ref), source.ref]);
  return dir;
}

// The skills of one source at its pinned commit: [{ name, files: [{ rel, content }] }].
// A skill is a folder under `path` that contains a SKILL.md.
export function readSource(source, opts = {}) {
  const dir = ensureCommit(source, opts);
  const base = (source.path ?? '.claude/skills').replace(/\/+$/, '');
  const ls = run(['--git-dir', dir, 'ls-tree', '-r', '-z', '--name-only', source.ref, '--', `${base}/`]);
  if (ls.status !== 0) throw new Error(`skill source ${source.from}: cannot list ${base} at ${source.ref.slice(0, 12)}: ${ls.err}`);
  const bySkill = new Map();
  for (const file of ls.out.split('\0').filter(Boolean)) {
    const [name, ...rest] = file.slice(base.length + 1).split('/');
    if (!rest.length) continue;
    if (!bySkill.has(name)) bySkill.set(name, []);
    bySkill.get(name).push({ rel: rest.join('/'), path: file });
  }
  const all = [...bySkill].filter(([, files]) => files.some((f) => f.rel === 'SKILL.md')).map(([name]) => name).sort();
  const want = source.include === undefined || source.include === 'all' ? all : source.include;
  const missing = want.filter((n) => !all.includes(n));
  if (missing.length) throw new Error(`skill source ${source.from}: no skill(s) ${missing.join(', ')} under ${base} at ${source.ref.slice(0, 12)} (found: ${all.join(', ') || 'none'})`);
  return want.map((name) => ({
    name,
    files: bySkill.get(name).map((f) => {
      const show = spawnSync('git', ['--git-dir', dir, 'show', `${source.ref}:${f.path}`], { maxBuffer: 256 * 1024 * 1024 });
      if (show.status !== 0) throw new Error(`skill source ${source.from}: cannot read ${f.path}`);
      return { rel: f.rel, path: f.path, content: show.stdout };
    }),
  }));
}

// Installed name → its files, for every source. The frontmatter name follows a prefix.
export function sourceUnits(cfg, opts = {}) {
  const out = [];
  for (const source of cfg.skills.sources ?? []) {
    const prefix = source.prefix ?? '';
    for (const skill of readSource(source, opts)) {
      out.push({
        dir: `${prefix}${skill.name}`,
        files: skill.files.map((f) => ({
          rel: f.rel,
          content: prefix && f.rel === 'SKILL.md' ? Buffer.from(f.content.toString('utf8').replace(/^name:\s*.*$/m, `name: ${prefix}${skill.name}`)) : f.content,
          origin: { from: source.from, ref: source.ref, path: f.path, ...(prefix ? { prefix } : {}) },
        })),
      });
    }
  }
  return out;
}

// What the source's default branch points at now, for "is my pin behind?". Network.
export function remoteHead(source) {
  const r = run(['ls-remote', '--', source.from, 'HEAD'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30000 });
  const sha = r.out.split(/\s+/)[0];
  return r.status === 0 && SHA.test(sha) ? sha : null;
}
