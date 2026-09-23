import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, test } from 'vitest';
import { buildCreateAndFundInstruction, deriveFundAccounts, fundingTransaction, FUNDING_COMPUTE_UNIT_LIMIT, type FundRequestInput } from '../../packages/client/src/fund.js';

const program = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 200 + i));
const config = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
const prices = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 150 + i));
const owner = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).publicKey;
const mints = [1, 2, 3].map(n => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? n : 0)));
const request: FundRequestInput = {
  expected_policy_hash: 'ab'.repeat(32), nonce: '0', expiry_unix_seconds: '1800000600', optimization_commitment: 'cd'.repeat(32),
  assets: [
    { funding: '100000000', min_output: '50000000', max_output: '200000000', funding_reference_price: '1000000' },
    { funding: '1000000', min_output: '0', max_output: '2000000', funding_reference_price: '10000000' },
    { funding: '1000000', min_output: '0', max_output: '2000000', funding_reference_price: '20000000' },
  ],
};

describe('T05 funding client instruction builder', () => {
  test('constructs canonical 185-byte Anchor instruction and exact account order', () => {
    const accounts = deriveFundAccounts(program, config, prices, owner, 0n, mints);
    const ix = buildCreateAndFundInstruction(program, owner, accounts, request);
    const expectedDiscriminator = createHash('sha256').update('global:create_and_fund').digest().subarray(0, 8);
    expect(ix.data.subarray(0, 8)).toEqual(expectedDiscriminator);
    expect(ix.data.length).toBe(185);
    expect(ix.keys).toHaveLength(18);
    expect(ix.keys[0]).toMatchObject({ pubkey: owner, isSigner: true, isWritable: true });
    expect(ix.keys[1].pubkey).toEqual(config);
    expect(ix.keys[3].pubkey).toEqual(accounts.intent);
    expect(ix.keys[4].pubkey).toEqual(prices);
    expect(ix.keys[17].pubkey.toBase58()).toBe('Sysvar1nstructions1111111111111111111111111');
    const tx = fundingTransaction(ix);
    expect(tx.instructions).toHaveLength(2);
    expect(tx.instructions[0].programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111');
    expect(tx.instructions[0].data.readUInt32LE(1)).toBe(FUNDING_COMPUTE_UNIT_LIMIT);
    expect(tx.instructions[1].data).toEqual(ix.data);
    expect(ix.data[8]).toBe(1);
    expect(ix.data.subarray(9, 41)).toEqual(Buffer.from(request.expected_policy_hash, 'hex'));
  });

  test('rejects noncanonical amounts, altered accounts and empty funding', () => {
    const accounts = deriveFundAccounts(program, config, prices, owner, 0n, mints);
    expect(() => buildCreateAndFundInstruction(program, owner, { ...accounts, intent: PublicKey.default }, request)).toThrow('intent PDA');
    expect(() => buildCreateAndFundInstruction(program, owner, { ...accounts, sources: [PublicKey.default, ...accounts.sources.slice(1)] }, request)).toThrow('sources[0] ATA');
    const badAmount = structuredClone(request); badAmount.assets[0].funding = 1_000_000_000_000_001n.toString();
    expect(() => buildCreateAndFundInstruction(program, owner, accounts, badAmount)).toThrow('protocol cap');
    const badBounds = structuredClone(request); badBounds.assets[1].min_output = '3'; badBounds.assets[1].max_output = '2';
    expect(() => buildCreateAndFundInstruction(program, owner, accounts, badBounds)).toThrow('output bounds');
    const empty = structuredClone(request); for (const asset of empty.assets) asset.funding = '0';
    expect(() => buildCreateAndFundInstruction(program, owner, accounts, empty)).toThrow('empty funding');
    const unsafe = structuredClone(request) as any; unsafe.assets[0].funding = 1;
    expect(() => buildCreateAndFundInstruction(program, owner, accounts, unsafe)).toThrow('canonical');
  });

  test('rejects unsorted mints and non-wallet owner', () => {
    expect(() => deriveFundAccounts(program, config, prices, owner, 0n, [...mints].reverse())).toThrow('ascending');
    const offCurveOwner = PublicKey.findProgramAddressSync([Buffer.from('off-curve')], program)[0];
    expect(() => deriveFundAccounts(program, config, prices, offCurveOwner, 0n, mints)).toThrow('on-curve');
  });
});
