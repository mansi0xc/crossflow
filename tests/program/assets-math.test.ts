import { PublicKey } from '@solana/web3.js';
import { describe, expect, test } from 'vitest';
import { buildRecoverClosedVaultInstruction } from '../../packages/client/src/recover.js';

const program = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const config = new PublicKey('GhJQxyo8iihFpdS87mbfS6cZWYBCbqcj3t5TBbzi37dp');
const owner = new PublicKey('FSyL13FTp3Yrgdo8VWpoNtpL8FS5FcSGL3tdNp1sjw2t');
const mint = new PublicKey('6K1mBcYn9wgbZNUq6RwfXZbxyRXyd6QZr82akhey4ycv');

describe('T08 old-nonce donation recovery proposal', () => {
  test('derives only canonical old intent, vault and owner recipient with owner-paid rent', () => {
    const ix = buildRecoverClosedVaultInstruction(program, owner, config, 1n, mint);
    const nonce = Buffer.alloc(8); nonce.writeBigUInt64LE(1n);
    const oldIntent = PublicKey.findProgramAddressSync([Buffer.from('intent'), config.toBuffer(), owner.toBuffer(), nonce], program)[0];
    const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ata = (authority: PublicKey) => PublicKey.findProgramAddressSync([authority.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ataProgram)[0];
    expect(ix.keys).toHaveLength(10);
    expect(ix.keys[0]).toMatchObject({ pubkey: owner, isSigner: true, isWritable: true });
    expect(ix.keys[3].pubkey.equals(oldIntent)).toBe(true);
    expect(ix.keys[5].pubkey.equals(ata(oldIntent))).toBe(true);
    expect(ix.keys[6].pubkey.equals(ata(owner))).toBe(true);
    expect(ix.keys[9].pubkey.toBase58()).toBe('11111111111111111111111111111111');
    expect(ix.data.subarray(8).readBigUInt64LE()).toBe(1n);
  });

  test('rejects noncanonical nonce ranges before proposing a transaction', () => {
    expect(() => buildRecoverClosedVaultInstruction(program, owner, config, -1n, mint)).toThrow('nonce');
    expect(() => buildRecoverClosedVaultInstruction(program, owner, config, 1n << 64n, mint)).toThrow('nonce');
  });
});
