import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { resolveRoles, runPlan } from '../src/run.mjs';
import { parseAgentOutput, renderUsage, sumUsage } from '../src/usage.mjs';
import { repo } from './helpers.mjs';

// The shape Claude Code prints with --output-format json (fields verified 2026-11-23).
const claudeJson = (result, cost, model, extra = {}) => JSON.stringify({
  type: 'result', result, total_cost_usd: cost, num_turns: 1, duration_ms: 700, is_error: false,
  usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 },
  modelUsage: { [model]: { costUSD: cost } }, ...extra,
});

test('parseAgentOutput: a JSON result gives text and usage; plain text gives text and "not reported"', () => {
  const p = parseAgentOutput(`${claudeJson('VERDICT: GO', 0.0123, 'claude-sonnet-5-5')}\n`);
  assert.equal(p.text, 'VERDICT: GO');
  assert.deepEqual(p.usage, { costUSD: 0.0123, inputTokens: 2, outputTokens: 4, cacheReadTokens: 100, cacheWriteTokens: 10, models: ['claude-sonnet-5-5'], turns: 1, durationMs: 700 });
  assert.deepEqual(parseAgentOutput('looks fine\nVERDICT: GO'), { text: 'looks fine\nVERDICT: GO', usage: null });
  assert.deepEqual(parseAgentOutput('{"not":"an agent result"}'), { text: '{"not":"an agent result"}', usage: null }, 'JSON that is not a result is just text');
  assert.equal(parseAgentOutput('{ broken').usage, null);
  assert.equal(parseAgentOutput(JSON.stringify({ result: 'x' })).usage, null, 'a result with no cost or tokens is not reported, not zero');
  assert.equal(parseAgentOutput(claudeJson('boom', 0.001, 'm', { is_error: true })).usage.error, true);
});

test('sumUsage: a call with no usage makes the total a floor, and the summary says so', () => {
  const a = parseAgentOutput(claudeJson('x', 0.01, 'opus')).usage;
  const b = parseAgentOutput(claudeJson('y', 0.02, 'haiku')).usage;
  const all = sumUsage([a, b]);
  assert.equal(all.costUSD, 0.03);
  assert.deepEqual(all.models, ['haiku', 'opus']);
  assert.match(renderUsage(all), /^2 agent call\(s\) · \$0\.0300 · 224 tokens in \(200 from cache\) · 8 out · haiku, opus$/);
  const partial = sumUsage([a, null]);
  assert.equal(partial.unreported, 1);
  assert.match(renderUsage(partial), /at least \$0\.0100 .* 1 call\(s\) did not report usage/);
  assert.equal(renderUsage(sumUsage([null, null])), '2 agent call(s) · cost and tokens not reported by this agent');
  assert.equal(renderUsage(sumUsage([])), 'no agent calls');
});

test('resolveRoles: built-in roles get the model, effort and JSON output; a custom command must take {model} to be given one', () => {
  const builtin = { agent: ['claude', '-p', '{prompt}'], reviewer: ['claude', '-p', '{prompt}'] };
  const r = resolveRoles(resolveConfig({ version: 1, run: { roles: { implementer: { model: 'opus', effort: 'high' }, reviewer: { model: 'sonnet' } } } }), builtin);
  assert.deepEqual(r.agent.command, ['claude', '-p', '{prompt}', '--output-format', 'json', '--model', '{model}', '--effort', '{effort}']);
  assert.deepEqual(r.reviewer.command, ['claude', '-p', '{prompt}', '--output-format', 'json', '--model', '{model}']);
  assert.deepEqual(resolveRoles(resolveConfig({ version: 1 }), builtin).agent.command, ['claude', '-p', '{prompt}', '--output-format', 'json']);
  const custom = (run) => resolveRoles(resolveConfig({ version: 1, run }), builtin);
  assert.throws(() => custom({ agent: ['codex', 'exec', '{prompt}'], roles: { implementer: { model: 'gpt' } } }), /run\.roles\.implementer\.model is set, but run\.agent has no \{model\}/);
  assert.deepEqual(custom({ agent: ['codex', 'exec', '-m', '{model}', '{prompt}'], roles: { implementer: { model: 'gpt' } } }).agent.command, ['codex', 'exec', '-m', '{model}', '{prompt}'], 'a custom command is used as written');
  assert.throws(() => custom({ roles: { planner: { model: 'x' } } }), /unknown role\(s\): planner/);
  assert.throws(() => custom({ roles: { reviewer: { model: '' } } }), /run\.roles\.reviewer\.model must be a non-empty string/);
});

test('run records each role\'s model and what every agent call cost; a bad role stops before anything runs', () => {
  const plan = 'T1 — Create the greeting\n  Files: greet.txt\n  Exit check: `grep -q hello greet.txt`\n';
  // Fake agents that print a Claude-style JSON result and echo the model they were given.
  const IMPLEMENT = `require('fs').writeFileSync('greet.txt','hello\\n');console.log(JSON.stringify({result:'done',total_cost_usd:0.02,usage:{input_tokens:5,output_tokens:7},modelUsage:{[process.argv[2]]:{}}}))`;
  const REVIEW = `console.log(JSON.stringify({result:'REQ: says hello | met: yes | evidence: greet.txt\\nVERDICT: GO',total_cost_usd:0.005,usage:{input_tokens:3,output_tokens:2},modelUsage:{[process.argv[2]]:{}}}))`;
  const root = repo({ '.gitignore': '.hyve/\n', 'plan.md': plan });
  const dir = join(mkdtempSync(join(tmpdir(), 'hyve-usage-')), 'wt');
  const cfg = resolveConfig({ version: 1, run: {
    agent: ['node', '-e', IMPLEMENT, '{prompt}', '{model}'], reviewer: ['node', '-e', REVIEW, '{prompt}', '{model}'],
    roles: { implementer: { model: 'big-model' }, reviewer: { model: 'small-model' } },
  } });
  const { report, file } = runPlan(root, cfg, 'plan.md', { dir, decisions: null });
  assert.equal(report.tasks[0].status, 'done', 'the verdict is read from the JSON result text');
  assert.deepEqual(report.roles, { implementer: { model: 'big-model' }, reviewer: { model: 'small-model' } });
  assert.deepEqual(report.tasks[0].attempts[0].usage.models, ['big-model']);
  assert.deepEqual(report.tasks[0].reviewUsage.models, ['small-model']);
  assert.equal(report.usage.costUSD, 0.025);
  assert.deepEqual([report.usage.calls, report.usage.unreported, report.usage.inputTokens, report.usage.outputTokens], [2, 0, 8, 9]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).usage.costUSD, 0.025, 'the record is in the saved report');

  const dir2 = join(mkdtempSync(join(tmpdir(), 'hyve-usage-')), 'wt');
  const bad = resolveConfig({ version: 1, run: { agent: ['node', '-e', IMPLEMENT, '{prompt}'], roles: { implementer: { model: 'big-model' } } } });
  assert.throws(() => runPlan(root, bad, 'plan.md', { dir: dir2, decisions: null }), /has no \{model\}/);
  assert.ok(!existsSync(dir2), 'refused before a worktree was made or an agent started');
});
