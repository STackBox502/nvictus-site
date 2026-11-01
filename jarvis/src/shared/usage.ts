import type { LatencySummary, TurnRecord, UsageTotals } from './types';

export const emptyTotals = (): UsageTotals => ({ turns: 0, inputTokens: 0, outputTokens: 0, ttsChars: 0, sttSeconds: 0, incomplete: false });

export function addTurn(t: UsageTotals, r: Pick<TurnRecord, 'inputTokens' | 'outputTokens' | 'ttsChars' | 'sttSeconds' | 'live'>): UsageTotals {
  return {
    turns: t.turns + 1,
    inputTokens: t.inputTokens + (r.inputTokens ?? 0),
    outputTokens: t.outputTokens + (r.outputTokens ?? 0),
    ttsChars: t.ttsChars + r.ttsChars,
    sttSeconds: Math.round((t.sttSeconds + r.sttSeconds) * 10) / 10,
    incomplete: t.incomplete || (r.live && (r.inputTokens === undefined || r.outputTokens === undefined)),
  };
}

export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** p50/p95 are only reported once enough real samples exist (default 20). */
export function summarizeLatency(stage: string, samples: readonly number[], minForPercentiles = 20): LatencySummary {
  const clean = samples.filter((n) => Number.isFinite(n) && n >= 0);
  const out: LatencySummary = { stage, count: clean.length, recentMs: clean.slice(-10).map(Math.round) };
  if (clean.length >= minForPercentiles) {
    const sorted = [...clean].sort((a, b) => a - b);
    out.p50 = Math.round(percentile(sorted, 50));
    out.p95 = Math.round(percentile(sorted, 95));
  }
  return out;
}

export interface BudgetLimits {
  maxTurnsPerSession: number;
  maxOutputTokensPerDay: number;
  maxTtsCharsPerDay: number;
  maxSttSecondsPerDay: number;
}

/** Local, estimate-based guard. 0 disables a daily limit. Not a provider billing cap. */
export function checkBudget(session: UsageTotals, today: UsageTotals, limits: BudgetLimits): { ok: true } | { ok: false; reason: string } {
  if (session.turns >= limits.maxTurnsPerSession) return { ok: false, reason: `Session turn limit (${limits.maxTurnsPerSession}) reached.` };
  if (limits.maxOutputTokensPerDay > 0 && today.outputTokens >= limits.maxOutputTokensPerDay)
    return { ok: false, reason: `Daily output-token limit (${limits.maxOutputTokensPerDay}) reached.` };
  if (limits.maxTtsCharsPerDay > 0 && today.ttsChars >= limits.maxTtsCharsPerDay)
    return { ok: false, reason: `Daily voice-character limit (${limits.maxTtsCharsPerDay}) reached.` };
  if (limits.maxSttSecondsPerDay > 0 && today.sttSeconds >= limits.maxSttSecondsPerDay)
    return { ok: false, reason: `Daily listening limit (${limits.maxSttSecondsPerDay}s) reached.` };
  return { ok: true };
}

export function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
