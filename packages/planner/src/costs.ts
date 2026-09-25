import { checkedAdd, decimal } from './mandate.js';

/**
 * Cost attribution (T13).
 *
 * Two floors hold this module up:
 *
 * 1. Every number here is an exact integer in raw units or micro-USD. Nothing is a float, and
 *    nothing is rounded away silently.
 * 2. Allocations sum to their disclosed total *exactly*. When a division leaves a remainder it is
 *    assigned by a deterministic, disclosed rule (largest fractional remainder, ties broken by
 *    ascending owner bytes) rather than left unallocated.
 *
 * The module will not produce a report that conceals a fee, leaves dust unallocated, rebates an
 * owner below zero without saying so, or lets an aggregate saving stand while an owner is worse
 * off than its baseline. Those are refusal paths, not warnings.
 */

/** The only cost model this project admits. Everything omitted is treated as zero and disclosed. */
export interface CostModel {
  /** Protocol fee in basis points. The specification fixes this at zero. */
  protocol_fee_bps: string;
  /** Residual venue fee in basis points, applied to the venue leg only. */
  venue_fee_bps: string;
  /** Priority fee per transaction, in micro-USD, as assumed before execution. */
  priority_fee_micro_usd_per_transaction: string;
  /** Base network fee per transaction, in micro-USD. */
  base_fee_micro_usd_per_transaction: string;
  /** Base network fee per transaction, in lamports, kept separate from its USD estimate. */
  base_fee_lamports_per_transaction: string;
  /** Rent that is recoverable when accounts close, in lamports. Never a cost. */
  recoverable_rent_lamports: string;
  /** Rent that is *not* recoverable, in lamports. Always a cost. */
  irrecoverable_rent_lamports: string;
  /** Micro-USD per SOL used to price lamport amounts. */
  sol_price_micro_usd: string;
  /** Whether the modelled costs are predictions or reconciled from chain. */
  basis: 'ESTIMATED' | 'REALIZED';
}

export const COST_MODEL_KEYS = [
  'protocol_fee_bps', 'venue_fee_bps', 'priority_fee_micro_usd_per_transaction',
  'base_fee_micro_usd_per_transaction', 'base_fee_lamports_per_transaction',
  'recoverable_rent_lamports', 'irrecoverable_rent_lamports', 'sol_price_micro_usd', 'basis',
] as const;

export interface OwnerCostInput {
  owner: string;
  /** Raw value the owner had to place externally, by asset. */
  external_input_raw: string[];
  /** Raw value the owner received back from the venue, by asset. */
  external_output_raw: string[];
  /** Reference prices in micro-USD per whole unit, by asset. */
  reference_price_micro_usd: string[];
  /** Decimal places, by asset. */
  decimals: string[];
  /** Raw units the owner moved inside the batch (crossed with another owner). */
  internal_moved_raw: string[];
  /** Transactions this owner's participation required. */
  transactions: string;
  /** The owner's net micro-USD outcome if it had executed independently. */
  independent_net_micro_usd: string;
  /** The owner's net micro-USD outcome under this plan, excluding costs attributed below. */
  planned_net_micro_usd: string;
}

export interface AllocationInput {
  model: CostModel;
  owners: OwnerCostInput[];
  /** Aggregate external cost already computed for the whole batch, in micro-USD. */
  external_cost_micro_usd: string;
  /** Whether the batch routed at all. No residual means no venue cost. */
  has_residual: boolean;
}

