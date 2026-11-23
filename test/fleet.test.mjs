import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleet, fleetUpdate, forget, inspect, mainWorktree, readRegistry, register, scan } from '../src/fleet.mjs';
import { home } from '../src/home.mjs';
import { repo, sh, write } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/hyvemind.mjs', import.meta.url));
const freshHome = () => mkdtempSync(join(tmpdir(), 'hyve-fleet-home-'));
const real = (p) => realpathSync(p);
const config = (dir, extra = {}) => writeFileSync(join(dir, 'hyvemind.json'), JSON.stringify({ version: 1, gates: [{ name: 't', run: 'true' }], skills: { include: ['open-pr'], targets: ['.claude/skills'] }, agentsMd: { paths: [] }, ...extra }));

test('a test process has no home unless one is set, so it can never write to the real one', () => {
  assert.equal(home({ NODE_TEST_CONTEXT: 'child-v8' }), null);
  assert.equal(home({ NODE_TEST_CONTEXT: 'child-v8', HYVEMIND_HOME: '/x' }), '/x');
  assert.match(home({}), /\.hyvemind$/);
  assert.equal(register(repo(), 'init', { dir: null }), null);
});

test('register records a repo once, as its main worktree, and forget removes it', () => {
  const dir = freshHome();
  const a = repo();
  const wt = join(dirname(a), `${a.split('/').pop()}-wt`);
  sh(a, 'git', ['worktree', 'add', '-q', wt, '-b', 'side']);
  assert.equal(register(wt, 'init', { dir }), real(a), 'a linked worktree registers its main worktree');
  register(a, 'update', { dir });
  const reg = readRegistry(dir);
  assert.deepEqual(Object.keys(reg.repos), [real(a)]);
  assert.equal(reg.repos[real(a)].via, 'init', 'the first registration is kept');
  assert.equal(mainWorktree(wt), real(a));
  assert.equal(forget(real(a), { dir }), true);
  assert.equal(forget(real(a), { dir }), false);
  assert.deepEqual(readRegistry(dir).repos, {});
});

test('a malformed registry is an error, never an empty fleet', () => {
  const dir = freshHome();
  const file = join(dir, 'registry.json');
  writeFileSync(file, '{ not json');
  assert.throws(() => readRegistry(dir), /is not valid JSON/);
  writeFileSync(file, JSON.stringify({ version: 1, repos: {}, extra: true }));
  assert.throws(() => readRegistry(dir), /unknown key\(s\): extra/);
  writeFileSync(file, JSON.stringify({ version: 1, repos: { '/a': { addedAt: 'yesterday', via: 'init' } } }));
  assert.throws(() => readRegistry(dir), /addedAt must be an ISO time/);
  assert.throws(() => register(repo(), 'init', { dir }), /malformed/, 'a bad registry is not overwritten');
});

test('inspect names each kind of drift: current, stale pin, edited, hand-copied, unmanaged, broken, missing', () => {
  const ok = repo(); config(ok);
  const dir = freshHome();
  register(ok, 'init', { dir });
  fleetUpdate({ dir, write: true });
  assert.deepEqual(inspect(real(ok)).issues, []);
  assert.equal(inspect(real(ok)).state, 'current');

  const skill = join(ok, '.claude/skills/open-pr/SKILL.md');
  writeFileSync(skill, readFileSync(skill, 'utf8') + '\nlocal rule\n');
  write(ok, { '.claude/skills/bee-evidence/SKILL.md': '---\nname: bee-evidence\n---\n' });
  config(ok, { cli: 'npx -y hyvemind@0.2.0', skills: { include: ['pr'], targets: ['.claude/skills'] } });
  const drifted = inspect(real(ok));
  assert.equal(drifted.state, 'drifted');
  assert.deepEqual(drifted.issues, ['cli pinned to 0.2.0', '1 edited locally', '1 hand-copied skill folder(s)', '1 old skill name(s) in hyvemind.json']);

  const copied = repo({ '.claude/skills/bee-pr/SKILL.md': '---\nname: bee-pr\n---\n' });
  assert.equal(inspect(real(copied)).state, 'unmanaged');
  assert.match(inspect(real(copied)).issues[0], /1 hand-copied skill folder\(s\), no hyvemind\.json/);

  const broken = repo(); writeFileSync(join(broken, 'hyvemind.json'), JSON.stringify({ version: 1, skills: { include: ['never-existed'] } }));
  assert.equal(inspect(real(broken)).state, 'broken');
  assert.match(inspect(real(broken)).issues[0], /unknown skills: never-existed/);

  const gone = repo(); rmSync(gone, { recursive: true });
  assert.equal(inspect(gone).state, 'missing');
});

test('scan finds configured repos and hand-copied ones, collapses worktrees, skips node_modules', () => {
  const base = mkdtempSync(join(tmpdir(), 'hyve-scan-'));
  const mk = (name, files) => { const d = join(base, name); write(d, { 'README.md': 'x\n', ...files }); sh(d, 'git', ['init', '-q', '-b', 'main']); sh(d, 'git', ['add', '-A']); sh(d, 'git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']); return d; };
  const a = mk('a', { 'hyvemind.json': '{"version":1}' });
  const b = mk('b', { '.claude/skills/bee-evidence/SKILL.md': '---\nname: bee-evidence\n---\n' });
  mk('plain', { 'src/x.js': '' });
  mk('c', { 'node_modules/dep/hyvemind.json': '{"version":1}' });
  sh(a, 'git', ['worktree', 'add', '-q', join(base, 'a-wt'), '-b', 'side']);
  assert.deepEqual(scan(base), [real(a), real(b)]);
});

test('fleet update shows by default and writes only with write; the CLI registers on init', () => {
  const dir = freshHome();
  const a = repo(); config(a);
  register(a, 'scan', { dir });
  const shown = fleetUpdate({ dir });
  assert.deepEqual(shown, [{ path: real(a), counts: { write: 1 }, written: false }]);
  assert.ok(!existsSync(join(a, '.claude/skills/open-pr/SKILL.md')), 'showing the plan writes nothing');
  fleetUpdate({ dir, write: true });
  assert.ok(existsSync(join(a, '.claude/skills/open-pr/SKILL.md')));
  assert.equal(fleet({ dir })[0].state, 'current');

  const b = repo({ 'package.json': '{"name":"b","scripts":{"test":"true"}}' });
  const env = { ...process.env, HYVEMIND_HOME: dir };
  assert.equal(spawnSync('node', [BIN, 'init', '--dry-run'], { cwd: b, encoding: 'utf8', env }).status, 0);
  assert.equal(Object.keys(readRegistry(dir).repos).length, 1, 'a dry run registers nothing');
  assert.equal(spawnSync('node', [BIN, 'init'], { cwd: b, encoding: 'utf8', env }).status, 0);
  assert.deepEqual(Object.keys(readRegistry(dir).repos).sort(), [real(a), real(b)].sort());
  const out = spawnSync('node', [BIN, 'fleet'], { cwd: b, encoding: 'utf8', env }).stdout;
  assert.match(out, /2 repo\(s\) · 2 current · 0 drifted/);
});
