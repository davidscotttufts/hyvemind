// The decision queue: what an agent needs from the human, in one place that outlives
// the session that asked.
//
// A question asked inside one session is invisible everywhere else: the human has to
// find the session, and if they don't, the work behind it waits (one such question
// parked a session for 18 hours). Here a question is a file under
// ~/.hyvemind/decisions, so `hyvemind decisions` lists every pending one on the
// machine, oldest first, and the answer is recorded with its note and time.
//
// One file per decision (closed schema, created exclusively, replaced atomically) plus
// an append-only log, decisions.jsonl, of every ask, decide and withdraw. A decided
// record is never changed again: a second answer is refused, not merged.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isObject } from './config.mjs';
import { git } from './git.mjs';
import { home, readJsonStrict, writeAtomic } from './home.mjs';

export const WAITING = 75; // EX_TEMPFAIL: not an error, not an answer yet
const KEYS = ['id', 'askedAt', 'repo', 'worktree', 'branch', 'from', 'question', 'options', 'recommend', 'blocks', 'ref', 'state', 'decision'];
const STATES = ['pending', 'decided', 'withdrawn'];
const str = (v) => typeof v === 'string';
const strOrNull = (v) => v === null || str(v);

function check(d) {
  if (!isObject(d)) return 'expected an object';
  const extra = Object.keys(d).filter((k) => !KEYS.includes(k));
  if (extra.length) return `unknown key(s): ${extra.join(', ')}`;
  const missing = KEYS.filter((k) => !(k in d));
  if (missing.length) return `missing key(s): ${missing.join(', ')}`;
  if (!/^d-\d{8}-[0-9a-f]{4}$/.test(d.id)) return 'id must look like d-YYYYMMDD-xxxx';
  if (!str(d.askedAt) || Number.isNaN(Date.parse(d.askedAt))) return 'askedAt must be a time';
  if (!str(d.question) || !d.question.trim()) return 'question must be a non-empty string';
  if (!Array.isArray(d.options) || !d.options.every((o) => str(o) && o.trim())) return 'options must be an array of non-empty strings';
  for (const k of ['repo', 'worktree', 'branch', 'from', 'recommend', 'blocks']) if (!strOrNull(d[k])) return `${k} must be a string or null`;
  if (d.ref !== null && !isObject(d.ref)) return 'ref must be an object or null';
  if (!STATES.includes(d.state)) return `state must be one of ${STATES.join(', ')}`;
  if (d.state === 'pending' ? d.decision !== null : !(isObject(d.decision) && strOrNull(d.decision.choice) && strOrNull(d.decision.note) && str(d.decision.at))) {
    return d.state === 'pending' ? 'a pending decision cannot carry an answer' : 'decision must be { choice, note, at }';
  }
  return null;
}

const dirOf = (h) => join(h, 'decisions');
const fileOf = (h, id) => join(dirOf(h), `${id}.json`);
const need = (h) => { if (!h) throw new Error('no hyvemind home in a test process; set HYVEMIND_HOME'); return h; };

function log(h, event) {
  mkdirSync(h, { recursive: true });
  appendFileSync(join(h, 'decisions.jsonl'), JSON.stringify(event) + '\n');
}

// Where the question came from, so the list can say which repo and branch is waiting.
export function origin(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return { repo: null, worktree: null, branch: null };
  const main = git(cwd, ['worktree', 'list', '--porcelain']).out.match(/^worktree (.+)$/m)?.[1] ?? top.out;
  return { repo: main, worktree: top.out, branch: git(cwd, ['branch', '--show-current']).out || null };
}

export function ask({ question, options = [], recommend = null, blocks = null, from = null, ref = null, cwd = process.cwd() }, { dir = home(), now = new Date(), notifier = notify } = {}) {
  const h = need(dir);
  if (!str(question) || !question.trim()) throw new Error('a decision needs a question');
  const opts = options.map((o) => o.trim());
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) throw new Error('options must be distinct');
  if (recommend !== null && opts.length && pick(opts, recommend) === null) throw new Error(`--recommend "${recommend}" is not one of the options: ${opts.join(' | ')}`);
  mkdirSync(dirOf(h), { recursive: true });
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const base = { askedAt: now.toISOString(), ...origin(cwd), from, question: question.trim(), options: opts, recommend: recommend !== null && opts.length ? pick(opts, recommend) : recommend, blocks, ref, state: 'pending', decision: null };
  for (let i = 0; i < 20; i++) {
    const d = { id: `d-${day}-${randomBytes(2).toString('hex')}`, ...base };
    let fd;
    try { fd = openSync(fileOf(h, d.id), 'wx'); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    try { writeSync(fd, JSON.stringify(d, null, 2) + '\n'); } finally { closeSync(fd); }
    log(h, { event: 'ask', at: d.askedAt, id: d.id, repo: d.repo, branch: d.branch, from, question: d.question, options: opts, recommend: d.recommend, blocks });
    notifier(d);
    return d;
  }
  throw new Error('could not allocate a decision id');
}

// Every record, oldest first. A file that cannot be read is an error: a decision that
// silently drops out of the list is a question nobody will ever answer.
export function list({ state = 'pending', repo = null } = {}, { dir = home() } = {}) {
  const h = need(dir);
  if (!existsSync(dirOf(h))) return [];
  return readdirSync(dirOf(h)).filter((f) => f.endsWith('.json')).map((f) => readJsonStrict(join(dirOf(h), f), check))
    .filter((d) => (state === 'all' || d.state === state) && (!repo || d.repo === repo))
    .sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id));
}

