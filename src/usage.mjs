// What an agent call cost, read from the agent's own JSON result.
//
// Verified against Claude Code's `--output-format json` (2026-11-23): one object with
// `result` (the text), `total_cost_usd`, `usage.{input_tokens, output_tokens,
// cache_read_input_tokens, cache_creation_input_tokens}`, `modelUsage` keyed by model
// id, `num_turns`, `duration_ms`, `is_error`. Other agents print plain text: their
// output is used as is and their usage is recorded as not reported, never as zero.
export function parseAgentOutput(stdout) {
  const raw = stdout ?? '';
  const t = raw.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return { text: raw, usage: null };
  let j;
  try { j = JSON.parse(t); } catch { return { text: raw, usage: null }; }
  if (typeof j?.result !== 'string') return { text: raw, usage: null };
  const n = (v) => (Number.isFinite(v) ? v : null);
  const u = j.usage ?? {};
  const reported = Number.isFinite(j.total_cost_usd) || Number.isFinite(u.output_tokens);
  return {
    text: j.result,
    usage: reported ? {
      costUSD: n(j.total_cost_usd), inputTokens: n(u.input_tokens), outputTokens: n(u.output_tokens),
      cacheReadTokens: n(u.cache_read_input_tokens), cacheWriteTokens: n(u.cache_creation_input_tokens),
      models: Object.keys(j.modelUsage ?? {}).sort(), turns: n(j.num_turns), durationMs: n(j.duration_ms),
      ...(j.is_error ? { error: true } : {}),
    } : null,
  };
}

// Totals over agent calls. `unreported` counts calls with no usage: with any, the totals
// are a floor, and the rendering says so.
export function sumUsage(calls) {
  const out = { calls: calls.length, unreported: 0, costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models: [] };
  const models = new Set();
  for (const u of calls) {
    if (!u) { out.unreported++; continue; }
    for (const k of ['costUSD', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) out[k] += u[k] ?? 0;
    for (const m of u.models ?? []) models.add(m);
  }
  out.costUSD = +out.costUSD.toFixed(6);
  out.models = [...models].sort();
  return out;
}

export function renderUsage(t) {
  if (!t.calls) return 'no agent calls';
  if (t.unreported === t.calls) return `${t.calls} agent call(s) · cost and tokens not reported by this agent`;
  const tokensIn = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return `${t.calls} agent call(s) · ${t.unreported ? 'at least ' : ''}$${t.costUSD.toFixed(4)} · ${tokensIn} tokens in (${t.cacheReadTokens} from cache) · ${t.outputTokens} out · ${t.models.join(', ') || 'model not reported'}${t.unreported ? ` · ${t.unreported} call(s) did not report usage` : ''}`;
}
