/**
 * T17 property tests over the executable accounting model.
 *
 * These are deterministic and seeded: the same seed always generates the same portfolios, so a
 * failure is reproducible from the printed seed alone. Every accepted plan is re-checked against
 * conservation, the signed per-asset bounds and the canonical body encoding rather than trusting
 * the validator's own verdict.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { mandateBytes, policyBytes, sha256Hex } from '../../packages/contracts/src/index.js';
import { canonicalAta } from '../../packages/planner/src/mandate.js';
import { decodeSettlementBody, encodeSettlementBody, validateCandidatePlan } from '../../packages/planner/src/validate.js';

const wire = JSON.parse(readFileSync('docs/spec/wire-vectors.json', 'utf8'));
const differential = JSON.parse(readFileSync('tests/planner/differential-vectors.json', 'utf8'));
const PRICES = ['1000000', '10000000', '20000000'];
const SEED = 0x5eed_1707;

/** mulberry32: small, deterministic, and enough for bounded property generation. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function fixture(owners: string[], overrides: { cashFunding?: string; stockFunding?: string } = {}) {
  const policy = structuredClone(wire.policy);
  const policyHash = await sha256Hex(policyBytes(policy));
  const cashFunding = overrides.cashFunding ?? '1000000000';
  const stockFunding = overrides.stockFunding ?? '1000000';
  const mandates = owners.map((owner, i) => ({
    genesis: policy.genesis, program_id: policy.program_id, config_address: policy.config_address,
    schema_version: '1', policy_hash: policyHash, owner, nonce: String(i), expiry_unix_seconds: '1100',
    optimization_commitment: 'ab'.repeat(32),
    assets: policy.assets.map((asset: Record<string, unknown>, j: number) => ({
      mint: asset.mint, token_program: asset.token_program, decimals: asset.decimals,
      recipient_ata: canonicalAta(owner, String(asset.token_program), String(asset.mint)),
      funding: j === 0 ? cashFunding : j === 1 ? stockFunding : '0',
      min_output: '0', max_output: j === 0 ? '2000000000' : '2000000',
      funding_reference_price: PRICES[j],
    })),
  }));
  const hashes = await Promise.all(mandates.map(mandate => sha256Hex(mandateBytes(mandate))));
  const context = {
    policy, expected_genesis: policy.genesis, now_unix_seconds: '1000', technical_probe: false,
    snapshot: { policy_hash: policyHash, publisher: policy.fixture_publisher, sequence: '7', market_closed: false,
      assets: policy.assets.map((asset: Record<string, unknown>, i: number) => ({
        feed_id: asset.feed_id, price: PRICES[i], confidence: '0', underlying_observed_at: '1000', published_at: '1000' })) },
    intents: mandates.map((mandate, i) => ({ mandate, stored_mandate_hash: hashes[i], stored_status: 'Funded',
      stored_nonce: mandate.nonce, booked_funding: mandate.assets.map((asset: Record<string, string>) => asset.funding),
      vault_balances: mandate.assets.map((asset: Record<string, string>) => asset.funding) })),
  };
  return { context, hashes };
}

function plan(crosses: unknown[], hashes: string[]) {
  return { schema_version: '1', expected_snapshot_sequence: '7', mandate_hashes: hashes,
    crosses, residuals: [], estimated_outputs: [] };
}

describe('T17 property tests — accounting invariants hold across generated portfolios', () => {
  const owners = differential.owner_public_keys_hex as string[];

  test('every accepted plan conserves each mint and stays inside the signed bounds', async () => {
    const { context, hashes } = await fixture(owners);
    const random = rng(SEED);
    let accepted = 0;
    let rejected = 0;
    for (let iteration = 0; iteration < 60; iteration++) {
      // Quantity in [1, 1_000_000) raw stock; cash around the 10:1 reference inside the ±100 bps band.
      const quantity = BigInt(1 + Math.floor(random() * 999_999));
      const drift = Math.floor(random() * 261) - 130; // some draws fall outside the 100 bps band on purpose
      const cash = quantity * 10n + (quantity * 10n * BigInt(drift)) / 10_000n;
      const candidate = plan([{ stock_index: '1', seller_index: '0', buyer_index: '1',
        stock_quantity: quantity.toString(), cash_amount: cash.toString() }], hashes);
      let result;
      try { result = await validateCandidatePlan(candidate, context); }
      catch (error) {
        rejected++;
        expect(String(error)).toMatch(/band|bounds|integer|owner|invalid/i);
        continue;
      }
      accepted++;
      const funding = context.intents.map(intent => intent.mandate.assets.map((asset: Record<string, string>) => BigInt(asset.funding)));
      for (let a = 0; a < 3; a++) {
        const sumDebit = result.debits.reduce((sum: bigint, row: string[]) => sum + BigInt(row[a]), 0n);
        const sumCredit = result.credits.reduce((sum: bigint, row: string[]) => sum + BigInt(row[a]), 0n);
        expect(sumDebit).toBe(sumCredit);
        for (let i = 0; i < 2; i++) {
          const output = BigInt(result.outputs[i][a]);
          const bound = context.intents[i].mandate.assets[a];
          expect(output).toBeGreaterThanOrEqual(BigInt(bound.min_output));
          expect(output).toBeLessThanOrEqual(BigInt(bound.max_output));
          expect(output).toBe(funding[i][a] - BigInt(result.debits[i][a]) + BigInt(result.credits[i][a]));
        }
      }
      const decoded = decodeSettlementBody(result.settlement_body);
      expect(decoded.batch_count).toBe(2);
      expect(encodeSettlementBody(decoded.body, decoded.batch_count)).toEqual(result.settlement_body);
    }
    expect(accepted).toBeGreaterThan(30);
    expect(rejected).toBeGreaterThan(0);
  });

  test('the same input always produces the same plan and the same body', async () => {
    const { context, hashes } = await fixture(owners);
    const candidate = plan([{ stock_index: '1', seller_index: '0', buyer_index: '1',
      stock_quantity: '1000000', cash_amount: '10000000' }], hashes);
    const first = await validateCandidatePlan(candidate, context);
    const second = await validateCandidatePlan(candidate, context);
    expect(Buffer.from(first.settlement_body).toString('hex')).toBe(Buffer.from(second.settlement_body).toString('hex'));
    expect(first.outputs).toEqual(second.outputs);
    expect(first.debits).toEqual(second.debits);
  });

  test('one raw cash unit outside either side of the cross band is rejected', async () => {
    const { context, hashes } = await fixture(owners);
    const base = { stock_index: '1', seller_index: '0', buyer_index: '1', stock_quantity: '1000000' };
    for (const cash of ['9899999', '10100001']) {
      await expect(validateCandidatePlan(plan([{ ...base, cash_amount: cash }], hashes), context)).rejects.toThrow('internal cross');
    }
    for (const cash of ['9900000', '10100000']) {
      await expect(validateCandidatePlan(plan([{ ...base, cash_amount: cash }], hashes), context)).resolves.toHaveProperty('outputs');
    }
  });

  test('reversing the owner order is rejected rather than silently re-indexed', async () => {
    const { context, hashes } = await fixture(owners);
    const reversed = structuredClone(context);
    reversed.intents = [...reversed.intents].reverse();
    await expect(validateCandidatePlan(plan([{ stock_index: '1', seller_index: '0', buyer_index: '1',
      stock_quantity: '1000000', cash_amount: '10000000' }], hashes), reversed)).rejects.toThrow('sorted');
  });

  test('a plan cannot make an owner both buy and sell the same stock', async () => {
    const { context, hashes } = await fixture(owners);
    await expect(validateCandidatePlan(plan([
      { stock_index: '1', seller_index: '0', buyer_index: '1', stock_quantity: '1000000', cash_amount: '10000000' },
      { stock_index: '1', seller_index: '1', buyer_index: '0', stock_quantity: '500000', cash_amount: '5000000' },
    ], hashes), context)).rejects.toThrow(/sorted|duplicated|buys and sells/);
  });

  test('a partially funded slice cannot satisfy a minimum it never funded', async () => {
    const { context, hashes } = await fixture(owners);
    const starved = structuredClone(context);
    starved.intents[1].mandate.assets[1].min_output = '3000000';
    starved.intents[1].mandate.assets[1].max_output = '3000000';
    starved.intents[1].stored_mandate_hash = await sha256Hex(mandateBytes(starved.intents[1].mandate));
    const rebuilt = await sha256Hex(mandateBytes(starved.intents[1].mandate));
    await expect(validateCandidatePlan(plan([{ stock_index: '1', seller_index: '0', buyer_index: '1',
      stock_quantity: '1000000', cash_amount: '10000000' }], [hashes[0], rebuilt]), starved)).rejects.toThrow(/bounds|minimum/i);
  });
});
