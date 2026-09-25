import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { mandateBytes, policyBytes, sha256Hex } from '../../packages/contracts/src/index.js';
import { canonicalAta } from '../../packages/planner/src/mandate.js';
import { decodeSettlementBody, encodeSettlementBody, validateCandidatePlan } from '../../packages/planner/src/validate.js';
import { buildSettleBatchInstruction, deriveBatchAccounts } from '../../packages/client/src/build-batch.js';
import { attributeCosts } from '../../packages/planner/src/costs.js';
import { Keypair, PublicKey } from '@solana/web3.js';

/**
 * T17 — attack the composed money path.
 *
 * Every case here is a concrete attack against the executable model: a forged total, a relaxed
 * bound, an aliased account, a replay, a stale oracle, an exhausted reserve. Each one must be
 * refused, and — the clause that matters most — each refusal must leave its inputs **unchanged**,
 * because a rejection that mutates state is a partial settlement wearing an error message.
 *
 * The runtime counterparts of these categories are the named rejections in the local transcripts
 * (`verification/evidence/T09*, T16*, T24*, T32*`), which the security matrix indexes.
 */
const wire = JSON.parse(readFileSync('docs/spec/wire-vectors.json', 'utf8'));
const PRICES = ['1000000', '10000000', '20000000'];
/**
 * Three fixed owners in raw-byte order. They are derived rather than hand-picked so they cannot
 * accidentally alias a program or config address, which would make the validator reject a case for
 * the wrong reason and hide what is actually being tested.
 */
const OWNERS: string[] = ['adversarial-owner-0', 'adversarial-owner-1', 'adversarial-owner-2']
  .map((label, index) => Keypair.fromSeed(createHash('sha256').update(label).digest()).publicKey)
  .map(key => key.toBuffer().toString('hex'))
  .sort();

async function fixture(overrides: { policy?: Record<string, unknown>; intents?: number } = {}) {
  const policy = { ...structuredClone(wire.policy), ...(overrides.policy ?? {}) };
  const policyHash = await sha256Hex(policyBytes(policy));
  const count = overrides.intents ?? 3;
  const mandates = OWNERS.slice(0, count).map((owner, index) => ({
    genesis: policy.genesis as string, program_id: policy.program_id as string,
    config_address: policy.config_address as string, schema_version: '1', policy_hash: policyHash,
    owner, nonce: String(index), expiry_unix_seconds: '1100', optimization_commitment: 'ab'.repeat(32),
    assets: (policy.assets as { mint: string; token_program: string; decimals: string }[]).map((asset, assetIndex) => ({
      mint: asset.mint, token_program: asset.token_program, decimals: asset.decimals,
      recipient_ata: canonicalAta(owner, asset.token_program, asset.mint),
      funding: assetIndex === 0 ? '1000000000' : assetIndex === 1 ? '4000000' : '0',
      min_output: '0', max_output: assetIndex === 0 ? '2000000000' : assetIndex === 1 ? '4000000' : '0',
      funding_reference_price: PRICES[assetIndex],
    })),
  }));
  const hashes = await Promise.all(mandates.map(mandate => sha256Hex(mandateBytes(mandate))));
  const context = {
    policy, expected_genesis: policy.genesis, now_unix_seconds: '1000', technical_probe: false,
    snapshot: {
      policy_hash: policyHash, publisher: policy.fixture_publisher, sequence: '7', market_closed: false,
      assets: (policy.assets as { feed_id: string }[]).map((asset, index) => ({
        feed_id: asset.feed_id, price: PRICES[index], confidence: '0',
        underlying_observed_at: '1000', published_at: '1000' })),
    },
    intents: mandates.map((mandate, index) => ({
      mandate, stored_mandate_hash: hashes[index], stored_status: 'Funded', stored_nonce: mandate.nonce,
      booked_funding: mandate.assets.map((asset: { funding: string }) => asset.funding),
      vault_balances: mandate.assets.map((asset: { funding: string }) => asset.funding),
    })),
  };
  return { context, hashes, policy, policyHash };
}

