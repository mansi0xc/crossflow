import { mandateBytes, policyBytes, sha256Hex } from '../../contracts/src/index.js';
import { checkedAdd, checkedMul, decimal, hex32, list, MAX_AMOUNT, MAX_POOL_AMOUNT, MAX_U64, parsePolicy, record, validateFundedMandate, type Mandate, type Policy } from './mandate.js';

const BPS = 10_000n;
const CONTEXT_KEYS = ['policy', 'expected_genesis', 'now_unix_seconds', 'snapshot', 'intents', 'technical_probe'];
const SNAPSHOT_KEYS = ['policy_hash', 'publisher', 'sequence', 'market_closed', 'assets'];
const OBSERVATION_KEYS = ['feed_id', 'price', 'confidence', 'underlying_observed_at', 'published_at'];
const INTENT_KEYS = ['mandate', 'stored_mandate_hash', 'stored_status', 'stored_nonce', 'booked_funding', 'vault_balances'];
const PLAN_KEYS = ['schema_version', 'expected_snapshot_sequence', 'mandate_hashes', 'crosses', 'residuals', 'estimated_outputs'];
const CROSS_KEYS = ['stock_index', 'seller_index', 'buyer_index', 'stock_quantity', 'cash_amount'];
const RESIDUAL_KEYS = ['stock_index', 'direction', 'minimum_output', 'input_allocations'];

export interface Cross { stock_index: string; seller_index: string; buyer_index: string; stock_quantity: string; cash_amount: string }
export interface Residual { stock_index: string; direction: string; minimum_output: string; input_allocations: string[] }
export interface SettlementBody { schema_version: '1'; expected_snapshot_sequence: string; crosses: Cross[]; residuals: Residual[] }
export interface CandidatePlan extends SettlementBody { mandate_hashes: string[]; estimated_outputs: string[] }
export interface ValidatedPlan {
  status: 'validated_proposal';
  requires_onchain_acceptance: true;
  /** Residual allocations use a quote and must be recomputed from measured CPI output. */
  quote_dependent: boolean;
  /** An all-zero-flow proposal has no execution to which savings can be attributed. */
  no_op: boolean;
  settlement_body: Uint8Array;
  plan: CandidatePlan;
  mandate_hashes: string[];
  debits: string[][];
  credits: string[][];
  outputs: string[][];
  external_net: string[];
  residual_output_allocations: string[][];
  owner_internal_premium_paid: string[];
  owner_external_shortfall: string[];
}

function index(value: unknown, cap: number, name: string): number { return Number(decimal(value, name, BigInt(cap))); }

function value(amount: bigint, assetIndex: number, prices: bigint[], decimals: number[]): bigint {
  return checkedMul(checkedMul(amount, prices[assetIndex], 'token value'), 10n ** BigInt(9 - decimals[assetIndex]), 'token value');
}

function priceBand(stockAmount: bigint, cashAmount: bigint, stockIndex: number, cashIndex: number, prices: bigint[], decimals: number[], deviation: bigint, name: string): void {
  const stock = value(stockAmount, stockIndex, prices, decimals);
  const cash = value(cashAmount, cashIndex, prices, decimals);
  if (!stock || !cash || checkedMul(stock, BPS - deviation, name) > checkedMul(cash, BPS, name) || checkedMul(cash, BPS, name) > checkedMul(stock, BPS + deviation, name)) {
    throw new RangeError(`${name}: stock/cash execution price outside committed band`);
  }
}

function u64Bytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let next = value;
  for (let i = 0; i < 8; i++) { bytes[i] = Number(next & 255n); next >>= 8n; }
  return bytes;
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  if (offset + 8 > bytes.length) throw new TypeError('truncated settlement body');
  let result = 0n;
  for (let i = 7; i >= 0; i--) result = result * 256n + BigInt(bytes[offset + i]);
  return result;
}

