import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { mandateBytes, policyBytes, sha256Hex } from '../../packages/contracts/src/index.js';
import { canonicalAta, deriveReviewableRawBounds } from '../../packages/planner/src/mandate.js';
import { decodeSettlementBody, encodeSettlementBody, validateCandidatePlan } from '../../packages/planner/src/validate.js';

const wire = JSON.parse(readFileSync('docs/spec/wire-vectors.json', 'utf8'));
const differential = JSON.parse(readFileSync('tests/planner/differential-vectors.json', 'utf8'));

async function fixture(route = false) {
  const policy = structuredClone(wire.policy);
  if (route) {
    policy.route_kind = '1'; policy.max_route_legs = '2';
    policy.route_program = '71'.repeat(32); policy.pool = '72'.repeat(32); policy.pool_authority = '73'.repeat(32);
    policy.route_vaults = ['74'.repeat(32), '75'.repeat(32), '76'.repeat(32)];
  }
  const policyHash = await sha256Hex(policyBytes(policy));
  const owners: string[] = differential.owner_public_keys_hex;
  const prices = ['1000000', '10000000', '20000000'];
  const mandates = owners.map((owner, i) => ({
    genesis: policy.genesis, program_id: policy.program_id, config_address: policy.config_address,
    schema_version: '1', policy_hash: policyHash, owner, nonce: String(i), expiry_unix_seconds: '1100',
    optimization_commitment: 'ab'.repeat(32),
    assets: policy.assets.map((a: any, j: number) => ({ mint: a.mint, token_program: a.token_program, decimals: a.decimals,
      recipient_ata: canonicalAta(owner, a.token_program, a.mint),
      funding: j === 0 ? '1000000000' : j === 1 ? '1000000' : '0',
      min_output: '0', max_output: j === 0 ? '2000000000' : '2000000', funding_reference_price: prices[j] }))
  }));
  const hashes = await Promise.all(mandates.map(m => sha256Hex(mandateBytes(m))));
  const context = {
    policy, expected_genesis: policy.genesis, now_unix_seconds: '1000', technical_probe: false,
    snapshot: { policy_hash: policyHash, publisher: policy.fixture_publisher, sequence: '7', market_closed: false,
      assets: policy.assets.map((a: any, i: number) => ({ feed_id: a.feed_id, price: prices[i], confidence: '0', underlying_observed_at: '1000', published_at: '1000' })) },
    intents: mandates.map((mandate, i) => ({ mandate, stored_mandate_hash: hashes[i], stored_status: 'Funded', stored_nonce: mandate.nonce,
      booked_funding: mandate.assets.map((a: any) => a.funding),
      vault_balances: mandate.assets.map((a: any) => a.funding) }))
  };
  const plan = {
    schema_version: '1' as const, expected_snapshot_sequence: '7', mandate_hashes: hashes,
    crosses: [{ stock_index: '1', seller_index: '0', buyer_index: '1', stock_quantity: '1000000', cash_amount: '10000000' }],
    residuals: [] as any[], estimated_outputs: [] as string[]
  };
  return { context, plan };
}

