import { PublicKey } from '@solana/web3.js';
import { describe, expect, test } from 'vitest';
import { buildWithdrawAssetInstruction, deriveRecoveryAccounts } from '../../packages/client/src/recover.js';

const program = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 200 + i));
const config = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
const prices = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 150 + i));
const owner = new PublicKey('FSyL13FTp3Yrgdo8VWpoNtpL8FS5FcSGL3tdNp1sjw2t');
const mints = [1, 2, 3].map(n => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? n : 0)));

describe('T07 independent per-asset recovery', () => {
  test('withdrawal includes only canonical owner recovery accounts and ATA recreation programs', () => {
    const accounts = deriveRecoveryAccounts(program, config, prices, owner, 9n, mints);
    const ix = buildWithdrawAssetInstruction(program, owner, accounts, 1);
    expect(ix.keys).toHaveLength(16);
    expect(ix.keys.slice(10, 13).map(meta => meta.pubkey)).toEqual(accounts.recipients);
    expect(ix.keys[14].pubkey.toBase58()).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    expect(ix.keys[15].pubkey.toBase58()).toBe('11111111111111111111111111111111');
    expect(ix.keys[0]).toMatchObject({ pubkey: owner, isSigner: true, isWritable: true });
    expect(() => buildWithdrawAssetInstruction(program, owner, { ...accounts,
      recipients: [PublicKey.default, ...accounts.recipients.slice(1)] }, 0)).toThrow('recipients[0]');
  });
});