/** This is only the fixed on-chain instruction body; no quote or final allocation is encoded. */
export function encodeSettlementBody(body: SettlementBody, batchCount: number): Uint8Array {
  if (batchCount < 1 || batchCount > 3 || !Number.isInteger(batchCount)) throw new RangeError('batch count');
  if (body.schema_version !== '1') throw new TypeError('settlement schema version');
  const crosses = list(body.crosses, 0, 6, 'crosses');
  const residuals = list(body.residuals, 0, 2, 'residuals');
  const bytes: number[] = [1, batchCount, ...u64Bytes(decimal(body.expected_snapshot_sequence, 'snapshot sequence')), crosses.length];
  for (const raw of crosses) {
    const c = record(raw, CROSS_KEYS, 'cross');
    bytes.push(index(c.stock_index, 2, 'stock index'), index(c.seller_index, batchCount - 1, 'seller index'), index(c.buyer_index, batchCount - 1, 'buyer index'),
      ...u64Bytes(decimal(c.stock_quantity, 'stock quantity', MAX_AMOUNT)), ...u64Bytes(decimal(c.cash_amount, 'cash amount', MAX_AMOUNT)));
  }
  bytes.push(residuals.length);
  for (const raw of residuals) {
    const r = record(raw, RESIDUAL_KEYS, 'residual');
    bytes.push(index(r.stock_index, 2, 'stock index'), index(r.direction, 1, 'direction'), ...u64Bytes(decimal(r.minimum_output, 'minimum output', MAX_POOL_AMOUNT)));
    for (const amount of list(r.input_allocations, batchCount, batchCount, 'input allocations')) bytes.push(...u64Bytes(decimal(amount, 'input allocation', MAX_AMOUNT)));
  }
  if (bytes.length > 194) throw new RangeError('settlement body capacity exceeded');
  return Uint8Array.from(bytes);
}

export function decodeSettlementBody(bytes: Uint8Array): { batch_count: number; body: SettlementBody } {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > 194 || bytes[0] !== 1) throw new TypeError('invalid settlement body');
  const batchCount = bytes[1];
  if (batchCount < 1 || batchCount > 3) throw new TypeError('invalid batch count');
  const sequence = readU64(bytes, 2).toString();
  let cursor = 10;
  const crossCount = bytes[cursor++];
  if (crossCount > 6) throw new TypeError('too many crosses');
  const crosses: Cross[] = [];
  for (let i = 0; i < crossCount; i++) {
    if (cursor + 19 > bytes.length) throw new TypeError('truncated cross');
    crosses.push({ stock_index: String(bytes[cursor]), seller_index: String(bytes[cursor + 1]), buyer_index: String(bytes[cursor + 2]), stock_quantity: readU64(bytes, cursor + 3).toString(), cash_amount: readU64(bytes, cursor + 11).toString() });
    cursor += 19;
  }
  if (cursor >= bytes.length) throw new TypeError('truncated residual count');
  const residualCount = bytes[cursor++];
  if (residualCount > 2) throw new TypeError('too many residuals');
  const residuals: Residual[] = [];
  for (let i = 0; i < residualCount; i++) {
    if (cursor + 10 + 8 * batchCount > bytes.length) throw new TypeError('truncated residual');
    const stock_index = String(bytes[cursor]);
    const direction = String(bytes[cursor + 1]);
    const minimum_output = readU64(bytes, cursor + 2).toString();
    cursor += 10;
    const input_allocations = Array.from({ length: batchCount }, () => { const result = readU64(bytes, cursor).toString(); cursor += 8; return result; });
    residuals.push({ stock_index, direction, minimum_output, input_allocations });
  }
  if (cursor !== bytes.length) throw new TypeError('extra settlement body bytes');
  const body: SettlementBody = { schema_version: '1', expected_snapshot_sequence: sequence, crosses, residuals };
  if (encodeSettlementBody(body, batchCount).length !== bytes.length) throw new TypeError('noncanonical settlement body');
  return { batch_count: batchCount, body };
}

