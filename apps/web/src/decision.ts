import type { PlanResponse } from './api.js';

/**
 * One selected decision, carried through compare → approve → execution.
 *
 * A plan only becomes executable when the recommended method is itself executable and no account
 * is worse off than trading independently. Every gate — the compare button, the step navigation and
 * the funding handler — uses this one predicate, so a harmful batch cannot be reached by skipping
 * a screen, and the funding handler re-checks it before asking the wallet to sign.
 */
export interface PlanDecision {
  /** The method the recommendation selected: A, B or C. */
  method: 'A' | 'B' | 'C' | null;
  /** True only when the recommended method may proceed to approval. */
  eligible: boolean;
  /** Plain-language reason it is blocked, when it is. */
  reason: string | null;
  harmfulOwners: string[];
}

interface ComparisonShape {
  recommendation?: { method?: string; reason?: string; declined?: Record<string, string> };
  per_owner?: { no_worse_than_independent?: boolean | null; harmed_owners?: string[]; definition?: string };
}

export function planDecision(plan: PlanResponse | null): PlanDecision {
  if (!plan) return { method: null, eligible: false, reason: 'there is no plan to act on', harmfulOwners: [] };
  const comparison = plan.comparison as ComparisonShape;
  const method = (comparison.recommendation?.method ?? null) as PlanDecision['method'];
  const harmfulOwners = comparison.per_owner?.harmed_owners ?? [];
  // The per-owner verdict is the individual guarantee: an aggregate saving never excuses it.
  if (comparison.per_owner?.no_worse_than_independent === false || harmfulOwners.length > 0) {
    return {
      method, eligible: false, harmfulOwners,
      reason: `this batch would leave ${harmfulOwners.join(', ') || 'an account'} worse off than trading on their own`,
    };
  }
  if (!method || !(method in plan.proposals)) {
    return { method: null, eligible: false, reason: 'the comparison did not select an executable method', harmfulOwners };
  }
  if (!plan.proposals[method].feasible) {
    return { method, eligible: false, harmfulOwners, reason: `the recommended method (${method}) is not executable` };
  }
  return { method, eligible: true, reason: null, harmfulOwners };
}
