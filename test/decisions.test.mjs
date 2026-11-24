import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WAITING, ask, decide, get, list, notify, pick, render, wait, withdraw } from '../src/decisions.mjs';
import { repo, sh } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/hyvemind.mjs', import.meta.url));
const freshHome = () => mkdtempSync(join(tmpdir(), 'hyve-dec-home-'));
const quiet = { notifier: () => {} };
const T = (s) => new Date(`2026-11-23T${s}Z`);

test('ask files a pending record with where it came from, and the list is oldest first across repos', () => {
  const dir = freshHome();
  const a = repo(), b = repo();
  sh(a, 'git', ['checkout', '-q', '-b', 'feat/x']);
  const second = ask({ question: 'Ship the export as CSV or JSON?', options: ['CSV', 'JSON'], recommend: 'json', blocks: 'T3 of the export plan', from: 'session-14', cwd: b }, { dir, now: T('10:05:00'), ...quiet });
  const first = ask({ question: 'May I drop the legacy table?', cwd: a }, { dir, now: T('10:00:00'), ...quiet });
  assert.match(first.id, /^d-20261123-[0-9a-f]{4}$/);
  assert.equal(first.repo, realpathSync(a));
  assert.equal(first.branch, 'feat/x');
  assert.equal(second.recommend, 'JSON', 'the recommendation is stored as the option it names');
  assert.deepEqual(list({}, { dir }).map((d) => d.id), [first.id, second.id]);
  assert.deepEqual(list({ repo: realpathSync(b) }, { dir }).map((d) => d.id), [second.id]);
  const text = render(list({}, { dir }), { now: T('12:05:00').getTime() });
  assert.match(text, /waiting 2h {2}.*\(feat\/x\)/);
  assert.match(text, /options: 1: CSV \| 2: JSON \(recommended\)/);
  assert.match(text, /blocks: T3 of the export plan/);
  assert.equal(render([]), 'nothing is waiting on you');
  assert.throws(() => ask({ question: ' ' }, { dir, ...quiet }), /needs a question/);
  assert.throws(() => ask({ question: 'q', options: ['a', 'A'] }, { dir, ...quiet }), /distinct/);
  assert.throws(() => ask({ question: 'q', options: ['a', 'b'], recommend: 'c' }, { dir, ...quiet }), /not one of the options/);
});

test('decide takes an option by text or number, refuses anything else, and a settled decision never changes', () => {
  const dir = freshHome();
  const d = ask({ question: 'Which region?', options: ['us-east', 'eu-west'], cwd: repo() }, { dir, ...quiet });
  assert.equal(pick(['us-east', 'eu-west'], '2'), 'eu-west');
  assert.throws(() => decide(d.id, 'asia', {}, { dir }), /"asia" is not an option .* 1: us-east \| 2: eu-west/);
  assert.throws(() => decide(d.id, '', {}, { dir }), /usage: hyvemind decide/);
  assert.equal(get(d.id, { dir }).state, 'pending', 'a refused answer changes nothing');
  const done = decide(d.id.slice(-4), '2', { note: 'data residency' }, { dir, now: T('11:00:00') });
  assert.deepEqual(done.decision, { choice: 'eu-west', note: 'data residency', at: '2026-11-23T11:00:00.000Z' });
  assert.throws(() => decide(d.id, '1', {}, { dir }), /already decided \("eu-west"/, 'the first answer stands');
  assert.throws(() => withdraw(d.id, {}, { dir }), /already decided/);
  assert.equal(get(d.id, { dir }).decision.choice, 'eu-west');
  assert.deepEqual(list({}, { dir }), [], 'a decided one is no longer waiting');
  assert.equal(list({ state: 'all' }, { dir }).length, 1);

  const open = ask({ question: 'Name for the flag?', cwd: repo() }, { dir, ...quiet });
  assert.equal(decide(open.id, 'fast-export', {}, { dir }).decision.choice, 'fast-export', 'no options: the answer is free text');
  const gone = ask({ question: 'Still needed?', cwd: repo() }, { dir, ...quiet });
  assert.equal(withdraw(gone.id, { note: 'solved another way' }, { dir }).state, 'withdrawn');
  assert.throws(() => get('nope', { dir }), /no decision "nope"/);

  const events = readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event);
  assert.deepEqual(events, ['ask', 'decide', 'ask', 'decide', 'ask', 'withdraw'], 'every ask and answer is in the append-only log');
});

