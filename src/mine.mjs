// Mine Claude Code transcripts for how skills are actually used and chained.
// Port of openwop-app's skill-miner/mine.sh to dependency-free Node.
//
// Detection, per JSONL line (file order is chronological):
//   - a user slash command: exactly one <command-name>/foo</command-name> on the line
//     (lines listing several are compaction summaries and are skipped)
//   - an agent Skill tool call: "name":"Skill","input":{"skill":"foo"
// Chains split on reset skills, so polling and message-bus noise doesn't fuse unrelated work.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { BUILTIN_ALIASES } from './aliases.mjs';

export const DEFAULT_RESET = ['clear', 'crosstalk', 'loop', 'model', 'compact'];

// Renamed skills count as one. hyvemind's own renames are built in (src/aliases.mjs); a
// project adds its own with mine.aliases (old name → current name).
export { BUILTIN_ALIASES };

export function canon(name, prefix = '', aliases = {}) {
  let s = name.replace(/^\//, '').replace(/:.*$/, '');
  s = aliases[s] ?? BUILTIN_ALIASES[s] ?? s;
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  return s;
}

export function extract(line) {
  const out = [];
  const cmds = [...line.matchAll(/<command-name>\/?([^<\s]+)[^<]*<\/command-name>/g)];
  if (cmds.length === 1) out.push({ source: 'user', skill: cmds[0][1] });
  for (const m of line.matchAll(/"name":"Skill","input":\{"skill":"([^"]+)"/g)) out.push({ source: 'agent', skill: m[1] });
  return out;
}

function* jsonlFiles(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* jsonlFiles(p);
    else if (e.endsWith('.jsonl')) yield { path: p, mtime: st.mtimeMs };
  }
}

const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const ranked = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

export function mine({ root = join(homedir(), '.claude/projects'), filter = '', prefix = '', reset = DEFAULT_RESET, top = 20, aliases = {} } = {}) {
  const freq = new Map(), bigrams = new Map(), trigrams = new Map(), outgoing = new Map();
  const sessions = [];
  let invocations = 0;
  for (const f of jsonlFiles(root)) {
    const project = basename(join(f.path, '..'));
    if (filter && !project.includes(filter)) continue;
    const seq = [];
    for (const line of readFileSync(f.path, 'utf8').split('\n')) {
      for (const inv of extract(line)) { seq.push(canon(inv.skill, prefix, aliases)); invocations++; }
    }
    if (!seq.length) continue;
    sessions.push({ project, session: basename(f.path, '.jsonl'), mtime: f.mtime, seq });
    let p1 = null, p2 = null;
    for (const s of seq) {
      bump(freq, s);
      if (reset.includes(s)) { p1 = p2 = null; continue; }
      if (p2 && p2 !== s) { bump(bigrams, `${p2} -> ${s}`); bump(outgoing, p2); }
      if (p1 && p2 && p2 !== s && p1 !== p2) bump(trigrams, `${p1} -> ${p2} -> ${s}`);
      p1 = p2; p2 = s;
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  // Confidence of A -> B: of the times A was followed by another skill, how often that
  // skill was B. Runs of A that ended a session or hit a reset followed by nothing, so
  // they don't count against B.
  const confidence = ranked(bigrams, top).map(([k, n]) => {
    const a = k.split(' -> ')[0];
    return { chain: k, count: n, confidence: +(n / (outgoing.get(a) ?? n)).toFixed(2) };
  });
  return {
    root, filter: filter || null, sessions: sessions.length, invocations,
    top: ranked(freq, top), bigrams: confidence, trigrams: ranked(trigrams, top),
    recent: sessions.slice(0, 10).map((s) => ({ project: s.project, seq: s.seq.join(' > ') })),
  };
}

// ── friction: what the human had to do by hand ──
// The baseline a workflow change is judged against. Counted from the same transcripts,
// over a window of days:
//   - nudges: short typed messages that only say "keep going" or ask "status?"
//   - asks:   AskUserQuestion calls (each one is an agent stopped on a human)
//   - worktrees added vs removed (a growing gap is cleanup nobody did)
// A typed message is a user line with string content that is not meta, not relayed from
// another session (origin) and not a command/system wrapper (starts with "<").
export const NUDGES = {
  continue: /^(ok(ay)?[,. ]+)?(yes[,. ]+)?(please )?(keep going|go on|continue|proceed|resume|go ahead|carry on|do it|next)\b/i,
  status: /^(ok(ay)?[,. ]+)?(what('?s| is) (the )?(status|next)|status\b|where (are we|do things stand)|what do you need from me|what are you waiting (on|for))/i,
};
// A nudge says nothing else: at most this many words after the opening phrase
// ("proceed with your recommendations" is one; "status of the deploy script is wrong,
// fix line 3" is an instruction).
export const NUDGE_TAIL_WORDS = 4;

export function nudgeKind(text) {
  const t = text.trim();
  for (const [kind, re] of Object.entries(NUDGES)) {
    const m = t.match(re);
    if (m && t.slice(m[0].length).split(/\s+/).filter(Boolean).length <= NUDGE_TAIL_WORDS) return kind;
  }
  return null;
}

const WORKTREE = /\bgit\b[^|;&\n]*\bworktree\s+(add|remove|prune)\b/g;

export function friction({ root = join(homedir(), '.claude/projects'), filter = '', days = 30, now = Date.now(), top = 20, prefix = '', aliases = {} } = {}) {
  const since = now - days * 86_400_000;
  const out = { days, since: new Date(since).toISOString(), sessions: 0, typed: 0, nudges: { continue: 0, status: 0 }, asks: 0, worktrees: { added: 0, removed: 0 } };
  const skills = new Map();
  for (const f of jsonlFiles(root)) {
    if (f.mtime < since) continue; // nothing in it can be inside the window
    if (filter && !basename(join(f.path, '..')).includes(filter)) continue;
    // Newer transcripts mark who wrote a user line (origin.kind). Where a file has those
    // marks, only "human" lines are typed messages; an unmarked line there is a relayed
    // prompt or a summary. A file with no marks at all predates them: count its plain lines.
    let counted = false, sawOrigin = false;
    const typed = [], legacy = [];
    for (const line of readFileSync(f.path, 'utf8').split('\n')) {
      if (!line.startsWith('{"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== 'user' && j.type !== 'assistant') continue;
      if (!j.timestamp || Date.parse(j.timestamp) < since || Date.parse(j.timestamp) > now) continue;
      counted = true;
      const c = j.message?.content;
      if (j.type === 'user') {
        if (j.origin) sawOrigin = true;
        if (j.isMeta || j.isSidechain || (j.origin && j.origin.kind !== 'human')) continue;
        const text = typeof c === 'string' ? c : Array.isArray(c) && !c.some((b) => b?.type === 'tool_result') ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
        const cmds = [...text.matchAll(/<command-name>\/?([^<\s]+)[^<]*<\/command-name>/g)];
        if (cmds.length === 1) bump(skills, canon(cmds[0][1], prefix, aliases));
        if (!text.trim() || text.trimStart().startsWith('<')) continue;
        (j.origin ? typed : legacy).push(text);
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== 'tool_use') continue;
          if (b.name === 'AskUserQuestion') out.asks++;
          else if (b.name === 'Skill' && typeof b.input?.skill === 'string') bump(skills, canon(b.input.skill, prefix, aliases));
          else if (b.name === 'Bash' && typeof b.input?.command === 'string') {
            for (const m of b.input.command.matchAll(WORKTREE)) out.worktrees[m[1] === 'add' ? 'added' : 'removed']++;
          }
        }
      }
    }
    if (counted) out.sessions++;
    for (const text of sawOrigin ? typed : legacy) {
      out.typed++;
      const kind = nudgeKind(text);
      if (kind) out.nudges[kind]++;
    }
  }
  out.nudges.total = out.nudges.continue + out.nudges.status;
  out.nudgeShare = out.typed ? +(out.nudges.total / out.typed).toFixed(2) : 0;
  out.skills = ranked(skills, top);
  out.filter = filter || null;
  return out;
}
