// Pure ranking of generated candidates by their checker issues.
import type { Issue } from '../check/issue.ts';

export type Candidate = { seed: number; issues: Issue[] };
export type Ranked = Candidate & { score: number; rejected: boolean; reason?: string };

export const ERROR_WEIGHT = 100;
export const WARN_WEIGHT = 10;

// A sprite with an error, or with nothing drawn, is never offered.
const EMPTY_RULES = new Set(['blank', 'reduce-blank']);

export function scoreIssues(issues: Issue[]): number {
  let s = 0;
  for (const i of issues) s += i.severity === 'error' ? ERROR_WEIGHT : i.severity === 'warn' ? WARN_WEIGHT : 0;
  return s;
}

// Lowest score first; rejected candidates sort after every survivor. Ties keep input order.
export function rankCandidates(cands: Candidate[]): Ranked[] {
  const ranked = cands.map((c, n) => {
    const bad = c.issues.find(i => EMPTY_RULES.has(i.rule)) ?? c.issues.find(i => i.severity === 'error');
    const r: Ranked = { ...c, score: scoreIssues(c.issues), rejected: !!bad };
    if (bad) r.reason = bad.rule;
    return { r, n };
  });
  ranked.sort((a, b) => Number(a.r.rejected) - Number(b.r.rejected) || a.r.score - b.r.score || a.n - b.n);
  return ranked.map(x => x.r);
}