// By full id or a unique prefix of it ("d-20261123-4f" or just the last 4 characters).
export function get(id, { dir = home() } = {}) {
  const all = list({ state: 'all' }, { dir });
  const hits = all.filter((d) => d.id === id);
  const loose = hits.length ? hits : all.filter((d) => d.id.startsWith(id) || d.id.endsWith(`-${id}`));
  if (loose.length === 1) return loose[0];
  throw new Error(loose.length ? `"${id}" matches ${loose.length} decisions: ${loose.map((d) => d.id).join(', ')}` : `no decision "${id}"`);
}

// An option by exact text (case-insensitive) or by its 1-based number. null when neither.
export function pick(options, choice) {
  const c = String(choice).trim();
  const i = options.findIndex((o) => o.toLowerCase() === c.toLowerCase());
  if (i >= 0) return options[i];
  return /^\d+$/.test(c) && options[Number(c) - 1] !== undefined ? options[Number(c) - 1] : null;
}

function settle(id, state, decision, dir) {
  const h = need(dir);
  const d = get(id, { dir: h });
  if (d.state !== 'pending') throw new Error(`${d.id} is already ${d.state}${d.decision?.choice ? ` ("${d.decision.choice}", ${d.decision.at})` : ''}; a settled decision is not changed. Ask a new one`);
  const next = { ...d, state, decision };
  writeAtomic(fileOf(h, d.id), JSON.stringify(next, null, 2) + '\n');
  log(h, { event: state === 'decided' ? 'decide' : 'withdraw', at: decision.at, id: d.id, choice: decision.choice, note: decision.note });
  return next;
}

export function decide(id, choice, { note = null } = {}, { dir = home(), now = new Date() } = {}) {
  const d = get(id, { dir: need(dir) });
  if (choice === undefined || choice === null || !String(choice).trim()) throw new Error(`usage: hyvemind decide ${d.id} <choice>${d.options.length ? `   (${d.options.map((o, i) => `${i + 1}: ${o}`).join(' | ')})` : ''}`);
  // With options, the answer is one of them: a free-text answer to a closed question
  // leaves the agent to interpret it. Say more in --note.
  const chosen = d.options.length ? pick(d.options, choice) : String(choice).trim();
  if (chosen === null) throw new Error(`"${choice}" is not an option of ${d.id}. Options: ${d.options.map((o, i) => `${i + 1}: ${o}`).join(' | ')}. Add detail with --note`);
  return settle(d.id, 'decided', { choice: chosen, note, at: now.toISOString() }, dir);
}

export function withdraw(id, { note = null } = {}, { dir = home(), now = new Date() } = {}) {
  return settle(id, 'withdrawn', { choice: null, note, at: now.toISOString() }, dir);
}

// Poll until the decision is settled or the time runs out. Returns the record either way.
export async function wait(id, minutes, { dir = home(), everyMs = 2000 } = {}) {
  const until = Date.now() + minutes * 60_000;
  let d = get(id, { dir });
  while (d.state === 'pending' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(everyMs, Math.max(0, until - Date.now()))));
    d = get(d.id, { dir });
  }
  return d;
}

// Tell the human. notify.command (from hyvemind.json, or HYVEMIND_NOTIFY) runs in a
// shell with the decision in environment variables, never spliced into the command
// line. Without one, macOS shows a notification. HYVEMIND_NOTIFY=off silences both.
// A failed notification never fails the ask: the record is already on disk.
export function notify(d, { command = process.env.HYVEMIND_NOTIFY ?? null, platform = process.platform, spawn = spawnSync } = {}) {
  if (command === 'off') return { sent: false, why: 'off' };
  const where = d.repo ? d.repo.split('/').pop() : 'hyvemind';
  if (command) {
    const r = spawn('sh', ['-c', command], { encoding: 'utf8', timeout: 15000, env: { ...process.env, HYVEMIND_DECISION_ID: d.id, HYVEMIND_DECISION_QUESTION: d.question, HYVEMIND_DECISION_REPO: d.repo ?? '', HYVEMIND_DECISION_BLOCKS: d.blocks ?? '', HYVEMIND_DECISION_RECOMMEND: d.recommend ?? '' } });
    return { sent: r.status === 0, via: 'command' };
  }
  if (platform !== 'darwin') return { sent: false, why: 'no notify.command' };
  const r = spawn('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)', '-e', 'end run', '--', d.question.slice(0, 200), `Decision needed · ${where}`, `hyvemind decide ${d.id}`], { encoding: 'utf8', timeout: 15000 });
  return { sent: r.status === 0, via: 'osascript' };
}

const age = (iso, now) => { const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000)); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

export function render(rows, { now = Date.now() } = {}) {
  if (!rows.length) return 'nothing is waiting on you';
  return rows.map((d) => {
    const head = `${d.id}  ${d.state === 'pending' ? `waiting ${age(d.askedAt, now)}` : d.state}  ${d.repo ? d.repo.split('/').pop() : '—'}${d.branch ? ` (${d.branch})` : ''}${d.from ? ` · ${d.from}` : ''}`;
    const lines = [head, `  ${d.question}`];
    if (d.options.length) lines.push(`  options: ${d.options.map((o, i) => `${i + 1}: ${o}${o === d.recommend ? ' (recommended)' : ''}`).join(' | ')}`);
    else if (d.recommend) lines.push(`  recommended: ${d.recommend}`);
    if (d.blocks) lines.push(`  blocks: ${d.blocks}`);
    if (d.decision) lines.push(`  ${d.state}: ${d.decision.choice ?? ''}${d.decision.note ? ` — ${d.decision.note}` : ''} (${d.decision.at})`);
    return lines.join('\n');
  }).join('\n\n') + (rows.some((d) => d.state === 'pending') ? '\n\nanswer with: hyvemind decide <id> <choice or number> [--note "…"]' : '');
}