describe('T11 solver-independent raw-unit validator', () => {
  test('derives the only permissible debits, credits, outputs and exact body from a fair cross', async () => {
    const { context, plan } = await fixture();
    const accepted = await validateCandidatePlan(plan, context);
    expect(accepted.status).toBe('validated_proposal');
    expect(accepted.requires_onchain_acceptance).toBe(true);
    expect(accepted.quote_dependent).toBe(false);
    expect(accepted.debits).toEqual([['0', '1000000', '0'], ['10000000', '0', '0']]);
    expect(accepted.credits).toEqual([['10000000', '0', '0'], ['0', '1000000', '0']]);
    expect(accepted.outputs).toEqual([['1010000000', '0', '0'], ['990000000', '2000000', '0']]);
    expect(accepted.external_net).toEqual(['0', '0', '0']);
    expect(accepted.owner_internal_premium_paid).toEqual(['0', '0']);
    const decoded = decodeSettlementBody(accepted.settlement_body);
    expect(decoded.batch_count).toBe(2);
    expect(decoded.body).toEqual({ schema_version: '1', expected_snapshot_sequence: '7', crosses: plan.crosses, residuals: [] });
    expect(encodeSettlementBody(decoded.body, decoded.batch_count)).toEqual(accepted.settlement_body);
    expect(() => decodeSettlementBody(Uint8Array.from([...accepted.settlement_body, 0]))).toThrow('extra');
  });

  for (const vector of differential.cases) {
    test(`frozen differential candidate ${vector.id}`, async () => {
      const { context, plan } = await fixture();
      plan.crosses = vector.crosses;
      const candidate = { ...plan, ...(vector.untrusted_extra_field ?? {}) };
      if (vector.expected_accept) {
        const result = await validateCandidatePlan(candidate, context);
        expect(Buffer.from(result.settlement_body).toString('hex')).toBe(vector.expected_settlement_body_hex);
        expect(result.debits).toEqual(vector.expected_debits);
        expect(result.outputs).toEqual(vector.expected_outputs);
      }
      else await expect(validateCandidatePlan(candidate, context)).rejects.toThrow(vector.expected_reason);
    });
  }

  test('rejects forged totals, relaxed bounds, changed recipient, stale nonce and wrong domain', async () => {
    const { context, plan } = await fixture();
    await expect(validateCandidatePlan({ ...plan, credits: [['999999999999']] }, context)).rejects.toThrow('extra');
    const relaxed = structuredClone(context); relaxed.intents[0].mandate.assets[1].max_output = '999999999999';
    await expect(validateCandidatePlan(plan, relaxed)).rejects.toThrow('commitment mismatch');
    const recipient = structuredClone(context); recipient.intents[0].mandate.assets[0].recipient_ata = 'ee'.repeat(32);
    recipient.intents[0].stored_mandate_hash = await sha256Hex(mandateBytes(recipient.intents[0].mandate));
    await expect(validateCandidatePlan(plan, recipient)).rejects.toThrow('recipient ATA');
    const nonce = structuredClone(context); nonce.intents[0].stored_nonce = '100';
    await expect(validateCandidatePlan(plan, nonce)).rejects.toThrow('state/commitment');
    const domain = structuredClone(context); domain.expected_genesis = 'ff'.repeat(32);
    await expect(validateCandidatePlan(plan, domain)).rejects.toThrow('genesis');
    const wrongPolicy = structuredClone(context); wrongPolicy.intents[0].mandate.policy_hash = 'ff'.repeat(32);
    wrongPolicy.intents[0].stored_mandate_hash = await sha256Hex(mandateBytes(wrongPolicy.intents[0].mandate));
    await expect(validateCandidatePlan(plan, wrongPolicy)).rejects.toThrow('policy mismatch');
  });

  test('accepts exact cross-price boundaries and rejects one raw cash unit outside either side', async () => {
    const { context, plan } = await fixture();
    for (const cash of ['9900000', '10100000']) {
      plan.crosses[0].cash_amount = cash;
      await expect(validateCandidatePlan(plan, context)).resolves.toHaveProperty('outputs');
    }
    for (const cash of ['9899999', '10100001']) {
      plan.crosses[0].cash_amount = cash;
      await expect(validateCandidatePlan(plan, context)).rejects.toThrow('internal cross');
    }
  });

  test('the specified $10/$11 exchange is rejected even though the buyer loses only 10 bps on its funded slice', async () => {
    const { context, plan } = await fixture();
    context.intents[1].mandate.assets[1].funding = '0';
    context.intents[1].booked_funding[1] = '0';
    context.intents[1].vault_balances[1] = '0';
    const changedHash = await sha256Hex(mandateBytes(context.intents[1].mandate));
    context.intents[1].stored_mandate_hash = changedHash;
    plan.mandate_hashes[1] = changedHash;
    plan.crosses[0].cash_amount = '11000000';
    // Buyer: 1,000 cash becomes 989 cash + one share at the $10 reference = $999.
    expect((1_000_000_000n - (989_000_000n + 10_000_000n)) * 10_000n / 1_000_000_000n).toBe(10n);
    await expect(validateCandidatePlan(plan, context)).rejects.toThrow('internal cross');
  });

  test('rejects reverse owner order, missed snapshot sequence, expired reference band and false funding status', async () => {
    const { context, plan } = await fixture();
    const reverse = structuredClone(context); reverse.intents.reverse();
    await expect(validateCandidatePlan(plan, reverse)).rejects.toThrow('sorted');
    await expect(validateCandidatePlan({ ...plan, expected_snapshot_sequence: '8' }, context)).rejects.toThrow('sequence');
    const moved = structuredClone(context); moved.snapshot.assets[1].price = '10600000';
    await expect(validateCandidatePlan(plan, moved)).rejects.toThrow('reference move');
    const state = structuredClone(context); state.intents[0].stored_status = 'Cancelled';
    await expect(validateCandidatePlan(plan, state)).rejects.toThrow('state/commitment');
  });

  test('rejects unsafe numbers, stale/uncommitted fixture state, expiry and unfunded vaults', async () => {
    const { context, plan } = await fixture();
    await expect(validateCandidatePlan({ ...plan, expected_snapshot_sequence: NaN }, context)).rejects.toThrow();
    await expect(validateCandidatePlan({ ...plan, crosses: [{ ...plan.crosses[0], cash_amount: 10_000_000 }] }, context)).rejects.toThrow('canonical');
    const stale = structuredClone(context); stale.snapshot.assets[1].underlying_observed_at = '939';
    await expect(validateCandidatePlan(plan, stale)).rejects.toThrow('stale');
    const feed = structuredClone(context); feed.snapshot.assets[1].feed_id = 'ff'.repeat(32);
    await expect(validateCandidatePlan(plan, feed)).rejects.toThrow('feed identity');
    const closed = structuredClone(context); closed.snapshot.market_closed = true;
    await expect(validateCandidatePlan(plan, closed)).rejects.toThrow('snapshot');
    const expired = structuredClone(context); expired.now_unix_seconds = '1100';
    for (const observation of expired.snapshot.assets) { observation.underlying_observed_at = '1100'; observation.published_at = '1100'; }
    await expect(validateCandidatePlan(plan, expired)).rejects.toThrow('expired');
    const unfunded = structuredClone(context); unfunded.intents[0].vault_balances[1] = '999999';
    await expect(validateCandidatePlan(plan, unfunded)).rejects.toThrow('below booked funding');
    const forgedBooking = structuredClone(context); forgedBooking.intents[0].booked_funding[1] = '999999';
    await expect(validateCandidatePlan(plan, forgedBooking)).rejects.toThrow('booked funding');
    await expect(validateCandidatePlan({ ...plan, crosses: [{ ...plan.crosses[0], stock_quantity: Infinity }] }, context)).rejects.toThrow('canonical');
    await expect(validateCandidatePlan({ ...plan, crosses: [{ ...plan.crosses[0], stock_quantity: 9_007_199_254_740_993 }] }, context)).rejects.toThrow('canonical');
  });

  test('pro-rata estimate is explicit and quote-dependent; a disabled route fails closed', async () => {
    const { context, plan } = await fixture(true);
    plan.crosses = [];
    plan.residuals = [{ stock_index: '1', direction: '0', minimum_output: '2000', input_allocations: ['100', '100'] }];
    plan.estimated_outputs = ['2001'];
    const result = await validateCandidatePlan(plan, context);
    expect(result.status).toBe('validated_proposal');
    expect(result.requires_onchain_acceptance).toBe(true);
    expect(result.quote_dependent).toBe(true);
    expect(Buffer.from(differential.owner_public_keys_hex[0], 'hex').compare(Buffer.from(differential.owner_public_keys_hex[1], 'hex'))).toBeLessThan(0);
    expect(differential.pro_rata_equal_remainder_tie.priority).toBe('ascending raw owner public-key bytes');
    expect(result.residual_output_allocations).toEqual([differential.pro_rata_equal_remainder_tie.expected_allocations]);
    expect(result.external_net).toEqual(['2001', '-200', '0']);
    expect(decodeSettlementBody(result.settlement_body).body.residuals).toEqual(plan.residuals);
    const badQuote = structuredClone(plan); badQuote.estimated_outputs = ['1999'];
    await expect(validateCandidatePlan(badQuote, context)).rejects.toThrow('minimum');
    const disabled = await fixture();
    disabled.plan.crosses = []; disabled.plan.residuals = plan.residuals; disabled.plan.estimated_outputs = plan.estimated_outputs;
    await expect(validateCandidatePlan(disabled.plan, disabled.context)).rejects.toThrow('disabled');
  });

  test('no-op proposal has zero attributed execution and never claims chain acceptance', async () => {
    const { context, plan } = await fixture();
    plan.crosses = [];
    const result = await validateCandidatePlan(plan, context);
    expect(result.no_op).toBe(true);
    expect(result.status).toBe('validated_proposal');
    expect(result.requires_onchain_acceptance).toBe(true);
    expect(result.owner_internal_premium_paid).toEqual(['0', '0']);
    expect(result.owner_external_shortfall).toEqual(['0', '0']);
    expect(result.outputs).toEqual([['1000000000', '1000000', '0'], ['1000000000', '1000000', '0']]);
  });

  test('aggregate route price cannot conceal one rounded participant outside the execution band', async () => {
    const { context, plan } = await fixture(true);
    plan.crosses = [];
    plan.residuals = [{ stock_index: '1', direction: '0', minimum_output: '980', input_allocations: ['3', '97'] }];
    plan.estimated_outputs = ['980']; // Aggregate exactly -2%; first owner receives 29 instead of fair 30 cash units.
    await expect(validateCandidatePlan(plan, context)).rejects.toThrow('owner 0 external execution');
  });

  test('explicit weight bands convert into reviewable raw bounds without numeric JSON authority', () => {
    expect(deriveReviewableRawBounds({ funding: ['100000000', '0', '0'], prices: ['1000000', '10000000', '20000000'], decimals: ['6', '6', '6'], lower_weight_bps: ['5000', '2000', '1000'], upper_weight_bps: ['7000', '3000', '2000'] }))
      .toEqual([{ min_output: '50000000', max_output: '70000000' }, { min_output: '2000000', max_output: '3000000' }, { min_output: '500000', max_output: '1000000' }]);
    expect(() => deriveReviewableRawBounds({ funding: [100000000, '0', '0'], prices: ['1000000', '10000000', '20000000'], decimals: ['6', '6', '6'], lower_weight_bps: ['5000', '2000', '1000'], upper_weight_bps: ['7000', '3000', '2000'] })).toThrow('canonical');
  });
});
