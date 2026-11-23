import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canon, extract, friction, mine, nudgeKind } from '../src/mine.mjs';
import { write } from './helpers.mjs';

const cmd = (s) => `{"type":"user","message":"<command-name>/${s}</command-name>"}`;
const tool = (s) => `{"type":"tool_use","name":"Skill","input":{"skill":"${s}"}}`;

test('extract: one slash command per line counts; compaction summaries listing many do not', () => {
  assert.deepEqual(extract(cmd('review')), [{ source: 'user', skill: 'review' }]);
  assert.deepEqual(extract(`${cmd('a')} ${cmd('b')}`), []);
  assert.deepEqual(extract(tool('pr')), [{ source: 'agent', skill: 'pr' }]);
  assert.equal(canon('frontend-design:frontend-design'), 'frontend-design');
  assert.equal(canon('acme-review', 'acme-'), 'review');
});

test('mine counts skills and chains with confidence, splitting on reset skills', () => {
  const root = mkdtempSync(join(tmpdir(), 'hyve-mine-'));
  const session = (...lines) => lines.join('\n') + '\n';
  write(root, {
    '-Users-me-dev-app/s1.jsonl': session(cmd('plan'), tool('acme-review'), cmd('pr')),
    '-Users-me-dev-app/s2.jsonl': session(cmd('plan'), cmd('review'), cmd('clear'), cmd('pr')),
    '-Users-me-dev-other/s3.jsonl': session(cmd('plan'), cmd('review')),
  });
  const r = mine({ root, filter: '-Users-me-dev-app', prefix: 'acme-' });
  assert.equal(r.sessions, 2);
  assert.deepEqual(Object.fromEntries(r.top), { plan: 2, pr: 2, review: 2, clear: 1 });
  const byChain = Object.fromEntries(r.bigrams.map((b) => [b.chain, b]));
  assert.equal(byChain['plan -> review'].count, 2);
  assert.equal(byChain['plan -> review'].confidence, 1);
  assert.equal(byChain['review -> pr'].count, 1, 'clear splits the s2 chain');
  assert.deepEqual(r.trigrams, [['plan -> review -> pr', 1]]);
  assert.equal(mine({ root }).sessions, 3);
});

test('confidence counts only runs of A that were followed by a skill; renamed skills merge', () => {
  const root = mkdtempSync(join(tmpdir(), 'hyve-mine2-'));
  const session = (...lines) => lines.join('\n') + '\n';
  // review runs 4 times: twice followed by pr, twice at the very end of a session.
  write(root, {
    'p/s1.jsonl': session(cmd('review'), cmd('pr')),
    'p/s2.jsonl': session(cmd('review'), cmd('pr')),
    'p/s3.jsonl': session(cmd('review')),
    'p/s4.jsonl': session(tool('bee-review'), cmd('clear')),
    'p/s5.jsonl': session(cmd('old-plan'), cmd('ship')),
  });
  const r = mine({ root, aliases: { 'old-plan': 'plan-tasks' } });
  const c = Object.fromEntries(r.bigrams.map((b) => [b.chain, b.confidence]));
  assert.equal(c['review -> pr'], 1, 'review was followed by something twice, both times pr');
  assert.ok(!('bee-review' in Object.fromEntries(r.top)), 'bee-review merged');
  assert.equal(Object.fromEntries(r.top)['review-change'], 1);
  assert.ok('plan-tasks -> ship' in c, 'project alias applied');
});

test('friction counts only what a human typed, inside the window, and what agents did', () => {
  const root = mkdtempSync(join(tmpdir(), 'hyve-friction-'));
  const now = Date.parse('2026-11-20T00:00:00Z');
  const at = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString();
  const user = (content, extra = {}) => JSON.stringify({ type: 'user', timestamp: at(1), origin: { kind: 'human' }, message: { content }, ...extra });
  const use = (name, input, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use', name, input }] }, ...extra });
  write(root, {
    'p/s1.jsonl': [
      user('keep going'), user('What is the status?'), user('proceed with your recommendations'),
      user('rename the export to fooBar and update its callers'),
      user('keep going', { origin: { kind: 'peer' } }),          // a teammate's relay is not the human
      user('proceed', { isMeta: true }),                          // injected, not typed
      user('a relayed prompt with no mark', { origin: undefined }), // unmarked line in a marked file
      user('keep going', { timestamp: at(45) }),                  // outside the window
      user('<command-name>/grade-code</command-name>'),
      user([{ type: 'tool_result', content: 'continue' }]),
      use('AskUserQuestion', { questions: [] }),
      use('Skill', { skill: 'bee-review' }),
      use('Bash', { command: 'git worktree add ../w1 -b x && git -C ../w1 status' }),
      use('Bash', { command: 'git worktree add ../w2; git worktree remove ../w1' }),
      use('Bash', { command: 'echo "docs mention worktree add"' }),
      use('AskUserQuestion', {}, { timestamp: at(45) }),
    ].join('\n') + '\n',
    // No origin marks anywhere: an older transcript, whose plain user lines are the human's.
    'p/old.jsonl': [JSON.stringify({ type: 'user', timestamp: at(2), message: { content: 'resume' } }), JSON.stringify({ type: 'user', timestamp: at(2), message: { content: 'add a test for the parser' } })].join('\n') + '\n',
  });
  const f = friction({ root, days: 30, now });
  assert.equal(f.typed, 6, 'four marked human lines + two legacy lines');
  assert.deepEqual(f.nudges, { continue: 3, status: 1, total: 4 });
  assert.equal(f.nudgeShare, 0.67);
  assert.equal(f.asks, 1, 'the question outside the window is not counted');
  assert.deepEqual(f.worktrees, { added: 2, removed: 1 }, 'an echo that mentions the words is not a worktree command');
  assert.deepEqual(Object.fromEntries(f.skills), { 'grade-code': 1, 'review-change': 1 });
  assert.equal(friction({ root, days: 60, now }).nudges.total, 5, 'a wider window includes the older nudge');
});

test('nudgeKind: only short messages that say nothing but "go on" or "status?"', () => {
  assert.equal(nudgeKind('proceed'), 'continue');
  assert.equal(nudgeKind('ok, keep going'), 'continue');
  assert.equal(nudgeKind("what's next?"), 'status');
  assert.equal(nudgeKind('proceed with your recommendations'), 'continue');
  assert.equal(nudgeKind('proceed, but first move the parser into its own module'), null, 'a message that goes on to direct work is not a nudge');
  assert.equal(nudgeKind('status of the deploy script is wrong, fix line 3'), null);
  assert.equal(nudgeKind('rename the function'), null);
});
