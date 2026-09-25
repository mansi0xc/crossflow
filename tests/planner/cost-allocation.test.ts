import { describe, expect, test } from 'vitest';
import { allocateExact, attributeCosts, type CostModel } from '../../packages/planner/src/costs.js';
import { compareApproaches } from '../../packages/planner/src/comparison.js';

/**
 * T13 — cost disclosure and allocation.
 *
 * The clause under test throughout is "do not hide a fee, do not leave dust unallocated, and never
 * let an aggregate saving excuse an owner that ends up worse off".
 */
const OWNERS = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)].sort();

const MODEL: CostModel = {
  protocol_fee_bps: '0',
  venue_fee_bps: '30',
  priority_fee_micro_usd_per_transaction: '18',
  base_fee_micro_usd_per_transaction: '1800',
  base_fee_lamports_per_transaction: '5000',
  recoverable_rent_lamports: '2000000',
  irrecoverable_rent_lamports: '0',
  sol_price_micro_usd: '150000000',
  basis: 'ESTIMATED',
};

function owner(index: number, overrides: Partial<Parameters<typeof attributeCosts>[0] extends never ? never : Record<string, unknown>> = {}) {
  return {
    owner: OWNERS[index],
    external_input_raw: ['0', '0', '0'],
    external_output_raw: ['0', '0', '0'],
    reference_price_micro_usd: ['1000000', '10000000', '20000000'],
    decimals: ['6', '6', '6'],
    internal_moved_raw: ['0', '0', '0'],
    transactions: '1',
    independent_net_micro_usd: '0',
    planned_net_micro_usd: '0',
    ...overrides,
  };
}

/** One owner sells 1,000,000 raw stock1 externally at 10 micro-USD per whole unit. */
const sellingOwner = owner(0, { external_input_raw: ['0', '1000000', '0'], external_output_raw: ['10000000', '0', '0'], transactions: '2' });

