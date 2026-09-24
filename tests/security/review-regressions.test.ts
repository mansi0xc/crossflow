/**
 * T22 review regressions.
 *
 * Every case here pins a defect an independent reviewer actually found, so the fix cannot be
 * quietly reverted. Each test names the finding it guards.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildSettleBatchInstruction, buildSettleRoutedInstruction, deriveBatchAuthority, deriveRoutedBatchAccounts } from '../../packages/client/src/build-batch.js';
import { decodeSettlementBody, encodeSettlementBody } from '../../packages/planner/src/validate.js';
import { Keypair, PublicKey } from '@solana/web3.js';

const program = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 200 + i));
const venueProgram = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 250 + i));
const config = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
const prices = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 150 + i));
const mints = [1, 2, 3].map(n => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? n : 0)));
const owners = [11, 12, 13].map(n => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? n : 9)).publicKey);
const sorted = [...owners].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
const venuePool = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? 77 : 1)).publicKey;

describe('T22 review regressions', () => {
  test('T16-M1: a two-owner residual body carries exactly two weights', () => {
    const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '3', crosses: [
      { stock_index: '1', seller_index: '0', buyer_index: '1', stock_quantity: '1000', cash_amount: '10000' },
    ], residuals: [
      { stock_index: '1', direction: '0', minimum_output: '900', input_allocations: ['50', '0'] },
    ] }, 2);
    const decoded = decodeSettlementBody(body);
    expect(decoded.batch_count).toBe(2);
    expect(decoded.body.residuals[0].input_allocations).toEqual(['50', '0']);
    expect(encodeSettlementBody(decoded.body, 2).length).toBe(body.length);
    // A three-owner body is longer by exactly one weight.
    const three = encodeSettlementBody({ ...decoded.body, residuals: [
      { stock_index: '1', direction: '0', minimum_output: '900', input_allocations: ['50', '0', '0'] },
    ] }, 3);
    expect(three.length).toBe(body.length + 8);
  });

  test('T16-M2: the routed builder refuses pools that alias an intent account', () => {
    const accounts = deriveRoutedBatchAccounts(program, config, prices, mints, [{ owner: sorted[0], nonce: 0n }],
      { program: venueProgram, pool: venuePool });
    expect(accounts.batch_authority.equals(deriveBatchAuthority(program, config))).toBe(true);
    // The pool set is derived from the batch authority; a caller cannot supply an alias.
    expect(new Set(accounts.pools.map(key => key.toBase58())).size).toBe(3);
    for (const pool of accounts.pools) {
      expect(accounts.vaults.flat().some(vault => vault.equals(pool))).toBe(false);
      expect(accounts.recipients.flat().some(recipient => recipient.equals(pool))).toBe(false);
    }
  });

  test('T16/L1: the routed instruction keeps the venue pinned to the policy accounts', () => {
    const accounts = deriveRoutedBatchAccounts(program, config, prices, mints, sorted.map(owner => ({ owner, nonce: 0n })),
      { program: venueProgram, pool: venuePool });
    const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '1', crosses: [],
      residuals: [{ stock_index: '1', direction: '0', minimum_output: '1', input_allocations: ['1', '0', '0'] }] }, 3);
    const ix = buildSettleRoutedInstruction(program, accounts, body);
    // Declared accounts: config, prices, 3 mints, batch authority, 3 pools, venue program, venue
    // pool, 3 venue vaults, token program, ATA program, instructions sysvar.
    expect(ix.keys.slice(0, 17).map(meta => meta.pubkey)).toEqual([
      config, prices, ...mints, accounts.batch_authority, ...accounts.pools,
      venueProgram, venuePool, ...accounts.venue.vaults,
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      new PublicKey('Sysvar1nstructions1111111111111111111111111'),
    ]);
    expect(ix.keys.some(meta => meta.isSigner)).toBe(false);
  });

  test('T09/L1: the instruction data is exactly the discriminator, length and body', () => {
    const accounts = deriveRoutedBatchAccounts(program, config, prices, mints, [{ owner: sorted[0], nonce: 0n }, { owner: sorted[1], nonce: 0n }],
      { program: venueProgram, pool: venuePool });
    const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '1', crosses: [], residuals: [] }, 2);
    const routed = buildSettleRoutedInstruction(program, accounts, body);
    expect(routed.data.length).toBe(8 + 4 + body.length);
    const plain = buildSettleBatchInstruction(program, accounts, encodeSettlementBody(
      { schema_version: '1', expected_snapshot_sequence: '1', crosses: [], residuals: [] }, 2));
    expect(plain.data.length).toBe(8 + 4 + body.length);
    expect(plain.data.subarray(0, 8)).not.toEqual(routed.data.subarray(0, 8));
  });

  test('T16-M3: the recorded policy bytes hash to the committed policy hash', () => {
    const manifest = JSON.parse(readFileSync('verification/evidence/T16-local-manifest.json', 'utf8'));
    const { createHash } = require('node:crypto');
    const digest = createHash('sha256').update(Buffer.from(manifest.policy_bytes_hex, 'hex')).digest('hex');
    expect(digest).toBe(manifest.initial_policy_hash);
    expect(Buffer.from(manifest.policy_bytes_hex, 'hex').length).toBe(652);
  });
});
