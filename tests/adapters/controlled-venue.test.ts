import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, test } from 'vitest';
import { ControlledVenue, deriveControlledPool, venueTransaction } from '../../packages/adapters/src/controlled.js';
import { canonicalAta, controlledQuote, requireAscendingMints } from '../../packages/adapters/src/types.js';

const mints = [1, 2, 3].map(n => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? n : 0)));
const venueProgram = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 240 + i));
const authority = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 7)).publicKey;
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

function venue() {
  return new ControlledVenue({ programId: venueProgram, pool: deriveControlledPool(venueProgram, mints), poolAuthority: authority, mints, feeBps: 30, label: 'CONTROLLED SYNTHETIC VENUE' });
}

describe('T10 controlled residual venue adapter', () => {
  test('pool identity is derived from the program and the sorted mint set', () => {
    const pool = deriveControlledPool(venueProgram, mints);
    expect(deriveControlledPool(venueProgram, mints).equals(pool)).toBe(true);
    expect(() => deriveControlledPool(venueProgram, [mints[1], mints[0], mints[2]])).toThrow('ascending');
    expect(() => requireAscendingMints([mints[1], mints[0], mints[2]])).toThrow('ascending');
    expect(() => requireAscendingMints(mints)).not.toThrow();
    expect(() => deriveControlledPool(venueProgram, [mints[0], mints[0], mints[2]])).toThrow('ascending');
  });

  test('mirrors the on-chain quote exactly, including the floored one-unit case', () => {
    expect(controlledQuote(10_000n, 10_000n, 100n, 30)).toBe(98n);
    expect(controlledQuote(10_000n, 10_000n, 100n, 0)).toBe(99n);
    expect(controlledQuote(1_000_000n, 2_000_000n, 1_000n, 30)).toBe(1992n);
    expect(controlledQuote(1_000_000_000n, 1_000n, 1n, 30)).toBe(0n);
    expect(() => controlledQuote(0n, 1_000n, 1n, 30)).toThrow('empty reserve');
    expect(() => controlledQuote(1_000n, 1_000n, 1n, 301)).toThrow('fee out of range');
    expect(() => controlledQuote(1_000n, 1_000n, 0n, 30)).toThrow('amount');
  });

  test('builds only the pinned program form with derived vaults and canonical caller accounts', () => {
    const adapter = venue();
    const instruction = adapter.buildSwap(1, 0, 1_000_000n, 9_000_000n);
    expect(instruction.programId.equals(venueProgram)).toBe(true);
    expect(instruction.data.subarray(0, 8)).toEqual(disc('swap'));
    expect(instruction.data.readUInt8(8)).toBe(1);
    expect(instruction.data.readUInt8(9)).toBe(0);
    expect(instruction.data.readBigUInt64LE(10)).toBe(1_000_000n);
    expect(instruction.data.readBigUInt64LE(18)).toBe(9_000_000n);
    expect(instruction.keys).toHaveLength(10);
    expect(instruction.keys[0]).toMatchObject({ pubkey: authority, isSigner: true, isWritable: false });
    expect(instruction.keys[1].pubkey.equals(adapter.pool)).toBe(true);
    expect(instruction.keys[4].pubkey.equals(canonicalAta(authority, mints[1]))).toBe(true);
    expect(instruction.keys[5].pubkey.equals(canonicalAta(authority, mints[0]))).toBe(true);
    expect(instruction.keys[6].pubkey.equals(canonicalAta(adapter.pool, mints[1]))).toBe(true);
    expect(instruction.keys[7].pubkey.equals(canonicalAta(adapter.pool, mints[0]))).toBe(true);
    expect(venueTransaction(instruction).instructions[0].programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111');
    expect(adapter.buildInitializePool().data.readUInt16LE(8)).toBe(30);
  });

  test('rejects a relabelled direction, a non-derived pool and an out-of-range fee', () => {
    const adapter = venue();
    expect(() => adapter.buildSwap(1, 1, 1n, 1n)).toThrow('distinct');
    expect(() => adapter.buildSwap(3, 0, 1n, 1n)).toThrow('distinct');
    expect(() => adapter.buildSwap(1, 0, 0n, 1n)).toThrow('out of range');
    expect(() => adapter.buildSwap(1, 0, 1n, 0n)).toThrow('minimum out');
    expect(() => adapter.quoteFromReserves([1n, 1n, 1n], 0, 0, 1n)).toThrow('distinct');
    expect(() => new ControlledVenue({ programId: venueProgram, pool: mints[0], poolAuthority: authority, mints, feeBps: 30, label: 'x' })).toThrow('derived venue pool');
    expect(() => new ControlledVenue({ programId: venueProgram, pool: deriveControlledPool(venueProgram, mints), poolAuthority: authority, mints, feeBps: 301, label: 'x' })).toThrow('out of range');
    expect(adapter.label).toBe('CONTROLLED SYNTHETIC VENUE');
  });
});
