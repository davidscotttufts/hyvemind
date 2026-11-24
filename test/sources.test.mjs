import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubSlug, localEdits, prepareBackport, pushBackport } from '../src/backport.mjs';
import { resolveConfig } from '../src/config.mjs';
import { installSkills, readManifest } from '../src/install.mjs';
import { readSource, sourceErrors } from '../src/sources.mjs';
import { repo, sh, write } from './helpers.mjs';

const SKILL = (name, body) => `---\nname: ${name}\ndescription: "${name} for the team"\n---\n\n${body}\n`;
// A "template" repository with two skills, published to a bare remote that stands in
// for GitHub. Returns { work, remote, v1 } where v1 is the first commit.
function template() {
  const work = repo({
    '.claude/skills/code-review/SKILL.md': SKILL('code-review', 'Review for defects.'),
    '.claude/skills/code-review/checklist.md': '- tests\n',
    '.claude/skills/release-manager/SKILL.md': SKILL('release-manager', 'Coordinate releases.'),
    '.claude/skills/notes/README.md': 'not a skill: no SKILL.md\n',
  });
  const remote = join(mkdtempSync(join(tmpdir(), 'hyve-src-remote-')), 'template.git');
  sh(work, 'git', ['init', '-q', '--bare', remote]);
  sh(work, 'git', ['remote', 'add', 'origin', remote]);
  sh(work, 'git', ['push', '-q', 'origin', 'main']);
  return { work, remote, v1: sh(work, 'git', ['rev-parse', 'HEAD']) };
}
const publish = (t, files, msg) => { write(t.work, files); sh(t.work, 'git', ['add', '-A']); sh(t.work, 'git', ['commit', '-q', '-m', msg]); sh(t.work, 'git', ['push', '-q', 'origin', 'main']); return sh(t.work, 'git', ['rev-parse', 'HEAD']); };
const cfg = (sources, extra = {}) => resolveConfig({ version: 1, gates: [{ name: 't', run: 'true' }], skills: { include: ['open-pr'], targets: ['.claude/skills'], sources, ...extra } });

test('skills.sources is validated: a pin must be a full commit hash, never a branch', () => {
  const ok = { from: 'git@github.com:acme/app.git', ref: 'a'.repeat(40) };
  assert.deepEqual(sourceErrors([ok]), []);
  assert.match(sourceErrors([{ ...ok, ref: 'main' }])[0], /ref must be a full 40-character commit hash/);
  assert.match(sourceErrors([{ ...ok, ref: 'abc1234' }])[0], /full 40-character/);
  assert.match(sourceErrors([{ ...ok, path: '../elsewhere' }])[0], /path must be a relative path inside the source/);
  assert.match(sourceErrors([{ ...ok, from: '--upload-pack=evil' }])[0], /from must be a git URL/);
  assert.match(sourceErrors([{ ...ok, branch: 'main' }])[0], /unknown key\(s\): branch/);
  assert.throws(() => cfg([{ from: 'x', ref: 'main' }]), /skills\.sources\[0\]\.ref must be a full/);
});

test('a source installs its skills at the pinned commit, beside the bundled ones, through the same manifest', () => {
  const t = template();
  const dir = repo();
  const c = cfg([{ from: t.remote, ref: t.v1, include: ['code-review'] }]);
  assert.deepEqual(readSource({ from: t.remote, ref: t.v1 }).map((s) => s.name), ['code-review', 'release-manager'], 'a folder without SKILL.md is not a skill');
  installSkills(dir, c);
  assert.equal(readFileSync(join(dir, '.claude/skills/code-review/SKILL.md'), 'utf8'), SKILL('code-review', 'Review for defects.'));
  assert.ok(existsSync(join(dir, '.claude/skills/code-review/checklist.md')));
  assert.ok(existsSync(join(dir, '.claude/skills/open-pr/SKILL.md')), 'bundled skills still install');
  assert.ok(!existsSync(join(dir, '.claude/skills/release-manager')), 'only what include names');
  const m = readManifest(dir);
  assert.deepEqual(m.sources['.claude/skills/code-review/SKILL.md'], { from: t.remote, ref: t.v1, path: '.claude/skills/code-review/SKILL.md' });
  assert.equal(m.sources['.claude/skills/open-pr/SKILL.md'], undefined);

  // The source moves on. Nothing changes here until the pin does.
  const v2 = publish(t, { '.claude/skills/code-review/SKILL.md': SKILL('code-review', 'Review for defects that matter.') }, 'tighten');
  assert.ok(installSkills(dir, c, { dryRun: true }).every((a) => a.action === 'same'), 'same pin, same files');
  const bumped = cfg([{ from: t.remote, ref: v2, include: ['code-review'] }]);
  assert.equal(installSkills(dir, bumped).find((a) => a.rel === '.claude/skills/code-review/SKILL.md').action, 'update');
  assert.match(readFileSync(join(dir, '.claude/skills/code-review/SKILL.md'), 'utf8'), /defects that matter/);

  assert.throws(() => installSkills(dir, cfg([{ from: t.remote, ref: v2, include: ['nope'] }])), /no skill\(s\) nope under \.claude\/skills/);
  assert.throws(() => installSkills(dir, cfg([{ from: t.remote, ref: 'f'.repeat(40) }])), /could not be fetched/);
  const clash = repo({ '.claude/skills/open-pr/SKILL.md': SKILL('open-pr', 'theirs') });
  const cr = join(mkdtempSync(join(tmpdir(), 'hyve-src-remote-')), 'c.git');
  sh(clash, 'git', ['init', '-q', '--bare', cr]); sh(clash, 'git', ['push', '-q', cr, 'main']);
  const clashCfg = cfg([{ from: cr, ref: sh(clash, 'git', ['rev-parse', 'HEAD']) }]);
  assert.throws(() => installSkills(dir, clashCfg), /skill "open-pr" comes from two places/);
  const prefixed = cfg([{ from: cr, ref: sh(clash, 'git', ['rev-parse', 'HEAD']), prefix: 'their-' }]);
  installSkills(repo(), prefixed);
});

