import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { bindingFromPolicy, validateSnapshot, validateUpdate, type FixtureSnapshot, type Observation, type OracleBinding } from '../../packages/oracle/src/policy.js';
import { initialFixture, proposeFixtureUpdate, FIXTURE_LABEL } from '../../packages/oracle/src/fixture.js';
const vectors = JSON.parse(readFileSync(new URL('../../docs/spec/wire-vectors.json', import.meta.url), 'utf8'));
async function fixture() {
  const b = await bindingFromPolicy(vectors.policy);
  const observations: Observation[] = b.assets.map((a, i) => ({ mint: a.mint, feedId: a.feedId, price: [1_000_000n, 10_000_000n, 20_000_000n][i], confidence: 0n, exponent: -6, confidenceKind: 0, underlyingObservedAt: 100n, publishedAt: 100n, marketClosed: false }));
  return { b, s: initialFixture(b, observations, 100n) };
}
function guard(b: OracleBinding, s: FixtureSnapshot, now = 100n) { return validateSnapshot(b, s, b.policyHash, s.sequence, now); }
function edited(s: FixtureSnapshot, index: number, change: Partial<Observation>): FixtureSnapshot { return { ...s, observations: s.observations.map((o, i) => i === index ? { ...o, ...change } : o) }; }
describe('T14 labelled fixture reference guard', () => {
  it('binds the exact canonical policy hash and copies immutable verified prices', async () => {
    const { b, s } = await fixture(); expect(b.policyHash).toBe(vectors.policy_sha256);
    const p = guard(b, s); expect(p.prices).toEqual([1_000_000n, 10_000_000n, 20_000_000n]);
    expect(FIXTURE_LABEL).toContain('TEST PRICES'); expect(() => validateSnapshot(b, s, '00'.repeat(32), 1n, 100n)).toThrow('IDENTITY');
  });
  it('copies policy before asynchronous hashing so later caller mutation cannot change its meaning', async () => {
    const policy = structuredClone(vectors.policy); const original = policy.fixture_publisher;
    const pending = bindingFromPolicy(policy); policy.fixture_publisher = '99'.repeat(32);
    const binding = await pending; expect(binding.publisher).toBe(original); expect(binding.policyHash).toBe(vectors.policy_sha256);
  });
  it('accepts exact age and future-skew boundaries but rejects one unit outside', async () => {
    const { b, s } = await fixture(); expect(() => guard(b, s, 160n)).not.toThrow(); expect(() => guard(b, s, 161n)).toThrow('TIME');
    expect(() => guard(b, edited(s, 1, { underlyingObservedAt: 102n, publishedAt: 102n }))).not.toThrow();
    expect(() => guard(b, edited(s, 1, { publishedAt: 103n }))).toThrow('TIME');
    expect(() => guard(b, edited(s, 1, { underlyingObservedAt: 102n, publishedAt: 101n }))).toThrow('TIME');
    expect(() => guard(b, edited(s, 1, { publishedAt: 161n }), 161n)).toThrow('TIME');
    expect(() => guard(b, s, -1n)).toThrow('TIME');
  });
  it('enforces confidence equality, exponent, interpretation and cash identity', async () => {
    const { b, s } = await fixture(); expect(() => guard(b, edited(s, 1, { confidence: 100_000n }))).not.toThrow();
    expect(() => guard(b, edited(s, 1, { confidence: 100_001n }))).toThrow('CONFIDENCE');
    for (const change of [{ exponent: -8 }, { confidenceKind: 1 }, { price: 0n }, { price: 1_000_000_000_001n }, { confidence: 10_000_001n }]) expect(() => guard(b, edited(s, 1, change))).toThrow();
    expect(() => guard(b, edited(s, 0, { price: 999_999n }))).toThrow('PRICE');
  });
  it('rejects mode/source/feed/sequence and market substitution', async () => {
    const { b, s } = await fixture();
    expect(() => guard(b, { ...s, mode: 1 })).toThrow('MODE');
    expect(() => guard({ ...b, mode: 1 }, s)).toThrow('MODE');
    expect(() => guard(b, { ...s, publisher: '00'.repeat(32) })).toThrow('PUBLISHER');
    expect(() => guard(b, { ...s, config: '00'.repeat(32) })).toThrow('IDENTITY');
    expect(() => guard(b, edited(s, 1, { feedId: '00'.repeat(32) }))).toThrow('FEED');
    expect(() => guard(b, edited(s, 1, { marketClosed: true }))).toThrow('CLOSED');
    expect(() => validateSnapshot(b, s, b.policyHash, 2n, 100n)).toThrow('SEQUENCE');
    expect(() => guard(b, { ...s, observations: s.observations.slice(0, 2) })).toThrow('FEED');
  });
  it.each(vectors.price_guard_vectors as Array<Record<string, string | boolean>>)('cross-language price vector $id', async (v) => {
    const { b, s } = await fixture(); const external = String(v.id).startsWith('external');
    const modified: OracleBinding = { ...b, maxCrossDeviationBps: external ? b.maxCrossDeviationBps : BigInt(String(v.deviation_bps)), assets: b.assets.map((a, i) => ({ ...a, decimals: Number(i === 0 ? v.cash_decimals : i === 1 ? v.stock_decimals : a.decimals) })) };
    const p = guard(modified, s); const run = () => external ? p.checkExternalFill(1, BigInt(String(v.stock_quantity)), BigInt(String(v.cash_amount))) : p.checkCross(1, BigInt(String(v.stock_quantity)), BigInt(String(v.cash_amount)));
    if (v.expected_accept) expect(run).not.toThrow(); else expect(run).toThrow('TRADE');
  });
  it('rejects a $10 share crossed for $11 despite whole-slice loss passing', async () => {
    const { b, s } = await fixture(); const p = guard(b, s);
    expect(() => p.checkValueLoss([1_000_000_000n, 0n, 0n], [989_000_000n, 1_000_000n, 0n])).not.toThrow();
    expect(() => p.checkCross(1, 1_000_000n, 11_000_000n)).toThrow('TRADE');
    expect(() => p.checkValueLoss([10_000n, 0n, 0n], [9800n, 0n, 0n])).not.toThrow();
    expect(() => p.checkValueLoss([10_000n, 0n, 0n], [9799n, 0n, 0n])).toThrow('LOSS');
  });
  it('checks exact funding references and movement at equality/one unit outside', async () => {
    const { b, s } = await fixture(); const original = guard(b, s);
    expect(() => original.checkFundingReference([1_000_000n, 10_000_000n, 20_000_000n])).not.toThrow();
    expect(() => original.checkFundingReference([1_000_000n, 10_000_001n, 20_000_000n])).toThrow('REFERENCE');
    expect(() => guard(b, edited(s, 1, { price: 10_500_000n })).checkReferenceMove(original.prices)).not.toThrow();
    expect(() => guard(b, edited(s, 1, { price: 10_500_001n })).checkReferenceMove(original.prices)).toThrow('REFERENCE');
  });
  it('checks configured publisher address, exact next sequence and non-regressing timestamps', async () => {
    const { b, s } = await fixture(); const next = proposeFixtureUpdate(b, s, s.observations, b.publisher, 100n); expect(next.sequence).toBe(2n);
    expect(() => proposeFixtureUpdate(b, s, s.observations, '00'.repeat(32), 100n)).toThrow('PUBLISHER');
    expect(() => validateUpdate(b, s, { ...next, sequence: 3n }, b.publisher, 100n)).toThrow('SEQUENCE');
    expect(() => proposeFixtureUpdate(b, s, edited(s, 1, { underlyingObservedAt: 99n }).observations, b.publisher, 100n)).toThrow('SEQUENCE');
    expect(() => proposeFixtureUpdate(b, { ...s, sequence: (1n << 64n) - 1n }, s.observations, b.publisher, 100n)).toThrow('SEQUENCE');
    expect(s.sequence).toBe(1n);
  });
  it('allows closure publication, rejects trading while closed, and permits reopening', async () => {
    const { b, s } = await fixture(); const closed = proposeFixtureUpdate(b, s, edited(s, 1, { marketClosed: true }).observations, b.publisher, 100n);
    expect(() => guard(b, closed)).toThrow('CLOSED');
    const reopened = proposeFixtureUpdate(b, closed, s.observations, b.publisher, 100n); expect(() => guard(b, reopened)).not.toThrow();
  });
  it('rejects unsafe quantities, invalid policies and timestamp overflow', async () => {
    const { b, s } = await fixture(); const p = guard(b, s);
    expect(() => p.checkCross(1, 0n, 1n)).toThrow('TRADE'); expect(() => p.checkCross(0, 1n, 1n)).toThrow('TRADE');
    expect(() => p.checkCross(1, 1_000_000_000_001n, 1n)).toThrow('ARITHMETIC');
    expect(() => guard({ ...b, maxCrossDeviationBps: 101n }, s)).toThrow('POLICY');
    expect(() => guard(b, edited(s, 1, { underlyingObservedAt: (1n << 64n) - 1n, publishedAt: (1n << 64n) - 1n }))).toThrow('ARITHMETIC');
    expect(() => guard(b, edited(s, 1, { price: 10_000_000 as unknown as bigint }))).toThrow('PRICE');
  });
});
