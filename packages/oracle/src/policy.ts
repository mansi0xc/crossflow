import { policyBytes, sha256Hex } from '../../contracts/src/index.js';

export const MAX_AMOUNT = 1_000_000_000_000n;
export const MAX_PRICE = 1_000_000_000_000n;
const VERIFIED_CONSTRUCTION = Symbol('validated fixture only');
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
export type OracleCode = 'MODE' | 'POLICY' | 'IDENTITY' | 'PUBLISHER' | 'FEED' | 'SEQUENCE' | 'PRICE' | 'TIME' | 'CLOSED' | 'CONFIDENCE' | 'REFERENCE' | 'TRADE' | 'LOSS' | 'ARITHMETIC';
export class OracleError extends Error { constructor(readonly code: OracleCode) { super(`Fixture oracle: ${code}`); } }
function check(ok: boolean, code: OracleCode): asserts ok { if (!ok) throw new OracleError(code); }
function integer(n: bigint, max: bigint, code: OracleCode = 'ARITHMETIC'): bigint { check(typeof n === 'bigint' && n >= 0n && n <= max, code); return n; }
function mul(a: bigint, b: bigint): bigint { return integer(a * b, U128_MAX); }
function hex32(s: string): boolean { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s); }

export interface OracleAsset { readonly mint: string; readonly feedId: string; readonly decimals: number }
export interface OracleBinding {
  readonly config: string; readonly programId: string; readonly policyHash: string; readonly publisher: string;
  readonly mode: number; readonly cashIndex: number; readonly maxAge: bigint; readonly maxFutureSkew: bigint;
  readonly maxConfidenceBps: bigint; readonly maxReferenceMoveBps: bigint; readonly maxValueLossBps: bigint;
  readonly maxCrossDeviationBps: bigint; readonly maxExternalDeviationBps: bigint; readonly assets: readonly OracleAsset[];
}
export interface Observation {
  readonly mint: string; readonly feedId: string; readonly price: bigint; readonly confidence: bigint;
  readonly exponent: number; readonly confidenceKind: number; readonly underlyingObservedAt: bigint;
  readonly publishedAt: bigint; readonly marketClosed: boolean;
}
export interface FixtureSnapshot {
  readonly config: string; readonly policyHash: string; readonly publisher: string; readonly mode: number;
  readonly sequence: bigint; readonly observations: readonly Observation[];
}

/** Resolve exact canonical policy fields, rather than allowing an oracle-specific relaxed policy. */
export async function bindingFromPolicy(input: unknown): Promise<OracleBinding> {
  const copied = structuredClone(input);
  const bytes = policyBytes(copied);
  const p = copied as Record<string, string | Array<Record<string, string>>>;
  const assets = (p.assets as Array<Record<string, string>>).map(a => Object.freeze({ mint: a.mint, feedId: a.feed_id, decimals: Number(a.decimals) }));
  const text = (name: string): string => p[name] as string;
  const binding: OracleBinding = Object.freeze({ config: text('config_address'), programId: text('program_id'), policyHash: await sha256Hex(bytes), publisher: text('fixture_publisher'), mode: Number(text('oracle_mode')), cashIndex: Number(text('cash_index')), maxAge: BigInt(text('max_age_seconds')), maxFutureSkew: BigInt(text('max_future_skew_seconds')), maxConfidenceBps: BigInt(text('max_confidence_bps')), maxReferenceMoveBps: BigInt(text('max_reference_move_bps')), maxValueLossBps: BigInt(text('max_value_loss_bps')), maxCrossDeviationBps: BigInt(text('max_cross_deviation_bps')), maxExternalDeviationBps: BigInt(text('max_external_deviation_bps')), assets: Object.freeze(assets) });
  validateBinding(binding); return binding;
}

