// Machine-wide state: ~/.hyvemind (HYVEMIND_HOME overrides). Per-repo state stays in
// .hyve; this is only for what spans repos: the fleet registry and the decision queue.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// A test process must never write to the real home. `node --test` marks its child
// processes with NODE_TEST_CONTEXT; without an explicit HYVEMIND_HOME there, there is none.
export function home(env = process.env) {
  if (env.HYVEMIND_HOME) return env.HYVEMIND_HOME;
  if (env.NODE_TEST_CONTEXT) return null;
  return join(homedir(), '.hyvemind');
}

// Readers never see a half-written file: write beside it, then rename over it.
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'wx');
  try { writeSync(fd, text); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

// Closed schema: an unknown key or a wrong type is an error, never skipped. A registry
// that silently drops what it cannot read reports a fleet smaller than the real one.
export function readJsonStrict(file, check) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message}); fix or delete it`); }
  const problem = check(data);
  if (problem) throw new Error(`${file} is malformed: ${problem}; fix or delete it`);
  return data;
}
