import { checkedAdd, decimal } from './mandate.js';
import { type CostReport, attributeCosts } from './costs.js';

/**
 * Three-way comparison (T13).
 *
 * The comparison exists to stop one specific lie: "the batch saved money" said while some owner
 * funded a worse outcome than it would have had alone. Aggregate improvement never excuses a
 * harmed participant, and a plan the specification cannot pay for is declined rather than
 * rebalanced.
 */
export interface ApproachOutcome {
  /** Method label: independent execution, fixed-order netting, cooperative adjustment. */
  method: string;
  /** Per-owner net outcome, in micro-USD, before attributed cost. */
  net_micro_usd: string[];
  /** Per-owner bound satisfaction. A false entry disqualifies the approach. */
  within_signed_bounds: boolean[];
  /** Recurring cost for this approach, in micro-USD. */
  recurring_cost_micro_usd: string;
  feasible: boolean;
  /** Why the approach is not executable, when it is not. */
  reasons?: string[];
}

export interface ComparisonInput {
  owners: string[];
  approaches: ApproachOutcome[];
  allocation: unknown;
  /** The method the operator intends to run. */
  selected: string;
  baseline: string;
}

export interface ComparisonResult {
  owners: string[];
  rows: {
    owner: string;
    baseline_micro_usd: string;
    selected_micro_usd: string;
    difference_micro_usd: string;
    worse_than_baseline: boolean;
    within_signed_bounds: boolean;
    attributed_cost_micro_usd: string;
  }[];
  aggregate: { baseline_micro_usd: string; selected_micro_usd: string; difference_micro_usd: string };
  /** True only when no owner is worse off and every bound holds. */
  pareto_over_baseline: boolean;
  harmed_owners: string[];
  /** Set when the selected approach cannot be offered at all. */
  declined_reason: string | null;
  disclosure: string[];
}

export function compareApproaches(input: unknown): ComparisonResult {
  const record = input as ComparisonInput;
  if (!Array.isArray(record?.owners) || record.owners.length < 2 || record.owners.length > 3) {
    throw new RangeError('a comparison covers two or three owners');
  }
  const owners = record.owners;
  if (!record.approaches.some(approach => approach.method === record.baseline)) throw new TypeError('baseline approach is missing');
  const selected = record.approaches.find(approach => approach.method === record.selected);
  if (!selected) throw new TypeError('selected approach is missing');
  const baseline = record.approaches.find(approach => approach.method === record.baseline)!;

  const allocation: CostReport = attributeCosts(record.allocation);
  if (allocation.rows.length !== owners.length) throw new RangeError('allocation does not cover the compared owners');
  const costByOwner = new Map(allocation.rows.map(row => [row.owner, BigInt(row.total_cost_micro_usd)]));

  const rows = owners.map((owner, index) => {
    const baselineValue = decimal(baseline.net_micro_usd[index], 'baseline net');
    const selectedValue = decimal(selected.net_micro_usd[index], 'selected net');
    const attributed = costByOwner.get(owner);
    if (attributed === undefined) throw new TypeError(`allocation is missing owner ${owner}`);
    const difference = (selectedValue - attributed) - baselineValue;
    return {
      owner,
      baseline_micro_usd: baselineValue.toString(),
      selected_micro_usd: selectedValue.toString(),
      difference_micro_usd: difference.toString(),
      worse_than_baseline: difference < 0n,
      within_signed_bounds: selected.within_signed_bounds[index] === true,
      attributed_cost_micro_usd: attributed.toString(),
    };
  });

  const aggregate = {
    baseline_micro_usd: rows.reduce((acc, row) => checkedAdd(acc, BigInt(row.baseline_micro_usd), 'aggregate'), 0n),
    selected_micro_usd: rows.reduce((acc, row) => checkedAdd(acc, BigInt(row.selected_micro_usd), 'aggregate'), 0n),
    difference_micro_usd: rows.reduce((acc, row) => checkedAdd(acc, BigInt(row.difference_micro_usd), 'aggregate'), 0n),
  };

  const harmed = rows.filter(row => row.worse_than_baseline).map(row => row.owner);
  const boundsViolated = rows.filter(row => !row.within_signed_bounds).map(row => row.owner);
  const infeasible = !selected.feasible;

  // Decline rather than redistribute: an approach that breaks a signed bound, executes an owner
  // below its baseline, or is not executable at all is never offered as a settlement.
  let declined: string | null = null;
  if (infeasible) declined = `the selected approach is not executable: ${(selected.reasons ?? ['unspecified']).join('; ')}`;
  else if (boundsViolated.length > 0) declined = `signed bounds would be violated for ${boundsViolated.join(', ')}`;
  else if (harmed.length > 0) declined = `owners would be worse than their baseline: ${harmed.join(', ')}`;

  return {
    owners,
    rows,
    aggregate: {
      baseline_micro_usd: aggregate.baseline_micro_usd.toString(),
      selected_micro_usd: aggregate.selected_micro_usd.toString(),
      difference_micro_usd: aggregate.difference_micro_usd.toString(),
    },
    pareto_over_baseline: declined === null && harmed.length === 0,
    harmed_owners: harmed,
    declined_reason: declined,
    disclosure: [
      'differences are modelled micro-USD under one frozen cost convention, not realized fills',
      'costs are attributed by the disclosed rule and reconcile exactly with the totals',
      'an aggregate saving never excuses an owner below its baseline: the plan is declined instead',
      'recoverable rent is reported separately and never charged as cost',
      'each approach is compared under identical starting holdings, prices and bounds',
      ...allocation.assumptions,
    ],
  };
}