const plan = (crosses: unknown[], hashes: string[], extras: Record<string, unknown> = {}) => ({
  schema_version: '1', expected_snapshot_sequence: '7', mandate_hashes: hashes,
  crosses, residuals: [], estimated_outputs: [], ...extras,
});

const CROSS = { stock_index: '1', seller_index: '0', buyer_index: '1', stock_quantity: '1000000', cash_amount: '10000000' };

/**
 * Every attack runs through this: it must reject, and it must leave the context byte-identical.
 */
async function attack(label: string, candidate: unknown, context: unknown, matcher?: RegExp) {
  const before = JSON.stringify(context);
  const promise = validateCandidatePlan(structuredClone(candidate), context);
  if (matcher) await expect(promise, `${label} must be refused`).rejects.toThrow(matcher);
  else await expect(promise, `${label} must be refused`).rejects.toThrow();
  expect(JSON.stringify(context), `${label} must not mutate the context`).toBe(before);
}

describe('T17 adversarial: forged plans and relaxed bounds', () => {
  test('a plan that inflates outputs beyond its crosses is refused without mutation', async () => {
    const { context, hashes } = await fixture();
    // A caller cannot state outputs at all: the model derives them, so an attempt to supply them
    // is a schema violation rather than a number to be trusted.
    await attack('forged outputs', plan([CROSS], hashes, { outputs: ['9'.repeat(12)] }), context);
  });

  test('a cross priced outside the committed band is refused', async () => {
    const { context, hashes } = await fixture();
    for (const cash of ['1', '99999999']) {
      await attack(`band ${cash}`, plan([{ ...CROSS, cash_amount: cash }], hashes), context, /band|price/i);
    }
  });

  test('a settlement that would breach a signed maximum is refused', async () => {
    const { context, hashes } = await fixture();
    const squeezed = structuredClone(context);
    squeezed.intents[1].mandate.assets[1].max_output = '999999';
    squeezed.intents[1].mandate.assets[1].min_output = '0';
    squeezed.intents[1].stored_mandate_hash = await sha256Hex(mandateBytes(squeezed.intents[1].mandate));
    await attack('breached maximum', plan([CROSS], [hashes[0], squeezed.intents[1].stored_mandate_hash, hashes[2]]), squeezed, /bound|output/i);
  });

  test('a plan naming a mandate hash the context does not hold is refused', async () => {
    const { context, hashes } = await fixture();
    await attack('unknown mandate', plan([CROSS], [hashes[0], 'cd'.repeat(32), hashes[2]]), context);
  });
});

describe('T17 adversarial: aliasing, ordering and replay', () => {
  test('a duplicated owner is refused', async () => {
    const { context, hashes } = await fixture();
    const duplicated = structuredClone(context);
    duplicated.intents[1] = structuredClone(duplicated.intents[0]);
    await attack('duplicate owner', plan([CROSS], [hashes[0], hashes[0], hashes[2]]), duplicated, /unique|sorted|alias/i);
  });

  test('owners out of raw-byte order are refused rather than silently re-indexed', async () => {
    const { context, hashes } = await fixture();
    const reversed = structuredClone(context);
    reversed.intents.reverse();
    await attack('unsorted owners', plan([CROSS], [...hashes].reverse()), reversed, /sorted|unique|alias/i);
  });

  test('crosses out of canonical order, and duplicated, are refused', async () => {
    const { context, hashes } = await fixture();
    await attack('duplicated cross', plan([CROSS, CROSS], hashes), context);
    await attack('unsorted crosses', plan([{ ...CROSS, stock_index: '2' }, CROSS], hashes), context);
  });

  test('an owner cannot sell and buy the same stock in one batch', async () => {
    const { context, hashes } = await fixture();
    await attack('round trip', plan([
      CROSS,
      { stock_index: '1', seller_index: '1', buyer_index: '0', stock_quantity: '1000000', cash_amount: '10000000' },
    ], hashes), context, /buys and sells|sorted|duplicat/i);
  });

  test('a mandate whose recipient is not the owner canonical account is refused', async () => {
    const { context, hashes } = await fixture();
    const substituted = structuredClone(context);
    substituted.intents[0].mandate.assets[0].recipient_ata = canonicalAta('99'.repeat(32), substituted.policy.assets[0].token_program, substituted.policy.assets[0].mint);
    substituted.intents[0].stored_mandate_hash = await sha256Hex(mandateBytes(substituted.intents[0].mandate));
    await attack('substituted recipient', plan([CROSS], [substituted.intents[0].stored_mandate_hash, hashes[1], hashes[2]]), substituted);
  });
});