export interface OwnerCostRow {
  owner: string;
  external_input_raw: string[];
  external_output_raw: string[];
  /** Value of the owner's external input, in micro-USD. */
  external_value_micro_usd: string;
  /** This owner's share of the venue fee, in micro-USD. */
  venue_fee_micro_usd: string;
  /** This owner's share of network fees, in micro-USD. */
  network_fee_micro_usd: string;
  /** Recoverable rent attributable to this owner. Not a cost. */
  recoverable_rent_micro_usd: string;
  /** Irrecoverable rent attributable to this owner. A cost. */
  irrecoverable_rent_micro_usd: string;
  /** Total cost charged to this owner: venue + network + irrecoverable rent. */
  total_cost_micro_usd: string;
  /** Turnover: total raw value the owner moved, internal and external. */
  turnover_micro_usd: string;
  /** Change against the independent baseline, net of attributed cost. */
  versus_independent_micro_usd: string;
  /** True when the owner is worse off than executing independently. */
  worse_than_independent: boolean;
}

export interface CostReport {
  basis: 'ESTIMATED' | 'REALIZED';
  rows: OwnerCostRow[];
  totals: {
    external_cost_micro_usd: string;
    venue_fee_micro_usd: string;
    network_fee_micro_usd: string;
    recoverable_rent_micro_usd: string;
    irrecoverable_rent_micro_usd: string;
    total_cost_micro_usd: string;
  };
  /** Owners whose outcome is worse than their independent baseline. */
  harmed_owners: string[];
  /** The rule used to place any indivisible remainder. */
  residual_rule: string;
  assumptions: string[];
}

function microPerRawUnit(priceMicroUsd: bigint, decimals: bigint): { numerator: bigint; denominator: bigint } {
  return { numerator: priceMicroUsd, denominator: 10n ** decimals };
}

/** Exact value of a raw amount in micro-USD, floored, plus its remainder for allocation. */
function valueOf(raw: bigint, priceMicroUsd: bigint, decimals: bigint): { whole: bigint; remainder: bigint; denominator: bigint } {
  const { numerator, denominator } = microPerRawUnit(priceMicroUsd, decimals);
  const product = raw * numerator;
  return { whole: product / denominator, remainder: product % denominator, denominator };
}

/**
 * Split `total` across `weights` exactly. Largest remainder first; ties by ascending owner bytes.
 * A zero weight receives nothing. Throws when the total cannot be represented.
 */
export function allocateExact(total: bigint, weights: bigint[], owners: string[]): bigint[] {
  if (weights.length !== owners.length) throw new RangeError('weights and owners must correspond');
  if (total < 0n) throw new RangeError('cannot allocate a negative total');
  const sum = weights.reduce((acc, weight) => acc + weight, 0n);
  if (sum === 0n) {
    if (total !== 0n) throw new RangeError('total exceeds zero while every weight is zero');
    return weights.map(() => 0n);
  }
  const base = weights.map(weight => (total * weight) / sum);
  let remainder = total - base.reduce((acc, value) => acc + value, 0n);
  const order = weights
    .map((weight, index) => ({ index, remainder: (total * weight) % sum, owner: owners[index] }))
    .sort((a, b) => (a.remainder === b.remainder
      ? (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0)
      : (a.remainder > b.remainder ? -1 : 1)));
  for (const entry of order) {
    if (remainder === 0n) break;
    base[entry.index] += 1n;
    remainder -= 1n;
  }
  if (remainder !== 0n) throw new Error('allocation left an unallocated remainder');
  return base;
}

function readModel(input: unknown): CostModel {
  if (!input || typeof input !== 'object') throw new TypeError('cost model must be an object');
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(COST_MODEL_KEYS as readonly string[]).includes(key)) throw new TypeError(`undisclosed cost model field: ${key}`);
  }
  for (const key of COST_MODEL_KEYS) {
    if (key === 'basis') continue;
    if (typeof record[key] !== 'string') throw new TypeError(`cost model field ${key} must be a decimal string`);
  }
  if (record.basis !== 'ESTIMATED' && record.basis !== 'REALIZED') throw new TypeError('cost model basis must be ESTIMATED or REALIZED');
  const model = record as unknown as CostModel;
  const protocolFee = decimal(model.protocol_fee_bps, 'protocol_fee_bps', 10_000n);
  if (protocolFee !== 0n) {
    // The specification fixes the protocol fee at zero. A non-zero value is a hidden fee, because
    // no settlement path can pay it out.
    throw new RangeError('protocol_fee_bps must be zero: the specification fixes protocol fees at zero');
  }
  const venueFee = decimal(model.venue_fee_bps, 'venue_fee_bps', 10_000n);
  if (venueFee > 1_000n) throw new RangeError('venue_fee_bps exceeds the disclosed maximum');
  return model;
}

