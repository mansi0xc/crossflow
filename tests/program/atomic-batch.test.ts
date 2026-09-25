import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, test } from 'vitest';
import { BATCH_COMPUTE_UNIT_LIMIT, MAX_BATCH, batchTransaction, buildSettleBatchInstruction, buildSettleRoutedInstruction, deriveBatchAccounts, deriveBatchAuthority, deriveRoutedBatchAccounts, encodeSettleBatchData, encodeSettleRoutedData } from '../../packages/client/src/build-batch.js';
import { encodeSettlementBody } from '../../packages/planner/src/validate.js';

const program = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 200 + i));
const config = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
const prices = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 150 + i));
const mints = [1, 2, 3].map(n => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? n : 0)));
const owners = [11, 12, 13].map(n => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? n : 9)).publicKey);
const sorted = [...owners].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

describe('T09 bounded batch settlement client', () => {
  test('binds the canonical T11 body behind the Anchor length prefix and ordered accounts', () => {
    const accounts = deriveBatchAccounts(program, config, prices, mints, sorted.map(owner => ({ owner, nonce: 0n })));
    const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '7', crosses: [
      { stock_index: '1', seller_index: '0', buyer_index: '1', stock_quantity: '2000000', cash_amount: '20000000' },
    ], residuals: [] }, 3);
    const ix = buildSettleBatchInstruction(program, accounts, body);
    expect(ix.data.subarray(0, 8)).toEqual(disc('settle_batch'));
    expect(ix.data.readUInt32LE(8)).toBe(body.length);
    expect(Buffer.from(ix.data.subarray(12))).toEqual(Buffer.from(body));
    expect(ix.keys).toHaveLength(7 + 3 * 8);
    expect(ix.keys.slice(0, 7).map(meta => meta.pubkey)).toEqual([config, prices, ...mints, new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), new PublicKey('Sysvar1nstructions1111111111111111111111111')]);
    expect(ix.keys[0].isWritable).toBe(false);
    for (let i = 0; i < 3; i++) {
      const group = ix.keys.slice(7 + i * 8, 7 + (i + 1) * 8);
      expect(group[0].pubkey).toEqual(accounts.owner_states[i]);
      expect(group[0].isWritable).toBe(false);
      expect(group[1].pubkey).toEqual(accounts.intents[i]);
      expect(group[1].isWritable).toBe(true);
      expect(group.slice(2, 5).every(meta => meta.isWritable)).toBe(true);
      expect(group.slice(5, 8).every(meta => meta.isWritable)).toBe(true);
      expect(group[2].pubkey).toEqual(accounts.vaults[i][0]);
      expect(group[7].pubkey).toEqual(accounts.recipients[i][2]);
    }
    expect(batchTransaction(ix).instructions[0].programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111');
  });

  test('orders members by raw owner bytes and rejects aliases, duplicates and oversized batches', () => {
    const reversed = deriveBatchAccounts(program, config, prices, mints, [...sorted].reverse().map(owner => ({ owner, nonce: 0n })));
    expect(reversed.members.map(member => member.owner.toBase58())).toEqual(sorted.map(owner => owner.toBase58()));
    expect(() => deriveBatchAccounts(program, config, prices, mints, [{ owner: sorted[0], nonce: 0n }, { owner: sorted[0], nonce: 1n }])).toThrow('duplicate batch owner');
    expect(() => deriveBatchAccounts(program, config, prices, mints, [])).toThrow('batch size');
    expect(() => deriveBatchAccounts(program, config, prices, mints, [...sorted, sorted[0]].map(owner => ({ owner, nonce: 0n })))).toThrow('batch size');
    expect(() => deriveBatchAccounts(program, config, prices, mints, sorted.map(owner => ({ owner, nonce: -1n })))).toThrow('nonce');
    const offCurve = PublicKey.findProgramAddressSync([Buffer.from('x')], program)[0];
    expect(() => deriveBatchAccounts(program, config, prices, mints, [{ owner: offCurve, nonce: 0n }])).toThrow('wallet signer');
    expect(() => deriveBatchAccounts(program, config, prices, [mints[1], mints[0], mints[2]], [{ owner: sorted[0], nonce: 0n }])).toThrow('ascending');
    expect(MAX_BATCH).toBe(3);
    expect(BATCH_COMPUTE_UNIT_LIMIT).toBeGreaterThan(200_000);
  });

  test('rejects noncanonical, empty and oversized settlement bodies before proposing a transaction', () => {
    expect(() => encodeSettleBatchData(new Uint8Array())).toThrow('1–194');
    expect(() => encodeSettleBatchData(new Uint8Array(195))).toThrow('1–194');
    const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '1', crosses: [], residuals: [] }, 3);
    expect(encodeSettleBatchData(body).readUInt32LE(8)).toBe(body.length);
  });
});
