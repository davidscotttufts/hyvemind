import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.mjs';
import { decide, list } from '../src/decisions.mjs';
import { runGates } from '../src/gate.mjs';
import { approval, globToRegExp, matcher, protectedChanges } from '../src/protect.mjs';
import { checkEvidence } from '../src/status.mjs';
import { repo, sh, write } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/hyvemind.mjs', import.meta.url));
const quiet = { notifier: () => {} };
const raw = (protect) => ({ version: 1, gates: [{ name: 't', run: 'node test/a.test.js' }], protect, skills: { targets: ['.claude/skills'] }, agentsMd: { paths: [] } });
// A repo whose base is the local branch "base" (no remote needed).
function project(protect) {
  const dir = repo({ '.gitignore': '.hyve/\n', 'src/a.js': 'module.exports = 1;\n', 'test/a.test.js': "if (require('../src/a.js') !== 1) process.exit(1);\n", 'scripts/ci.sh': 'node test/a.test.js\n', 'hyvemind.json': JSON.stringify(raw(protect)) });
  sh(dir, 'git', ['branch', 'base']);
  sh(dir, 'git', ['checkout', '-q', '-b', 'work']);
  return dir;
}
const P = { paths: ['test/**', 'scripts/ci.sh'], base: 'base' };
const cfgOf = (dir) => resolveConfig(JSON.parse(readFileSync(join(dir, 'hyvemind.json'), 'utf8')));
const commit = (dir, msg) => { sh(dir, 'git', ['add', '-A']); sh(dir, 'git', ['commit', '-q', '-m', msg]); };

test('globs: ** crosses directories, * stays inside one; hyvemind.json is protected whenever anything is', () => {
  assert.ok(globToRegExp('test/**').test('test/a/b.test.js'));
  assert.ok(globToRegExp('**/*.test.ts').test('x/y/a.test.ts') && globToRegExp('**/*.test.ts').test('a.test.ts'));
  assert.ok(!globToRegExp('scripts/*.sh').test('scripts/x/ci.sh'));
  assert.ok(!globToRegExp('scripts/ci.sh').test('scripts/ciXsh'), 'a dot is a dot');
  const m = matcher(resolveConfig(raw({ paths: ['test/**'] })));
  assert.ok(m('hyvemind.json') && m('test/a.test.js') && !m('src/a.js'));
  assert.equal(matcher(resolveConfig(raw({ paths: [] }))), null, 'no paths: off');
});

test('protectedChanges lists edits, deletions, untracked additions and newly skipped tests since the base', () => {
  const dir = project(P);
  assert.deepEqual(protectedChanges(dir, cfgOf(dir)).changed, []);
  write(dir, { 'src/a.js': 'module.exports = 2;\n', 'test/a.test.js': "test.skip('a', () => {});\n", 'test/new.test.js': "it.skip('later', () => {});\n" });
  rmSync(join(dir, 'scripts/ci.sh'));
  const p = protectedChanges(dir, cfgOf(dir));
  assert.deepEqual(p.changed, [{ path: 'scripts/ci.sh', change: 'removed' }, { path: 'test/a.test.js', change: 'modified' }, { path: 'test/new.test.js', change: 'added' }], 'src/a.js is not protected');
  assert.deepEqual(p.skips.map((s) => s.path).sort(), ['test/a.test.js', 'test/new.test.js']);
  assert.match(protectedChanges(dir, cfgOf(dir), { base: 'no-such-ref' }).note, /cannot compare with no-such-ref/);
});

test('a green gate reached by editing the test says so; the record carries what changed', async () => {
  const dir = project(P);
  write(dir, { 'src/a.js': 'module.exports = 2;\n', 'test/a.test.js': 'process.exit(0);\n' }); // "fix" by gutting the test
  commit(dir, 'make it pass');
  const { record } = await runGates(dir, cfgOf(dir), { quiet: true });
  assert.equal(record.verdict, 'green');
  assert.deepEqual(record.protected.changed, [{ path: 'test/a.test.js', change: 'modified' }]);
  const e = checkEvidence(dir, cfgOf(dir), { decisions: null });
  assert.equal(e.ok, true, 'without protect.require the evidence stands');
  assert.match(e.message, /! gate changed: 1 protected file\(s\) changed since base: test\/a\.test\.js \(modified\)/);
});

test('protect.require "decision": green is not proof until the human approves exactly these changes', async () => {
  const dir = project({ ...P, require: 'decision' });
  const decisions = mkdtempSync(join(tmpdir(), 'hyve-prot-dec-'));
  write(dir, { 'test/a.test.js': 'process.exit(0);\n' });
  commit(dir, 'gut the test');
  await runGates(dir, cfgOf(dir), { quiet: true });

  const looked = checkEvidence(dir, cfgOf(dir), { decisions, file: false });
  assert.equal(looked.ok, false);
  assert.equal(list({}, { dir: decisions }).length, 0, 'a read-only look (status) files nothing');

  const first = checkEvidence(dir, cfgOf(dir), { decisions, ...quiet });
  assert.equal(first.ok, false);
  assert.equal(first.waiting, true);
  const [d] = list({}, { dir: decisions });
  assert.match(d.question, /Approve changes to what decides "done"/);
  assert.match(first.message, new RegExp(`hyvemind decide ${d.id} approve\\|reject \\(question filed\\)`));
  checkEvidence(dir, cfgOf(dir), { decisions, ...quiet });
  assert.equal(list({ state: 'all' }, { dir: decisions }).length, 1, 'asking again does not file a second question');
  assert.equal(checkEvidence(dir, cfgOf(dir), { decisions: null }).ok, false, 'no queue to ask in is a refusal, not a pass');

  decide(d.id, 'approve', { note: 'the old test checked a removed field' }, { dir: decisions });
  const ok = checkEvidence(dir, cfgOf(dir), { decisions, ...quiet });
  assert.equal(ok.ok, true);
  assert.match(ok.message, /gate change approved by the human/);

  // One more edit to a protected file is a different change: the approval does not cover it.
  write(dir, { 'scripts/ci.sh': 'true\n' });
  commit(dir, 'and the ci script');
  await runGates(dir, cfgOf(dir), { quiet: true });
  const again = approval(dir, cfgOf(dir), { decisions, ...quiet });
  assert.equal(again.state, 'pending');
  assert.notEqual(again.id, d.id);
  decide(again.id, 'reject', {}, { dir: decisions });
  const no = checkEvidence(dir, cfgOf(dir), { decisions, ...quiet });
  assert.equal(no.ok, false);
  assert.match(no.message, /the human rejected these gate changes/);
});

test('CLI: evidence exits 75 while a gate change waits for approval, and 0 once approved', () => {
  const dir = project({ ...P, require: 'decision' });
  const env = { ...process.env, HYVEMIND_HOME: mkdtempSync(join(tmpdir(), 'hyve-prot-home-')), HYVEMIND_NOTIFY: 'off' };
  const run = (...args) => spawnSync('node', [BIN, ...args], { cwd: dir, encoding: 'utf8', env });
  write(dir, { 'test/a.test.js': 'process.exit(0);\n' });
  commit(dir, 'gut the test');
  assert.equal(run('gate', '--quiet').status, 0);
  const ev = run('evidence');
  assert.equal(ev.status, 75, ev.stdout + ev.stderr);
  assert.match(ev.stdout, /not proven yet · the gate is green, but 1 protected file/);
  const id = ev.stdout.match(/decide (d-\d{8}-[0-9a-f]{4})/)[1];
  assert.equal(run('decide', id, 'approve').status, 0);
  assert.equal(run('evidence').status, 0);

});