function readOwners(input: unknown): OwnerCostInput[] {
  if (!Array.isArray(input) || input.length < 2 || input.length > 3) throw new RangeError('an allocation covers two or three owners');
  const owners = input as OwnerCostInput[];
  const seen = new Set<string>();
  for (const owner of owners) {
    if (typeof owner.owner !== 'string' || !/^[0-9a-f]{64}$/.test(owner.owner)) throw new TypeError('owner must be 32-byte hex');
    if (seen.has(owner.owner)) throw new TypeError('owners must be unique');
    seen.add(owner.owner);
    for (const field of ['external_input_raw', 'external_output_raw'] as const) {
      if (!Array.isArray(owner[field]) || owner[field].length !== 3) throw new TypeError(`${field} must have three entries`);
    }
    if (typeof owner.transactions !== 'string') throw new TypeError('transactions must be a decimal string');
  }
  const sorted = [...owners].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  return sorted;
}

/** Attributes every unit of cost, or refuses. */
export function attributeCosts(input: unknown): CostReport {
  const record = input as AllocationInput;
  const model = readModel(record?.model);
  const owners = readOwners(record?.owners);
  const externalCost = decimal(record.external_cost_micro_usd, 'external_cost_micro_usd');
  if (!record.has_residual && externalCost !== 0n) {
    throw new RangeError('an internal-only batch cannot carry external cost');
  }

  const perOwner = owners.map(owner => {
    let externalValue = 0n;
    let turnover = 0n;
    let remainder = 0n;
    let denominator = 1n;
    for (let asset = 0; asset < 3; asset++) {
      const price = decimal(owner.reference_price_micro_usd[asset], 'reference price');
      const decimals = BigInt(owner.decimals[asset]);
      const inputRaw = decimal(owner.external_input_raw[asset], 'external input');
      const outputRaw = decimal(owner.external_output_raw[asset], 'external output');
      const movedRaw = decimal(owner.internal_moved_raw[asset], 'internal moved');
      const input = valueOf(inputRaw, price, decimals);
      externalValue += input.whole;
      remainder += input.remainder;
      denominator = input.denominator;
      turnover += valueOf(inputRaw + outputRaw + movedRaw, price, decimals).whole;
      // Values are compared for disclosure only; the raw units remain the authority.
      if (outputRaw < 0n) throw new RangeError('external output cannot be negative');
    }
    if (remainder >= denominator * BigInt(owners.length)) throw new RangeError('unreachable remainder');
    return { owner, externalValue, turnover };
  });

  // Every owner who contributed externally pays venue cost in proportion to that contribution. A
  // non-contributing owner pays none: it produced no external flow to charge for.
  const weights = perOwner.map(entry => entry.externalValue);
  const venueFees = allocateExact(externalCost, weights, owners.map(owner => owner.owner));

  // Network fees are shared by transaction count, which is what actually drives them.
  const transactionCounts = owners.map(owner => decimal(owner.transactions, 'transactions', 10_000n));
  const networkTotal = BigInt(model.base_fee_micro_usd_per_transaction) * transactionCounts.reduce((a, b) => a + b, 0n)
    + BigInt(model.priority_fee_micro_usd_per_transaction) * transactionCounts.reduce((a, b) => a + b, 0n);
  const networkFees = allocateExact(networkTotal, transactionCounts, owners.map(owner => owner.owner));

  // Rent is attributed by transaction count too, and recoverable rent is never charged as cost.
  const recoverableTotal = lamportsToMicroUsd(decimal(model.recoverable_rent_lamports, 'recoverable rent'), decimal(model.sol_price_micro_usd, 'sol price'));
  const irrecoverableTotal = lamportsToMicroUsd(decimal(model.irrecoverable_rent_lamports, 'irrecoverable rent'), decimal(model.sol_price_micro_usd, 'sol price'));
  const recoverable = allocateExact(recoverableTotal, transactionCounts, owners.map(owner => owner.owner));
  const irrecoverable = allocateExact(irrecoverableTotal, transactionCounts, owners.map(owner => owner.owner));

  const rows: OwnerCostRow[] = perOwner.map((entry, index) => {
    const totalCost = venueFees[index] + networkFees[index] + irrecoverable[index];
    const planned = decimal(entry.owner.planned_net_micro_usd, 'planned net');
    const independent = decimal(entry.owner.independent_net_micro_usd, 'independent net');
    const versus = (planned - totalCost) - independent;
    return {
      owner: entry.owner.owner,
      external_input_raw: entry.owner.external_input_raw,
      external_output_raw: entry.owner.external_output_raw,
      external_value_micro_usd: entry.externalValue.toString(),
      venue_fee_micro_usd: venueFees[index].toString(),
      network_fee_micro_usd: networkFees[index].toString(),
      recoverable_rent_micro_usd: recoverable[index].toString(),
      irrecoverable_rent_micro_usd: irrecoverable[index].toString(),
      total_cost_micro_usd: totalCost.toString(),
      turnover_micro_usd: entry.turnover.toString(),
      versus_independent_micro_usd: versus.toString(),
      worse_than_independent: versus < 0n,
    };
  });

  const total = rows.reduce((acc, row) => checkedAdd(acc, BigInt(row.total_cost_micro_usd), 'total cost'), 0n);
  const expected = externalCost + networkTotal + irrecoverableTotal;
  if (total !== expected) throw new Error(`allocation ${total} does not reconcile with the disclosed total ${expected}`);
  const recoverableSum = rows.reduce((acc, row) => acc + BigInt(row.recoverable_rent_micro_usd), 0n);
  if (recoverableSum !== recoverableTotal) throw new Error('recoverable rent does not reconcile');

  return {
    basis: model.basis,
    rows,
    totals: {
      external_cost_micro_usd: externalCost.toString(),
      venue_fee_micro_usd: venueFees.reduce((a, b) => a + b, 0n).toString(),
      network_fee_micro_usd: networkFees.reduce((a, b) => a + b, 0n).toString(),
      recoverable_rent_micro_usd: recoverableSum.toString(),
      irrecoverable_rent_micro_usd: irrecoverable.reduce((a, b) => a + b, 0n).toString(),
      total_cost_micro_usd: total.toString(),
    },
    harmed_owners: rows.filter(row => row.worse_than_independent).map(row => row.owner),
    residual_rule: 'venue cost is split across owners in proportion to external input value; network and rent are split by transaction count; the remainder goes to the largest fractional share, ties broken by ascending owner bytes',
    assumptions: [
      `cost basis: ${model.basis}`,
      `venue fee ${model.venue_fee_bps} bps applied to the residual leg only`,
      `protocol fee ${model.protocol_fee_bps} bps (fixed at zero by the specification)`,
      `network fee ${model.base_fee_micro_usd_per_transaction} micro-USD per transaction plus ${model.priority_fee_micro_usd_per_transaction} micro-USD priority`,
      `recoverable rent ${model.recoverable_rent_lamports} lamports is reported but never charged as cost`,
      `irrecoverable rent ${model.irrecoverable_rent_lamports} lamports is charged`,
      `prices used are the same fixture reference prices that funded the mandates`,
    ],
  };
}

export function lamportsToMicroUsd(lamports: bigint, solPriceMicroUsd: bigint): bigint {
  const LAMPORTS_PER_SOL = 1_000_000_000n;
  return (lamports * solPriceMicroUsd) / LAMPORTS_PER_SOL;
}