export function validateBinding(b: OracleBinding): void {
  check(b.mode === 0, 'MODE');
  check(Number.isInteger(b.cashIndex) && b.cashIndex >= 0 && b.cashIndex < 3 && b.assets.length === 3, 'POLICY');
  for (const s of [b.config, b.programId, b.policyHash, b.publisher]) check(hex32(s) && s !== '00'.repeat(32), 'POLICY');
  for (const [v, maximum] of [[b.maxAge, 60n], [b.maxFutureSkew, 2n], [b.maxConfidenceBps, 100n], [b.maxReferenceMoveBps, 500n], [b.maxValueLossBps, 200n], [b.maxCrossDeviationBps, 100n], [b.maxExternalDeviationBps, 200n]]) integer(v, maximum, 'POLICY');
  check(b.maxAge > 0n, 'POLICY');
  b.assets.forEach((a, i) => {
    check(hex32(a.mint) && hex32(a.feedId) && a.mint !== '00'.repeat(32) && a.feedId !== '00'.repeat(32) && Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 9, 'POLICY');
    if (i > 0) check(b.assets[i - 1].mint < a.mint, 'POLICY');
  });
}
function identity(b: OracleBinding, s: FixtureSnapshot): void {
  validateBinding(b); check(s.mode === 0, 'MODE');
  check(s.config === b.config && s.policyHash === b.policyHash, 'IDENTITY');
  check(s.publisher === b.publisher, 'PUBLISHER');
  integer(s.sequence, U64_MAX, 'SEQUENCE'); check(s.sequence > 0n, 'SEQUENCE');
  check(s.observations.length === 3, 'FEED');
}

/** Pure client mirror. It does not authenticate RPC ownership, signatures, or Pyth data. */
export function validateSnapshot(b: OracleBinding, s: FixtureSnapshot, expectedPolicyHash: string, expectedSequence: bigint, now: bigint): VerifiedPrices {
  return validateCore(b, s, expectedPolicyHash, expectedSequence, now, true);
}

/** Structural publication check permits announcing market closure, without authorizing trading. */
export function validatePublication(b: OracleBinding, s: FixtureSnapshot, now: bigint): void {
  validateCore(b, s, b.policyHash, s.sequence, now, false);
}
function validateCore(b: OracleBinding, s: FixtureSnapshot, expectedPolicyHash: string, expectedSequence: bigint, now: bigint, requireOpen: boolean): VerifiedPrices {
  identity(b, s); check(expectedPolicyHash === b.policyHash, 'IDENTITY');
  integer(expectedSequence, U64_MAX, 'SEQUENCE'); check(s.sequence === expectedSequence, 'SEQUENCE');
  integer(now, (1n << 63n) - 1n, 'TIME');
  const future = integer(now + b.maxFutureSkew, U64_MAX);
  s.observations.forEach((o, i) => {
    check(o.mint === b.assets[i].mint && o.feedId === b.assets[i].feedId, 'FEED');
    integer(o.price, MAX_PRICE, 'PRICE'); integer(o.confidence, o.price, 'PRICE');
    check(o.price > 0n && o.exponent === -6 && o.confidenceKind === 0, 'PRICE');
    check(typeof o.marketClosed === 'boolean', 'CLOSED'); if (requireOpen) check(o.marketClosed === false, 'CLOSED');
    integer(o.underlyingObservedAt, U64_MAX, 'TIME'); integer(o.publishedAt, U64_MAX, 'TIME');
    check(o.underlyingObservedAt <= o.publishedAt, 'TIME');
    for (const timestamp of [o.underlyingObservedAt, o.publishedAt]) {
      const lastValid = integer(timestamp + b.maxAge, U64_MAX);
      check(timestamp <= future && now <= lastValid, 'TIME');
    }
    check(mul(o.confidence, 10_000n) <= mul(o.price, b.maxConfidenceBps), 'CONFIDENCE');
    if (i === b.cashIndex) check(o.price === 1_000_000n && o.confidence === 0n, 'PRICE');
  });
  return new VerifiedPrices(b, s, VERIFIED_CONSTRUCTION);
}

