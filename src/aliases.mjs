// Skills renamed since 0.2.0: old bundled name → current name. One table, so a project
// whose hyvemind.json still lists an old name keeps installing (with a warning), and
// transcript mining counts the old and new name as one skill.
export const RENAMED = {
  evidence: 'evidence-rules',
  'live-qualify': 'live-ai-check',
  plan: 'plan-tasks',
  pr: 'open-pr',
  review: 'review-change',
  ship: 'ship-change',
  'skill-miner': 'mine-skills',
  spec: 'write-spec',
};

// Every bundled name of 0.2.0, when the default install prefix was "bee-".
const V02 = ['ai-exchange', 'design-review', 'evidence', 'live-qualify', 'parallel-work', 'plan', 'pr', 'review', 'ship', 'skill-eval', 'skill-miner', 'spec', 'test-necessity'];
export const LEGACY_PREFIX = 'bee-';

// Transcripts recorded the installed (prefixed) names. Only the prefixed form is an
// alias here: a bare "review" or "plan" in a transcript is usually a project's own skill.
export const BUILTIN_ALIASES = Object.fromEntries(V02.map((n) => [`${LEGACY_PREFIX}${n}`, RENAMED[n] ?? n]));