describe('T17 adversarial: oracle and venue', () => {
  interface MutableContext {
    snapshot: {
      publisher: string; market_closed: boolean; sequence: string;
      assets: { feed_id: string; price: string; confidence: string; underlying_observed_at: string; published_at: string }[];
    };
  }
  const mutate = async (change: (context: MutableContext) => void, matcher?: RegExp) => {
    const { context, hashes } = await fixture();
    const altered = structuredClone(context) as unknown as MutableContext;
    change(altered);
    await attack('oracle', plan([CROSS], hashes), altered as unknown, matcher);
  };

  test('a stale, future, wide-confidence or closed snapshot is refused', async () => {
    await mutate(altered => { altered.snapshot.assets[0].published_at = '10'; }, /age|stale|old|published/i);
    await mutate(altered => { altered.snapshot.assets[0].underlying_observed_at = '99999'; }, /future|skew|observed/i);
    await mutate(altered => { altered.snapshot.assets[0].confidence = '999999999999'; }, /confidence/i);
    await mutate(altered => { altered.snapshot.market_closed = true; }, /market|closed/i);
  });

  test('a snapshot whose publisher or policy does not match is refused', async () => {
    await mutate(altered => { altered.snapshot.publisher = 'ab'.repeat(32); }, /publisher|policy/i);
    await mutate(altered => { altered.snapshot.assets[0].feed_id = 'zz'.repeat(32); }, /feed/i);
  });

  test('a snapshot sequence the plan does not name is refused', async () => {
    const { context, hashes } = await fixture();
    await attack('wrong sequence', plan([CROSS], hashes, { expected_snapshot_sequence: '8' }), context, /sequence/i);
  });
});