// The module-private construction token prevents callers from bypassing validation. Authority remains in Rust.
export class VerifiedPrices {
  readonly #prices: readonly bigint[];
  readonly #binding: OracleBinding;
  readonly sequence: bigint;
  readonly policyHash: string;
  constructor(b: OracleBinding, s: FixtureSnapshot, token: symbol) {
    check(token === VERIFIED_CONSTRUCTION, 'IDENTITY');
    this.#prices = Object.freeze(s.observations.map(o => o.price));
    this.#binding = Object.freeze({ ...b, assets: Object.freeze(b.assets.map(a => Object.freeze({ ...a }))) });
    this.sequence = s.sequence; this.policyHash = s.policyHash;
  }
  get prices(): readonly bigint[] { return this.#prices; }
  #value(amount: bigint, asset: number, cap = MAX_AMOUNT): bigint {
    integer(amount, cap); check(Number.isInteger(asset) && asset >= 0 && asset < 3, 'ARITHMETIC');
    return mul(mul(amount, this.#prices[asset]), 10n ** BigInt(9 - this.#binding.assets[asset].decimals));
  }
  checkFundingReference(reference: readonly bigint[]): void { check(reference.length === 3 && reference.every((p, i) => p === this.#prices[i]), 'REFERENCE'); }
  checkReferenceMove(reference: readonly bigint[]): void {
    check(reference.length === 3, 'REFERENCE');
    reference.forEach((p0, i) => { integer(p0, MAX_PRICE, 'PRICE'); check(p0 > 0n, 'PRICE'); const difference = this.#prices[i] > p0 ? this.#prices[i] - p0 : p0 - this.#prices[i]; check(mul(difference, 10_000n) <= mul(p0, this.#binding.maxReferenceMoveBps), 'REFERENCE'); });
  }
  #trade(stock: number, quantity: bigint, cash: bigint, bps: bigint, cap: bigint): void {
    check(Number.isInteger(stock) && stock >= 0 && stock < 3 && stock !== this.#binding.cashIndex && quantity > 0n && cash > 0n, 'TRADE');
    const s = this.#value(quantity, stock, cap); const k = mul(this.#value(cash, this.#binding.cashIndex, cap), 10_000n);
    check(mul(s, 10_000n - bps) <= k && k <= mul(s, 10_000n + bps), 'TRADE');
  }
  checkCross(stock: number, q: bigint, k: bigint): void { this.#trade(stock, q, k, this.#binding.maxCrossDeviationBps, MAX_AMOUNT); }
  checkExternalFill(stock: number, q: bigint, k: bigint): void { this.#trade(stock, q, k, this.#binding.maxExternalDeviationBps, MAX_AMOUNT); }
  checkExternalTotal(stock: number, q: bigint, k: bigint): void { this.#trade(stock, q, k, this.#binding.maxExternalDeviationBps, 3n * MAX_AMOUNT); }
  checkValueLoss(funding: readonly bigint[], outputs: readonly bigint[]): void {
    check(funding.length === 3 && outputs.length === 3, 'ARITHMETIC');
    const sum = (amounts: readonly bigint[]): bigint => amounts.reduce((total, amount, i) => integer(total + this.#value(amount, i), U128_MAX), 0n);
    check(mul(sum(outputs), 10_000n) >= mul(sum(funding), 10_000n - this.#binding.maxValueLossBps), 'LOSS');
  }
}

/** Checks update content only. A matching address here is not a cryptographic signature. */
export function validateUpdate(b: OracleBinding, previous: FixtureSnapshot, candidate: FixtureSnapshot, requestedPublisher: string, now: bigint): void {
  identity(b, previous); check(requestedPublisher === b.publisher, 'PUBLISHER');
  check(candidate.sequence === integer(previous.sequence + 1n, U64_MAX, 'SEQUENCE'), 'SEQUENCE');
  candidate.observations.forEach((o, i) => {
    check(i < 3 && o.underlyingObservedAt >= previous.observations[i].underlyingObservedAt && o.publishedAt >= previous.observations[i].publishedAt, 'SEQUENCE');
  });
  validatePublication(b, candidate, now);
}