function proRata(output: bigint, inputs: bigint[], owners: string[]): bigint[] {
  const total = inputs.reduce((a, b) => checkedAdd(a, b, 'route input', MAX_POOL_AMOUNT), 0n);
  if (!total || !output) throw new RangeError('zero route input or output');
  const base = inputs.map(x => checkedMul(output, x, 'pro-rata product') / total);
  const remainders = inputs.map(x => checkedMul(output, x, 'pro-rata product') % total);
  let leftover = output - base.reduce((a, b) => a + b, 0n);
  const order = inputs.map((x, i) => ({ x, i })).filter(item => item.x > 0n).sort((a, b) => remainders[a.i] === remainders[b.i] ? owners[a.i] < owners[b.i] ? -1 : owners[a.i] > owners[b.i] ? 1 : a.i - b.i : remainders[a.i] > remainders[b.i] ? -1 : 1);
  if (leftover >= BigInt(order.length)) throw new RangeError('invalid pro-rata residue');
  for (const { i } of order) { if (!leftover) break; base[i]++; leftover--; }
  if (base.some((x, i) => inputs[i] > 0n && x === 0n)) throw new RangeError('positive route participant received zero output');
  return base;
}

export async function validateCandidatePlan(planInput: unknown, contextInput: unknown): Promise<ValidatedPlan> {
  // This context must come from a trusted chain/oracle loader. This pure validator checks its internal
  // consistency, but cannot authenticate RPC account ownership or a fixture publisher signature.
  // Take one immutable-in-practice snapshot before the first await; callers may mutate their objects.
  const context = record(structuredClone(contextInput), CONTEXT_KEYS, 'trusted context');
  const untrustedPlan = record(structuredClone(planInput), PLAN_KEYS, 'candidate plan');
  const policy: Policy = parsePolicy(context.policy);
  const genesis = hex32(context.expected_genesis, 'expected genesis');
  if (genesis !== policy.genesis) throw new TypeError('deployment genesis mismatch');
  const now = decimal(context.now_unix_seconds, 'now');
  if (typeof context.technical_probe !== 'boolean') throw new TypeError('technical_probe must be boolean');
  const snapshot = record(context.snapshot, SNAPSHOT_KEYS, 'snapshot');
  if (snapshot.policy_hash !== await sha256Hex(policyBytes(policy)) || snapshot.publisher !== policy.fixture_publisher || snapshot.market_closed !== false) throw new TypeError('fixture snapshot policy, publisher or market state invalid');
  const sequence = decimal(snapshot.sequence, 'snapshot sequence');
  if (!sequence) throw new RangeError('fixture snapshot sequence must be positive');
  const observations = list(snapshot.assets, 3, 3, 'snapshot assets').map((raw, i) => {
    const item = record(raw, OBSERVATION_KEYS, `snapshot.assets[${i}]`);
    if (item.feed_id !== policy.assets[i].feed_id) throw new TypeError(`feed identity mismatch for asset ${i}`);
    const price = decimal(item.price, `price[${i}]`, MAX_AMOUNT);
    const confidence = decimal(item.confidence, `confidence[${i}]`, MAX_AMOUNT);
    const underlying = decimal(item.underlying_observed_at, 'underlying time');
    const published = decimal(item.published_at, 'publication time');
    if (!price || confidence > price || checkedMul(confidence, BPS, 'confidence') > checkedMul(price, decimal(policy.max_confidence_bps, 'confidence bps'), 'confidence')) throw new RangeError(`confidence/price invalid for asset ${i}`);
    const maxFuture = checkedAdd(now, decimal(policy.max_future_skew_seconds, 'future skew'), 'future time', MAX_U64);
    const maxAge = decimal(policy.max_age_seconds, 'max age');
    if (underlying > published || underlying > maxFuture || published > maxFuture || now > checkedAdd(underlying, maxAge, 'underlying age', MAX_U64) || now > checkedAdd(published, maxAge, 'publication age', MAX_U64)) throw new RangeError(`stale or future fixture observation ${i}`);
    return price;
  });
  const cashIndex = index(policy.cash_index, 2, 'cash index');
  if (observations[cashIndex] !== 1_000_000n || (snapshot.assets as Record<string, unknown>[])[cashIndex].confidence !== '0') throw new TypeError('cash fixture price/confidence invalid');
  const intents = list(context.intents, 1, 3, 'intents');
  if (intents.length === 1 && !context.technical_probe) throw new TypeError('single-owner batch requires explicit technical probe');
  const mandates: Mandate[] = [];
  const hashes: string[] = [];
  const funding: bigint[][] = [];
  let previousOwner = '';
  for (let i = 0; i < intents.length; i++) {
    const item = record(intents[i], INTENT_KEYS, `intent[${i}]`);
    const { mandate, hash } = await validateFundedMandate(item.mandate, policy, genesis, now);
    if (item.stored_status !== 'Funded' || item.stored_mandate_hash !== hash || item.stored_nonce !== mandate.nonce) throw new TypeError(`funded state/commitment mismatch for intent ${i}`);
    if (mandate.owner <= previousOwner) throw new TypeError('intents must have unique owners sorted by raw owner bytes');
    previousOwner = mandate.owner;
    const balances = list(item.vault_balances, 3, 3, 'vault balances');
    const booked = list(item.booked_funding, 3, 3, 'booked funding');
    const amounts = mandate.assets.map((a, j) => {
      const f = decimal(a.funding, 'funding', MAX_AMOUNT);
      if (decimal(booked[j], `booked funding[${j}]`, MAX_AMOUNT) !== f) throw new TypeError(`intent ${i} booked funding differs from signed mandate`);
      if (decimal(balances[j], `vault balance[${j}]`) < f) throw new RangeError(`intent ${i} vault balance below booked funding`);
      const prior = decimal(a.funding_reference_price, 'funding reference', MAX_AMOUNT);
      const delta = observations[j] > prior ? observations[j] - prior : prior - observations[j];
      if (checkedMul(delta, BPS, 'reference move') > checkedMul(prior, decimal(policy.max_reference_move_bps, 'reference move bps'), 'reference move')) throw new RangeError(`intent ${i} reference move exceeds committed band`);
      return f;
    });
    mandates.push(mandate); hashes.push(hash); funding.push(amounts);
  }
  const plan = untrustedPlan;
  if (plan.schema_version !== '1' || plan.expected_snapshot_sequence !== sequence.toString()) throw new TypeError('plan schema or snapshot sequence mismatch');
  const requestedHashes = list(plan.mandate_hashes, intents.length, intents.length, 'mandate hashes').map((h, i) => hex32(h, `mandate hash[${i}]`));
  if (requestedHashes.some((hash, i) => hash !== hashes[i])) throw new TypeError('plan mandate commitment mismatch');
  const crosses = list(plan.crosses, 0, 6, 'crosses');
  const residuals = list(plan.residuals, 0, 2, 'residuals');
  const estimatedOutputs = list(plan.estimated_outputs, residuals.length, residuals.length, 'estimated outputs');
  if (residuals.length && policy.route_kind !== '1') throw new TypeError('external route disabled by committed policy');
  const debit = Array.from({ length: intents.length }, () => [0n, 0n, 0n]);
  const credit = Array.from({ length: intents.length }, () => [0n, 0n, 0n]);
  const internalOwed = [0n, 0n, 0n];
  const sides = Array.from({ length: intents.length }, () => [0, 0, 0]);
  const premiums = Array.from({ length: intents.length }, () => 0n);
  const shortfalls = Array.from({ length: intents.length }, () => 0n);
  const owners = mandates.map(m => m.owner);
  const decimals = policy.assets.map(a => index(a.decimals, 9, 'decimals'));
  const crossBps = decimal(policy.max_cross_deviation_bps, 'cross bps', 100n);
  const externalBps = decimal(policy.max_external_deviation_bps, 'external bps', 200n);
  const checkedCrosses: Cross[] = [];
  let priorCross = '';
  for (const raw of crosses) {
    const c = record(raw, CROSS_KEYS, 'cross');
    const stock = index(c.stock_index, 2, 'cross stock index');
    const seller = index(c.seller_index, intents.length - 1, 'seller index');
    const buyer = index(c.buyer_index, intents.length - 1, 'buyer index');
    if (stock === cashIndex || seller === buyer) throw new TypeError('cross stock/counterparty invalid');
    const key = `${stock}${seller}${buyer}`;
    if (key <= priorCross) throw new TypeError('cross records unsorted or duplicated');
    priorCross = key;
    const quantity = decimal(c.stock_quantity, 'stock quantity', MAX_AMOUNT);
    const cash = decimal(c.cash_amount, 'cash amount', MAX_AMOUNT);
    if (!quantity || !cash) throw new RangeError('cross amounts must be positive');
    priceBand(quantity, cash, stock, cashIndex, observations, decimals, crossBps, 'internal cross');
    sides[seller][stock] |= 1; sides[buyer][stock] |= 2;
    debit[seller][stock] = checkedAdd(debit[seller][stock], quantity, 'internal stock debit', MAX_AMOUNT);
    credit[buyer][stock] = checkedAdd(credit[buyer][stock], quantity, 'internal stock credit', MAX_AMOUNT);
    internalOwed[stock] = checkedAdd(internalOwed[stock], quantity, 'internal stock obligation', MAX_POOL_AMOUNT);
    debit[buyer][cashIndex] = checkedAdd(debit[buyer][cashIndex], cash, 'internal cash debit', MAX_AMOUNT);
    credit[seller][cashIndex] = checkedAdd(credit[seller][cashIndex], cash, 'internal cash credit', MAX_AMOUNT);
    internalOwed[cashIndex] = checkedAdd(internalOwed[cashIndex], cash, 'internal cash obligation', MAX_POOL_AMOUNT);
    const premium = value(cash, cashIndex, observations, decimals) - value(quantity, stock, observations, decimals);
    premiums[buyer] += premium; premiums[seller] -= premium;
    checkedCrosses.push({ stock_index: String(stock), seller_index: String(seller), buyer_index: String(buyer), stock_quantity: quantity.toString(), cash_amount: cash.toString() });
  }
  const externalNet = [0n, 0n, 0n];
  const allocations: bigint[][] = [];
  const checkedResiduals: Residual[] = [];
  const checkedEstimates: string[] = [];
  let priorStock = -1;
  for (let r = 0; r < residuals.length; r++) {
    const raw = record(residuals[r], RESIDUAL_KEYS, `residual[${r}]`);
    const stock = index(raw.stock_index, 2, 'residual stock');
    const direction = index(raw.direction, 1, 'residual direction');
    if (stock === cashIndex || stock <= priorStock) throw new TypeError('residuals must be distinct, noncash and sorted');
    priorStock = stock;
    const minimum = decimal(raw.minimum_output, 'minimum output', MAX_POOL_AMOUNT);
    const actual = decimal(estimatedOutputs[r], 'estimated output', MAX_POOL_AMOUNT);
    if (!minimum || actual < minimum) throw new RangeError('route output below positive committed minimum');
    const inputs = list(raw.input_allocations, intents.length, intents.length, 'input allocations').map((x, i) => decimal(x, `input allocation[${i}]`, MAX_AMOUNT));
    const totalInput = inputs.reduce((sum, x) => checkedAdd(sum, x, 'route input', MAX_POOL_AMOUNT), 0n);
    if (!totalInput) throw new RangeError('zero residual input');
    const inputAsset = direction === 0 ? stock : cashIndex;
    const outputAsset = direction === 0 ? cashIndex : stock;
    const outputs = proRata(actual, inputs, owners);
    priceBand(direction === 0 ? totalInput : actual, direction === 0 ? actual : totalInput, stock, cashIndex, observations, decimals, externalBps, 'aggregate external leg');
    for (let i = 0; i < intents.length; i++) {
      if (!inputs[i]) continue;
      sides[i][stock] |= direction === 0 ? 1 : 2;
      debit[i][inputAsset] = checkedAdd(debit[i][inputAsset], inputs[i], 'external debit', MAX_AMOUNT);
      credit[i][outputAsset] = checkedAdd(credit[i][outputAsset], outputs[i], 'external credit', MAX_AMOUNT);
      priceBand(direction === 0 ? inputs[i] : outputs[i], direction === 0 ? outputs[i] : inputs[i], stock, cashIndex, observations, decimals, externalBps, `owner ${i} external execution`);
      shortfalls[i] += value(inputs[i], inputAsset, observations, decimals) - value(outputs[i], outputAsset, observations, decimals);
    }
    externalNet[inputAsset] -= totalInput;
    externalNet[outputAsset] += actual;
    allocations.push(outputs);
    checkedResiduals.push({ stock_index: String(stock), direction: String(direction), minimum_output: minimum.toString(), input_allocations: inputs.map(x => x.toString()) });
    checkedEstimates.push(actual.toString());
  }
  for (let i = 0; i < intents.length; i++) for (let a = 0; a < 3; a++) if (sides[i][a] === 3) throw new TypeError(`owner ${i} buys and sells stock ${a} in one batch`);
  const pool = [0, 1, 2].map(a => debit.reduce((sum, row) => checkedAdd(sum, row[a], 'batch pool intake', MAX_POOL_AMOUNT), 0n));
  for (let r = 0; r < checkedResiduals.length; r++) {
    const leg = checkedResiduals[r];
    const stock = Number(leg.stock_index);
    const inputAsset = leg.direction === '0' ? stock : cashIndex;
    const outputAsset = leg.direction === '0' ? cashIndex : stock;
    const input = leg.input_allocations.reduce((sum, amount) => checkedAdd(sum, BigInt(amount), 'route input', MAX_POOL_AMOUNT), 0n);
    if (pool[inputAsset] < input || pool[inputAsset] - input < internalOwed[inputAsset]) throw new RangeError('route would consume an internal obligation');
    pool[inputAsset] -= input;
    pool[outputAsset] = checkedAdd(pool[outputAsset], BigInt(checkedEstimates[r]), 'intermediate batch pool', MAX_POOL_AMOUNT);
  }
  const final: bigint[][] = [];
  for (let i = 0; i < intents.length; i++) {
    const row = [];
    let beforeValue = 0n, afterValue = 0n;
    for (let a = 0; a < 3; a++) {
      if (debit[i][a] > funding[i][a]) throw new RangeError(`owner ${i} debit exceeds original funding for asset ${a}`);
      const output = checkedAdd(funding[i][a] - debit[i][a], credit[i][a], 'owner output', MAX_AMOUNT);
      const bound = mandates[i].assets[a];
      if (output < decimal(bound.min_output, 'minimum', MAX_AMOUNT) || output > decimal(bound.max_output, 'maximum', MAX_AMOUNT)) throw new RangeError(`owner ${i} final output outside signed bounds for asset ${a}`);
      beforeValue = checkedAdd(beforeValue, value(funding[i][a], a, observations, decimals), 'owner funding value');
      afterValue = checkedAdd(afterValue, value(output, a, observations, decimals), 'owner output value');
      row.push(output);
    }
    if (checkedMul(afterValue, BPS, 'value guard') < checkedMul(beforeValue, BPS - decimal(policy.max_value_loss_bps, 'value loss bps', 200n), 'value guard')) throw new RangeError(`owner ${i} whole-slice loss exceeds policy`);
    if (beforeValue - afterValue !== premiums[i] + shortfalls[i]) throw new Error(`owner ${i} cost attribution identity failed`);
    final.push(row);
  }
  for (let a = 0; a < 3; a++) {
    const sum = (matrix: bigint[][]) => matrix.reduce((acc, row) => checkedAdd(acc, row[a], 'asset aggregate', MAX_POOL_AMOUNT), 0n);
    if (sum(final) !== sum(funding) + externalNet[a] || sum(credit) - sum(debit) !== externalNet[a]) throw new Error(`asset ${a} conservation failed`);
  }
  const accepted: CandidatePlan = { schema_version: '1', expected_snapshot_sequence: sequence.toString(), mandate_hashes: hashes, crosses: checkedCrosses, residuals: checkedResiduals, estimated_outputs: checkedEstimates };
  return { status: 'validated_proposal', requires_onchain_acceptance: true, quote_dependent: residuals.length > 0,
    no_op: crosses.length === 0 && residuals.length === 0,
    settlement_body: encodeSettlementBody(accepted, intents.length), plan: accepted,
    mandate_hashes: hashes, debits: debit.map(row => row.map(x => x.toString())), credits: credit.map(row => row.map(x => x.toString())),
    outputs: final.map(row => row.map(x => x.toString())), external_net: externalNet.map(x => x.toString()),
    residual_output_allocations: allocations.map(row => row.map(x => x.toString())),
    owner_internal_premium_paid: premiums.map(x => x.toString()), owner_external_shortfall: shortfalls.map(x => x.toString()) };
}