test('a local edit to a sourced skill survives an update and keeps the commit it started from', () => {
  const t = template();
  const dir = repo();
  installSkills(dir, cfg([{ from: t.remote, ref: t.v1, include: ['code-review'] }]));
  const file = join(dir, '.claude/skills/code-review/SKILL.md');
  writeFileSync(file, readFileSync(file, 'utf8') + '\nAlso check migrations.\n');
  const v2 = publish(t, { '.claude/skills/code-review/checklist.md': '- tests\n- docs\n' }, 'more');
  const plan = installSkills(dir, cfg([{ from: t.remote, ref: v2, include: ['code-review'] }]));
  assert.equal(plan.find((a) => a.rel.endsWith('code-review/SKILL.md')).action, 'modified');
  assert.match(readFileSync(file, 'utf8'), /Also check migrations/, 'the edit is kept');
  const m = readManifest(dir);
  assert.equal(m.sources['.claude/skills/code-review/SKILL.md'].ref, t.v1, 'the edited file still names the commit its edit is based on');
  assert.equal(m.sources['.claude/skills/code-review/checklist.md'].ref, v2, 'the untouched file moved to the new pin');
});

test('backport puts the local edit on a branch that starts at the installed commit, and pushes only when asked', () => {
  const t = template();
  const dir = repo();
  const c = cfg([{ from: t.remote, ref: t.v1, include: ['code-review', 'release-manager'] }]);
  installSkills(dir, c);
  assert.equal(prepareBackport(dir, c, 'code-review').nothing, true, 'no edits: nothing to offer');
  assert.throws(() => localEdits(dir, c, 'open-pr'), /was not installed from a skill source/);

  const file = join(dir, '.claude/skills/code-review/SKILL.md');
  writeFileSync(file, readFileSync(file, 'utf8') + '\nAlso check migrations.\n');
  write(dir, { '.claude/skills/code-review/examples.md': 'an example\n' });
  // The source moves on meanwhile, in a different file.
  publish(t, { '.claude/skills/release-manager/SKILL.md': SKILL('release-manager', 'Coordinate releases carefully.') }, 'other work');

  const p = prepareBackport(dir, c, 'code-review');
  assert.deepEqual(p.edits.map((e) => [e.change, e.path]).sort(), [['added', '.claude/skills/code-review/examples.md'], ['modified', '.claude/skills/code-review/SKILL.md']]);
  assert.equal(p.base, t.v1);
  assert.equal(sh(p.dir, 'git', ['rev-parse', 'HEAD~1']), t.v1, 'the branch starts at the commit the skill was installed from');
  assert.match(p.patch, /\+Also check migrations\./);
  assert.doesNotMatch(p.patch, /carefully/, 'the diff is only the local change, not the source\'s later work');
  assert.match(p.branch, /^backport\/code-review-from-/);
  assert.equal(sh(t.work, 'git', ['ls-remote', '--heads', t.remote]).includes('backport/'), false, 'preparing pushes nothing');

  const opened = [];
  const out = pushBackport(p, { open: (x) => { opened.push(x.branch); return { opened: true, url: 'https://example.invalid/pr/1' }; } });
  assert.equal(out.pushed, true);
  assert.deepEqual(opened, [p.branch]);
  const heads = sh(t.work, 'git', ['ls-remote', '--heads', t.remote]);
  assert.ok(heads.includes(`refs/heads/${p.branch}`), 'the branch is in the source');
  // main in the source is untouched: the edit arrives only as a branch for a pull request.
  sh(t.work, 'git', ['fetch', '-q', 'origin']);
  assert.doesNotMatch(sh(t.work, 'git', ['show', 'origin/main:.claude/skills/code-review/SKILL.md']), /migrations/);
  assert.equal(sh(t.work, 'git', ['merge-base', '--is-ancestor', t.v1, `origin/${p.branch}`]), '');
});

test('a prefixed install is un-prefixed on the way back; githubSlug reads ssh and https remotes', () => {
  const t = template();
  const dir = repo();
  const c = cfg([{ from: t.remote, ref: t.v1, include: ['code-review'], prefix: 'acme-' }]);
  installSkills(dir, c);
  const file = join(dir, '.claude/skills/acme-code-review/SKILL.md');
  assert.match(readFileSync(file, 'utf8'), /^name: acme-code-review$/m);
  writeFileSync(file, readFileSync(file, 'utf8') + '\nOne more rule.\n');
  const p = prepareBackport(dir, c, 'acme-code-review');
  assert.match(p.patch, /\+One more rule\./);
  assert.doesNotMatch(p.patch, /acme-code-review/, 'the source keeps its own name');
  assert.equal(githubSlug('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(githubSlug('https://github.com/acme/app'), 'acme/app');
  assert.equal(githubSlug('/tmp/local.git'), null);
});
