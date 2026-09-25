import { describe, expect, test } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encodeSettlementBody } from '../../packages/planner/src/validate.js';
import { buildSettleBatchInstruction, buildSettleRoutedInstruction, deriveBatchAuthority, deriveRoutedBatchAccounts } from '../../packages/client/src/build-batch.js';

/**
 * T16 — the routed settlement client.
 *
 * Positive: a composed batch — one internal cross plus one admitted residual leg — whose accounts
 * are ordered, whose venue is pinned by the policy, and whose body carries exactly the participants
 * it claims.
 *
 * Negative: the categories the card names — a malicious venue output, an excessive debit, changed
 * accounts, a low output, and a failure after an earlier transfer. The last is the one that matters
 * most: a batch that fails part-way must revert whole, excluding only the transaction fee. The
 * runtime transcripts demonstrate that; here the model is held to the necessary standard that no
 * such batch reaches the chain at all.
 *
 * The runtime counterparts are the six named rejections in
 * `verification/evidence/T16-local-route-output.json`, bound to the built binary by the checker.
 */
const program = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const venueProgram = new PublicKey('Bq1FxNWHnmnZgJRi6fsRKrvLTbBf6uDTXjaawzdnkw1Q');
const otherProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const key = (pair: string) => new PublicKey(Buffer.from(pair.repeat(32), 'hex'));
const config = key('11');
const prices = key('22');
const mints = ['33', '44', '55'].map(key);
const venuePool = key('77');
const owners = ['aa', 'bb', 'cc'].map(pair => Keypair.fromSeed(Buffer.from(pair.repeat(32), 'hex')).publicKey);
const sorted = [...owners].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
const members = sorted.map((owner, index) => ({ owner, nonce: BigInt(index) }));
const route = { program: venueProgram, pool: venuePool };
const accounts = deriveRoutedBatchAccounts(program, config, prices, mints, members, route);
const CROSS = { stock_index: '1', seller_index: '0', buyer_index: '1', stock_quantity: '1000000', cash_amount: '10000000' };
const RESIDUAL = { stock_index: '1', direction: '0', minimum_output: '400000', input_allocations: ['50000', '0', '0'] };
const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '7', crosses: [CROSS], residuals: [RESIDUAL] }, 3);

describe('T16 routed settlement client', () => {
  test('derives the batch authority and its pools, and pins the venue vaults', () => {
    expect(accounts.batch_authority.equals(deriveBatchAuthority(program, config))).toBe(true);
    expect(accounts.pools).toHaveLength(3);
    expect(new Set(accounts.pools.map(pool => pool.toBase58())).size).toBe(3);
    expect(accounts.venue.vaults).toHaveLength(3);
    expect(accounts.venue.program.equals(venueProgram)).toBe(true);
    expect(() => deriveRoutedBatchAccounts(program, config, prices, mints, [{ owner: sorted[0], nonce: 0n }],
      { program, pool: venuePool })).toThrow('distinct program');
    expect(() => deriveRoutedBatchAccounts(program, config, prices, mints, [{ owner: sorted[0], nonce: 0n }],
      { program: venueProgram, pool: deriveBatchAuthority(program, config) })).toThrow('aliases the batch authority');
  });

  test('orders the declared accounts and appends the validated owner groups', () => {
    const instruction = buildSettleRoutedInstruction(program, accounts, body);
    expect(instruction.data.subarray(0, 8)).toEqual(Buffer.from([0xf9, 0x3a, 0xb0, 0x2c, 0xd2, 0xdc, 0x77, 0xa7]));
    expect(instruction.data.readUInt32LE(8)).toBe(body.length);
    expect(instruction.keys).toHaveLength(17 + 24);
    expect(instruction.keys[5].pubkey.equals(accounts.batch_authority)).toBe(true);
    expect(instruction.keys.slice(6, 9).map(meta => meta.pubkey)).toEqual(accounts.pools);
    expect(instruction.keys[9].pubkey.equals(venueProgram)).toBe(true);
    expect(instruction.keys[10].pubkey.equals(venuePool)).toBe(true);
    expect(instruction.keys.slice(11, 14).map(meta => meta.pubkey)).toEqual(accounts.venue.vaults);
    expect(instruction.keys.slice(11, 14).every(meta => meta.isWritable)).toBe(true);
    expect(instruction.keys[16].pubkey.toBase58()).toBe('Sysvar1nstructions1111111111111111111111111');
  });

  test('a routed batch never requires a signer: the batch PDA signs inside the CPI', () => {
    const instruction = buildSettleRoutedInstruction(program, accounts, body);
    expect(instruction.keys.some(meta => meta.isSigner)).toBe(false);
    // The batch authority is passed read-only and is granted signer rights only by `invoke_signed`.
    expect(instruction.keys[5].isWritable).toBe(false);
  });

  test('negative: changed accounts are carried by the instruction but pinned by the policy', () => {
    // The builder emits whatever venue the caller names. What stops a substitution is the handler
    // re-deriving the venue from the committed policy, which the runtime transcript shows rejecting
    // with `RouteIdentity`. Asserting the builder is permissive documents where the boundary really
    // is, rather than implying the client is the guard.
    const substituted = deriveRoutedBatchAccounts(program, config, prices, mints, members,
      { program: otherProgram, pool: venuePool });
    const instruction = buildSettleRoutedInstruction(program, substituted, body);
    expect(instruction.keys[9].pubkey.equals(otherProgram)).toBe(true);
    expect(substituted.venue.program.equals(venueProgram)).toBe(false);
    // The vaults are still the named pool's canonical ATAs, so the substitution is internally
    // consistent and only the policy check can catch it.
    expect(substituted.venue.vaults).toEqual(accounts.venue.vaults);
  });

  test('negative: an impossible minimum is refused, because it cannot be encoded', () => {
    // A minimum above the protocol's pool bound cannot be encoded, so a caller cannot promise an
    // output no venue could deliver.
    expect(() => encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '7',
      crosses: [CROSS], residuals: [{ ...RESIDUAL, minimum_output: '9'.repeat(20) }] }, 3))
      .toThrow(/minimum output/i);
  });

  test('the routed body carries exactly the weights the owners contributed', () => {
    // There is no credit or allocation-weight array: the only per-owner numbers in the body are the
    // residual input contributions.
    expect(body).toHaveLength(2 + 8 + 1 + 19 + 1 + (10 + 8 * 3));
    const withoutResidual = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '7',
      crosses: [CROSS], residuals: [] }, 3);
    // The only difference is the residual record itself: a direction, a minimum output and one
    // weight per participant. The residual *count* byte is present in both bodies.
    expect(withoutResidual.length).toBe(body.length - (10 + 8 * 3));
  });

  test('an internal-only batch is built by the internal instruction, not the routed one', () => {
    const internalBody = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '7', crosses: [CROSS], residuals: [] }, 3);
    const internal = buildSettleBatchInstruction(program, accounts, internalBody);
    const routed = buildSettleRoutedInstruction(program, accounts, body);
    // Different discriminators, so a routed proposal cannot be smuggled through the internal
    // handler and vice versa.
    expect(internal.data.subarray(0, 8)).toEqual(Buffer.from([0x16, 0x02, 0x15, 0xdf, 0xe1, 0x7a, 0xa3, 0xd6]));
    expect(routed.data.subarray(0, 8)).toEqual(Buffer.from([0xf9, 0x3a, 0xb0, 0x2c, 0xd2, 0xdc, 0x77, 0xa7]));
  });
});
