import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, test } from 'vitest';
import {
  buildCancelIntentInstruction, buildCloseIntentInstruction, buildThinSettleInstruction,
  buildWithdrawAssetInstruction, deriveRecoveryAccounts,
} from '../../packages/client/src/recover.js';

const program = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 200 + i));
const config = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
const prices = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 150 + i));
const owner = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).publicKey;
const mints = [1, 2, 3].map(n => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? n : 0)));
const accounts = deriveRecoveryAccounts(program, config, prices, owner, 7n, mints);
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

describe('T06 thin lifecycle client', () => {
  test('encodes an exact three-asset settlement request and canonical account order', () => {
    const ix = buildThinSettleInstruction(program, owner, accounts, '12', ['100', '20', '30']);
    expect(ix.data.subarray(0, 8)).toEqual(disc('settle_thin'));
    expect(ix.data.length).toBe(40);
    expect(ix.data.readBigUInt64LE(8)).toBe(12n);
    expect([0, 1, 2].map(i => ix.data.readBigUInt64LE(16 + i * 8))).toEqual([100n, 20n, 30n]);
    expect(ix.keys).toHaveLength(16);
    expect(ix.keys[0]).toMatchObject({ pubkey: owner, isSigner: true });
    expect(ix.keys[3].pubkey).toEqual(accounts.intent);
    expect(ix.keys[4].pubkey).toEqual(prices);
    expect(ix.keys[15].pubkey.toBase58()).toBe('Sysvar1nstructions1111111111111111111111111');
    expect(() => buildThinSettleInstruction(program, owner, accounts, '12', ['1', '2'])).toThrow('three outputs');
  });

  test('encodes cancellation, per-asset recovery, and close instructions', () => {
    const cancel = buildCancelIntentInstruction(program, owner, accounts);
    expect(cancel.data).toEqual(disc('cancel_intent'));
    expect(cancel.keys).toHaveLength(4);
    const withdraw = buildWithdrawAssetInstruction(program, owner, accounts, 2);
    expect(withdraw.data).toEqual(Buffer.concat([disc('withdraw_asset'), Buffer.from([2])]));
    expect(withdraw.keys).toHaveLength(14);
    const close = buildCloseIntentInstruction(program, owner, accounts);
    expect(close.data).toEqual(disc('close_intent'));
    expect(close.keys).toHaveLength(11);
    expect(() => buildWithdrawAssetInstruction(program, owner, accounts, 3)).toThrow('0, 1, or 2');
  });

  test('rejects manipulated recovery PDA/ATA sets and off-curve owners', () => {
    expect(() => buildCancelIntentInstruction(program, owner, { ...accounts, intent: PublicKey.default })).toThrow('intent PDA');
    expect(() => buildCloseIntentInstruction(program, owner, { ...accounts, vaults: [PublicKey.default, ...accounts.vaults.slice(1)] })).toThrow('vaults[0]');
    const offCurveOwner = PublicKey.findProgramAddressSync([Buffer.from('off-curve')], program)[0];
    expect(() => deriveRecoveryAccounts(program, config, prices, offCurveOwner, 7n, mints)).toThrow('wallet signer');
  });
});
