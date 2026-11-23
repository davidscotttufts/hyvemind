// `hyvemind status`: one screen for "where do things stand?" across every registered
// repository, so the answer does not depend on asking each session in turn.
//   - what is waiting on the human (the decision queue, whole machine)
//   - per repo: install drift, worktrees (busy, unsaved, removable), whether the main
//     checkout's current tree has green evidence, and with --prs the open pull requests
// Read-only. Network is used only with `prs`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, resolveConfig } from './config.mjs';
import { list as listDecisions } from './decisions.mjs';
import { inspect, readRegistry } from './fleet.mjs';
import { home } from './home.mjs';
import { checkEvidence } from './status.mjs';
import { inspectWorktrees, processCwds } from './worktrees.mjs';

export function openPrs(root, { gh = 'gh' } = {}) {
  const r = spawnSync(gh, ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,isDraft,headRefName,statusCheckRollup'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout).map((p) => {
      const states = (p.statusCheckRollup ?? []).map((c) => (c.conclusion || c.state || c.status || '').toUpperCase());
      const checks = states.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(s)) ? 'red' : states.some((s) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'].includes(s)) ? 'pending' : states.length ? 'green' : 'none';
      return { number: p.number, title: p.title, draft: p.isDraft, branch: p.headRefName, checks };
    });
  } catch { return null; }
}

export function overview({ dir = home(), prs = false, cwds = processCwds(), base = 'main', evidence = (path, cfg) => checkEvidence(path, cfg, { file: false }), pullRequests = openPrs } = {}) {
  const pending = listDecisions({}, { dir });
  const repos = Object.keys(readRegistry(dir).repos).sort().map((path) => {
    const fleet = inspect(path);
    const row = { path, install: fleet.state, installIssues: fleet.issues, decisions: pending.filter((d) => d.repo === path).length };
    if (fleet.state === 'missing') return row;
    try {
      const wts = inspectWorktrees(path, { cwds, merged: null, base });
      row.worktrees = { total: wts.length, busy: wts.filter((w) => w.processes?.length).length, unsaved: wts.filter((w) => w.dirty).length, removable: wts.filter((w) => w.state === 'removable').length };
    } catch (e) { row.worktrees = { error: e.message }; }
    const file = join(path, CONFIG_FILE);
    if (existsSync(file)) {
      try {
        const cfg = resolveConfig(JSON.parse(readFileSync(file, 'utf8')));
        // A project whose proof is a commit status needs the network to read it.
        if (cfg.evidence?.status && !prs) row.evidence = { ok: null, message: `proof is the commit status "${cfg.evidence.status}" (shown with --prs)` };
        else { const e = evidence(path, cfg); row.evidence = { ok: e.ok, message: e.message }; }
      } catch (e) { row.evidence = { ok: null, message: e.message.split('\n')[0] }; }
    }
    if (prs) row.prs = pullRequests(path);
    return row;
  });
  return { pending, repos };
}

const name = (p) => p.split('/').slice(-2).join('/');

export function renderOverview(o, { now = Date.now() } = {}) {
  const lines = [];
  const age = (iso) => { const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000)); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
  lines.push(o.pending.length ? `WAITING ON YOU (${o.pending.length})` : 'Nothing is waiting on you.');
  for (const d of o.pending) lines.push(`  ${d.id}  ${age(d.askedAt).padStart(4)}  ${d.repo ? name(d.repo) : '—'}  ${d.question.slice(0, 110)}${d.recommend ? `  [recommended: ${d.recommend}]` : ''}`);
  if (o.pending.length) lines.push('  answer: hyvemind decide <id> <choice>   detail: hyvemind decisions');
  lines.push('', o.repos.length ? 'REPOSITORIES' : 'No repositories registered; run "hyvemind fleet --scan <dir>".');
  for (const r of o.repos) {
    lines.push(`  ${r.path}`);
    lines.push(`    install    ${r.install}${r.installIssues.length ? ` · ${r.installIssues.join('; ')}` : ''}`);
    if (r.worktrees) lines.push(r.worktrees.error ? `    worktrees  ${r.worktrees.error}` : `    worktrees  ${r.worktrees.total} · ${r.worktrees.busy} with a live process · ${r.worktrees.unsaved} with unsaved files · ${r.worktrees.removable} removable`);
    if (r.evidence) lines.push(`    evidence   ${r.evidence.ok === true ? '✓' : r.evidence.ok === false ? '✗' : '·'} ${r.evidence.message}`);
    if (r.prs === null) lines.push('    PRs        could not be read (gh)');
    else if (r.prs) {
      const n = (c) => r.prs.filter((p) => p.checks === c).length;
      lines.push(`    PRs        ${r.prs.length} open · ${n('red')} red · ${n('pending')} pending · ${n('green')} green · ${r.prs.filter((p) => p.draft).length} draft`);
      for (const p of r.prs.filter((x) => x.checks === 'red').slice(0, 5)) lines.push(`                 red: #${p.number} ${p.title.slice(0, 80)}`);
    }
    if (r.decisions) lines.push(`    decisions  ${r.decisions} pending`);
  }
  return lines.join('\n');
}