describe('T13 cost allocation', () => {
  test('every allocated unit reconciles exactly with the disclosed total', () => {
    const report = attributeCosts({
      model: MODEL,
      has_residual: true,
      external_cost_micro_usd: '30000',
      owners: [sellingOwner, owner(1), owner(2)],
    });
    const sum = (field: 'venue_fee_micro_usd' | 'network_fee_micro_usd' | 'total_cost_micro_usd') =>
      report.rows.reduce((acc, row) => acc + BigInt(row[field]), 0n);
    expect(sum('venue_fee_micro_usd')).toBe(BigInt(report.totals.venue_fee_micro_usd));
    expect(sum('network_fee_micro_usd')).toBe(BigInt(report.totals.network_fee_micro_usd));
    expect(sum('total_cost_micro_usd')).toBe(BigInt(report.totals.total_cost_micro_usd));
    expect(BigInt(report.totals.total_cost_micro_usd)).toBe(
      BigInt(report.totals.venue_fee_micro_usd) + BigInt(report.totals.network_fee_micro_usd)
      + BigInt(report.totals.irrecoverable_rent_micro_usd));
    // Only the owner with external flow pays venue cost.
    const paying = report.rows.filter(row => BigInt(row.venue_fee_micro_usd) > 0n).map(row => row.owner);
    expect(paying).toEqual([sellingOwner.owner]);
    expect(report.residual_rule).toMatch(/remainder goes to the largest fractional share/);
  });

  test('raw units are echoed untouched and recoverable rent is never charged', () => {
    const report = attributeCosts({
      model: MODEL, has_residual: true, external_cost_micro_usd: '1000',
      owners: [sellingOwner, owner(1), owner(2)],
    });
    const row = report.rows.find(entry => entry.owner === sellingOwner.owner)!;
    expect(row.external_input_raw).toEqual(sellingOwner.external_input_raw);
    expect(row.external_output_raw).toEqual(sellingOwner.external_output_raw);
    expect(BigInt(report.totals.recoverable_rent_micro_usd)).toBeGreaterThan(0n);
    expect(BigInt(row.total_cost_micro_usd)).toBe(
      BigInt(row.venue_fee_micro_usd) + BigInt(row.network_fee_micro_usd) + BigInt(row.irrecoverable_rent_micro_usd));
    expect(report.assumptions.join(' ')).toContain('never charged as cost');
    // Turnover counts internal and external flow: 1,000,000 raw stock1 at 10 µUSD per whole unit
    // plus 10,000,000 raw cash at 1 µUSD, both at six decimals.
    expect(row.external_value_micro_usd).toBe('10000000');
    expect(BigInt(row.turnover_micro_usd)).toBe(20_000_000n);
  });

  test('the split is deterministic and independent of the order owners are supplied in', () => {
    const input = { model: MODEL, has_residual: true, external_cost_micro_usd: '99997', owners: [sellingOwner, owner(1), owner(2)] };
    const first = attributeCosts(input);
    const reversed = attributeCosts({ ...input, owners: [...input.owners].reverse() });
    const byOwner = (report: typeof first) => Object.fromEntries(report.rows.map(row => [row.owner, row.total_cost_micro_usd]));
    expect(byOwner(first)).toEqual(byOwner(reversed));
  });

  test('an indivisible remainder is assigned, never dropped', () => {
    const split = allocateExact(1n, [1n, 1n, 1n], ['aa', 'bb', 'cc']);
    expect(split.reduce((a, b) => a + b, 0n)).toBe(1n);
    // Ties are broken by ascending owner bytes, so the first owner takes it.
    expect(split).toEqual([1n, 0n, 0n]);
    const uneven = allocateExact(100n, [1n, 2n, 7n], ['aa', 'bb', 'cc']);
    expect(uneven.reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(uneven).toEqual([10n, 20n, 70n]);
  });

  test('negatives: a hidden fee, an undisclosed model field, and cost without a route are refused', () => {
    expect(() => attributeCosts({
      model: { ...MODEL, protocol_fee_bps: '5' }, has_residual: true, external_cost_micro_usd: '1',
      owners: [sellingOwner, owner(1), owner(2)],
    })).toThrow(/protocol fees at zero/);

    expect(() => attributeCosts({
      model: { ...MODEL, mystery_fee_bps: '1' } as unknown as CostModel, has_residual: true,
      external_cost_micro_usd: '1', owners: [sellingOwner, owner(1), owner(2)],
    })).toThrow(/undisclosed cost model field/);

    expect(() => attributeCosts({
      model: MODEL, has_residual: false, external_cost_micro_usd: '500',
      owners: [sellingOwner, owner(1), owner(2)],
    })).toThrow(/internal-only batch cannot carry external cost/);

    // A negative total would be a rebate this project cannot pay.
    expect(() => allocateExact(-1n, [1n, 1n], ['aa', 'bb'])).toThrow(/negative total/);
    // A non-zero total with no weight to carry it is an unallocated remainder.
    expect(() => allocateExact(5n, [0n, 0n], ['aa', 'bb'])).toThrow(/exceeds zero/);
  });
});

describe('T13 comparison', () => {
  const allocation = {
    model: MODEL, has_residual: true, external_cost_micro_usd: '30000',
    owners: [sellingOwner, owner(1), owner(2)],
  };
  // Costs here total 37,272 micro-USD (30,000 venue + 7,272 network), so the net figures are sized
  // to the same order of magnitude as a real batch rather than to convenient small integers.
  const approaches = [
    { method: 'independent', net_micro_usd: ['1000000', '1000000', '1000000'], within_signed_bounds: [true, true, true], recurring_cost_micro_usd: '30000', feasible: true },
    { method: 'netting', net_micro_usd: ['1010000', '1005000', '1003000'], within_signed_bounds: [true, true, true], recurring_cost_micro_usd: '20000', feasible: true },
    { method: 'cooperative', net_micro_usd: ['1060000', '1030000', '1020000'], within_signed_bounds: [true, true, true], recurring_cost_micro_usd: '15000', feasible: true },
  ];

  test('an improvement every owner shares is reported as Pareto over the baseline', () => {
    const result = compareApproaches({ owners: OWNERS, approaches, allocation, selected: 'cooperative', baseline: 'netting' });
    expect(result.pareto_over_baseline).toBe(true);
    expect(result.harmed_owners).toEqual([]);
    expect(result.declined_reason).toBeNull();
    expect(result.rows.every(row => BigInt(row.difference_micro_usd) > 0n)).toBe(true);
    expect(result.disclosure.join(' ')).toContain('not realized fills');
  });

  test('aggregate savings do not excuse an owner that ends up worse off', () => {
    const skewed = [
      approaches[0],
      approaches[1],
      { ...approaches[2], net_micro_usd: ['2000000', '900000', '1020000'] },
    ];
    const result = compareApproaches({ owners: OWNERS, approaches: skewed, allocation, selected: 'cooperative', baseline: 'netting' });
    // The batch looks better in aggregate...
    expect(BigInt(result.aggregate.difference_micro_usd)).toBeGreaterThan(0n);
    // ...but one owner is harmed, so the plan is declined rather than offered.
    expect(result.harmed_owners).toEqual([OWNERS[1]]);
    expect(result.pareto_over_baseline).toBe(false);
    expect(result.declined_reason).toMatch(/worse than their baseline/);
  });

  test('a violated signed bound declines even when every owner improves', () => {
    const violating = [
      approaches[0],
      approaches[1],
      { ...approaches[2], within_signed_bounds: [true, false, true] },
    ];
    const result = compareApproaches({ owners: OWNERS, approaches: violating, allocation, selected: 'cooperative', baseline: 'netting' });
    expect(result.pareto_over_baseline).toBe(false);
    expect(result.declined_reason).toMatch(/signed bounds would be violated/);
  });

  test('an infeasible approach is declined with its reasons', () => {
    const infeasible = [
      approaches[0],
      approaches[1],
      { ...approaches[2], feasible: false, reasons: ['no route within the committed band'] },
    ];
    const result = compareApproaches({ owners: OWNERS, approaches: infeasible, allocation, selected: 'cooperative', baseline: 'netting' });
    expect(result.declined_reason).toMatch(/not executable: no route within the committed band/);
  });

  test('a comparison cannot reference an owner the allocation does not cover', () => {
    const short = { ...allocation, owners: [sellingOwner, owner(1)] };
    expect(() => compareApproaches({ owners: OWNERS, approaches, allocation: short, selected: 'cooperative', baseline: 'netting' }))
      .toThrow(/does not cover the compared owners/);
  });
});