describe('T17 adversarial: size and exhaustion', () => {
  test('a body larger than a batch can hold is refused by the encoder', async () => {
    const { context, hashes } = await fixture();
    await attack('too many crosses', plan([CROSS, CROSS, CROSS, CROSS, CROSS, CROSS, { ...CROSS, stock_index: '2' }], hashes), context, /crosses/);
    const empty = { schema_version: '1' as const, expected_snapshot_sequence: '1', crosses: [], residuals: [] };
    // The encoder refuses what it cannot represent. A single participant *is* representable: the
    // program is what requires at least two, which is asserted separately on chain.
    expect(() => encodeSettlementBody(empty, 4)).toThrow(/batch count/i);
    expect(() => encodeSettlementBody(empty, 0)).toThrow(/batch count/i);
    expect(encodeSettlementBody(empty, 1).length).toBeGreaterThan(0);
    expect(() => encodeSettlementBody({ ...empty, crosses: Array(7).fill(CROSS) }, 3)).toThrow(/crosses/i);
    // And the whole body stays inside the protocol's byte budget.
    expect(encodeSettlementBody({ ...empty, crosses: Array(6).fill(CROSS) }, 3).length).toBeLessThanOrEqual(194);
  });

  test('a body with trailing bytes, or a truncated one, is refused by the decoder', async () => {
    const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '7', crosses: [CROSS], residuals: [] }, 2);
    expect(decodeSettlementBody(body).body.crosses).toHaveLength(1);
    expect(() => decodeSettlementBody(new Uint8Array([...body, 0]))).toThrow(/invalid|length|trailing|extra/i);
    expect(() => decodeSettlementBody(body.slice(0, body.length - 1))).toThrow(/invalid|length|truncated|extra/i);
    expect(() => decodeSettlementBody(new Uint8Array([9, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/invalid/i);
  });

  test('a settlement instruction cannot be built past the protocol limits', () => {
    const key = (hex: string) => new PublicKey(Buffer.from(hex.repeat(32), 'hex'));
    const program = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
    const config = key('11');
    const prices = key('22');
    const mints = ['33', '44', '55'].map(key);
    const owners = ['aa', 'bb', 'cc'].map(key);
    const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '1', crosses: [], residuals: [] }, 2);
    expect(() => deriveBatchAccounts(program, config, prices, mints, [])).toThrow(/batch size/i);
    expect(() => deriveBatchAccounts(program, config, prices, mints,
      [owners[0], owners[0]].map(owner => ({ owner, nonce: 0n })))).toThrow(/duplicate/i);
    // Four owners are refused by the builder as well as the encoder, so no path can construct one.
    expect(() => deriveBatchAccounts(program, config, prices, mints,
      [...owners, key('dd')].map(owner => ({ owner, nonce: 0n })))).toThrow(/batch size/i);
    const instruction = buildSettleBatchInstruction(program, deriveBatchAccounts(program, config, prices, mints,
      owners.slice(0, 2).map(owner => ({ owner, nonce: 0n }))), body);
    // The body is bounded, so the instruction cannot grow without limit.
    expect(instruction.data.length).toBeLessThanOrEqual(8 + 4 + 194);
  });
});

describe('T17 adversarial: cost concealment', () => {
  const owners = [OWNERS[0], OWNERS[1], OWNERS[2]].sort();
  const costOwner = (owner: string, external = false) => ({
    owner,
    external_input_raw: external ? ['0', '1000000', '0'] : ['0', '0', '0'],
    external_output_raw: external ? ['10000000', '0', '0'] : ['0', '0', '0'],
    reference_price_micro_usd: PRICES, decimals: ['6', '6', '6'], internal_moved_raw: ['0', '0', '0'],
    transactions: '1', independent_net_micro_usd: '0', planned_net_micro_usd: '0',
  });
  const model = {
    protocol_fee_bps: '0', venue_fee_bps: '30', priority_fee_micro_usd_per_transaction: '18',
    base_fee_micro_usd_per_transaction: '1800', base_fee_lamports_per_transaction: '5000',
    recoverable_rent_lamports: '2000000', irrecoverable_rent_lamports: '0',
    sol_price_micro_usd: '150000000', basis: 'ESTIMATED' as const,
  };

  test('an undeclared fee, a non-zero protocol fee and an unallocated remainder are refused', () => {
    const input = { model, has_residual: true, external_cost_micro_usd: '1000',
      owners: [costOwner(owners[0], true), costOwner(owners[1]), costOwner(owners[2])] };
    expect(() => attributeCosts({ ...input, model: { ...model, protocol_fee_bps: '25' } })).toThrow(/protocol fees at zero/);
    expect(() => attributeCosts({ ...input, model: { ...model, mystery_bps: '1' } })).toThrow(/undisclosed/);
    expect(() => attributeCosts({ ...input, has_residual: false })).toThrow(/internal-only/);
    // Cost that nobody contributed to cannot be attributed, so it is refused rather than dropped.
    expect(() => attributeCosts({ ...input, owners: owners.map(owner => costOwner(owner)) })).toThrow(/every weight is zero/);
    // Every allocation reconciles, so nothing can be left unassigned.
    const report = attributeCosts(input);
    const summed = report.rows.reduce((total, row) => total + BigInt(row.total_cost_micro_usd), 0n);
    expect(summed).toBe(BigInt(report.totals.total_cost_micro_usd));
  });
});