test('a record that cannot be read is an error, never a shorter list', () => {
  const dir = freshHome();
  const d = ask({ question: 'q?', cwd: repo() }, { dir, ...quiet });
  const file = join(dir, 'decisions', `${d.id}.json`);
  writeFileSync(file, JSON.stringify({ ...d, surprise: 1 }));
  assert.throws(() => list({}, { dir }), /unknown key\(s\): surprise/);
  writeFileSync(file, JSON.stringify({ ...d, decision: { choice: 'x', note: null, at: 'now' } }));
  assert.throws(() => list({}, { dir }), /a pending decision cannot carry an answer/);
  writeFileSync(file, '{');
  assert.throws(() => list({}, { dir }), /is not valid JSON/);
});

test('notify passes the question through the environment, never the command line, and can be turned off', () => {
  const calls = [];
  const spawnFake = (cmd, args, opts) => { calls.push({ cmd, args, env: opts.env }); return { status: 0 }; };
  const d = { id: 'd-20261123-abcd', question: 'Drop it? $(rm -rf ~) `id`', repo: '/x/app', blocks: null, recommend: null };
  assert.deepEqual(notify(d, { command: 'off', spawn: spawnFake }), { sent: false, why: 'off' });
  assert.equal(calls.length, 0);
  notify(d, { command: 'curl -d "$HYVEMIND_DECISION_QUESTION" https://example.invalid', spawn: spawnFake });
  assert.deepEqual(calls[0].args, ['-c', 'curl -d "$HYVEMIND_DECISION_QUESTION" https://example.invalid'], 'the command is run as written');
  assert.equal(calls[0].env.HYVEMIND_DECISION_QUESTION, d.question);
  assert.equal(calls[0].env.HYVEMIND_DECISION_ID, d.id);
  notify(d, { command: null, platform: 'darwin', spawn: spawnFake });
  assert.equal(calls[1].cmd, 'osascript');
  assert.ok(!calls[1].args.slice(0, 6).join(' ').includes('rm -rf'), 'the question is an argument to the script, not part of it');
  assert.equal(calls[1].args.at(-3), d.question);
  assert.deepEqual(notify(d, { command: null, platform: 'linux', spawn: spawnFake }), { sent: false, why: 'no notify.command' });
});

test('wait returns the answer when it arrives and the pending record when time runs out', async () => {
  const dir = freshHome();
  const d = ask({ question: 'go?', options: ['yes', 'no'], cwd: repo() }, { dir, ...quiet });
  assert.equal((await wait(d.id, 0.001, { dir, everyMs: 10 })).state, 'pending');
  setTimeout(() => decide(d.id, 'yes', {}, { dir }), 60);
  const got = await wait(d.id, 1, { dir, everyMs: 20 });
  assert.equal(got.decision.choice, 'yes');
});

test('CLI: a question filed in one process is answered from another, and the asker then reads the answer', () => {
  const dir = freshHome();
  const a = repo();
  const env = { ...process.env, HYVEMIND_HOME: dir, HYVEMIND_NOTIFY: 'off' };
  const run = (cwd, ...args) => spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8', env });

  const filed = run(a, 'ask', 'Cut the release now?', '--option', 'now', '--option', 'after the fix', '--recommend', 'after the fix', '--blocks', 'v1.2.0');
  assert.equal(filed.status, 0, filed.stderr);
  const id = filed.stdout.match(/filed (d-\d{8}-[0-9a-f]{4})/)[1];
  assert.equal(readdirSync(join(dir, 'decisions')).length, 1, 'the record survives the process that asked');

  const elsewhere = repo();
  const pending = run(elsewhere, 'decisions');
  assert.match(pending.stdout, /Cut the release now\?/);
  assert.match(pending.stdout, /2: after the fix \(recommended\)/);
  assert.equal(run(elsewhere, 'decisions', '--here').stdout.trim(), 'nothing is waiting on you');
  assert.equal(run(a, 'decisions', '--for', id).status, WAITING, 'pending is exit 75, not success and not an error');
  assert.equal(run(a, 'ask', 'x', '--wait', '0.001').status, WAITING);

  const id2 = JSON.parse(run(a, 'ask', 'Second?', '--option', 'a', '--option', 'b', '--json').stdout).id;
  const bad = run(elsewhere, 'decide', id2, 'c');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not an option/);
  assert.equal(run(elsewhere, 'decide', id, '2', '--note', 'wait for #12').status, 0);
  const after = run(a, 'decisions', '--for', id);
  assert.equal(after.status, 0);
  assert.match(after.stdout, /decided: after the fix — wait for #12/);
  assert.ok(existsSync(join(dir, 'decisions.jsonl')));
});
