import { describe, expect, test } from 'vitest';
import { planDecision } from '../../apps/web/src/decision.js';
import type { PlanResponse } from '../../apps/web/src/api.js';

/**
 * The one predicate that gates compare, the step navigation and the funding handler. A harmful or
 * non-executable batch must be ineligible no matter which entry point a request arrives by.
 */
function plan(overrides: { method?: string | null; feasible?: Record<string, boolean>; noWorse?: boolean | null; harmed?: string[] } = {}): PlanResponse {
  const method = 'method' in overrides ? overrides.method : 'C';
  const feasible = overrides.feasible ?? { A: true, B: true, C: true };
  const noWorse = overrides.noWorse ?? true;
  return {
    status: 'OK', scenario_id: 'x', scenario_sha256: 'ab',
    proposals: {
      A: { method: 'A', status: 'ok', feasible: feasible.A ?? true, reasons: [], totals: null },
      B: { method: 'B', status: 'ok', feasible: feasible.B ?? true, reasons: [], totals: null },
      C: { method: 'C', status: 'ok', feasible: feasible.C ?? true, reasons: [], totals: null },
    },
    comparison: {
      valid_baselines: true,
      ...(method === null ? {} : { recommendation: { method, reason: '', declined: {} } }),
      per_owner: { per_owner: [], harmed_owners: overrides.harmed ?? [], no_worse_than_independent: noWorse },
    },
  } as PlanResponse;
}

describe('the selected decision gates every entry point the same way', () => {
  test('an eligible plan carries its recommended method through', () => {
    const decision = planDecision(plan({ method: 'C' }));
    expect(decision.eligible).toBe(true);
    expect(decision.method).toBe('C');
    expect(decision.reason).toBeNull();
  });

  test('a harmful batch is ineligible and names the harmed owners', () => {
    const decision = planDecision(plan({ noWorse: false, harmed: ['bbbbbbbb'] }));
    expect(decision.eligible).toBe(false);
    expect(decision.harmfulOwners).toEqual(['bbbbbbbb']);
    expect(decision.reason).toMatch(/worse off/);
  });

  test('a harmful batch is ineligible even when the recommended method is executable', () => {
    const decision = planDecision(plan({ method: 'C', noWorse: false, harmed: ['bbbbbbbb'] }));
    expect(decision.eligible).toBe(false);
  });

  test('no recommendation means no executable decision', () => {
    expect(planDecision(plan({ method: null })).eligible).toBe(false);
    expect(planDecision(null).eligible).toBe(false);
  });

  test('an infeasible recommended method is ineligible', () => {
    const decision = planDecision(plan({ method: 'B', feasible: { A: true, B: false, C: true } }));
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/not executable/);
  });
});
