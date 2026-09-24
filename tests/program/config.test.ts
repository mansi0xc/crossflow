import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, test } from 'vitest';
import { buildSetPauseInstruction, buildUpdateAdminInstruction, buildUpdatePolicyInstruction } from '../../packages/client/src/config.js';

const program = Keypair.generate().publicKey;
const admin = Keypair.generate().publicKey;
const config = Keypair.generate().publicKey;
const prices = Keypair.generate().publicKey;
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

describe('T07 configuration instruction builders', () => {
  test('pause toggles use the registered signer and exact writable config account', () => {
    const ix = buildSetPauseInstruction(program, admin, config, true, false);
    expect(ix.data).toEqual(Buffer.concat([disc('set_pause'), Buffer.from([1, 0])]));
    expect(ix.keys).toEqual([
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
    ]);
  });

  test('policy update carries current version then a fixed-size next-version policy', () => {
    const policy = Buffer.alloc(652);
    policy.writeUInt32LE(2, 104);
    const observations = Buffer.alloc(306);
    const ix = buildUpdatePolicyInstruction(program, admin, config, admin, prices, 1, policy, observations);
    expect(ix.data.subarray(0, 8)).toEqual(disc('update_policy'));
    expect(ix.data.readUInt32LE(8)).toBe(1);
    expect(ix.data.readUInt32LE(12 + 104)).toBe(2);
    expect(ix.data.length).toBe(970);
    expect(ix.keys).toHaveLength(4);
    expect(ix.keys[2]).toMatchObject({ pubkey: admin, isSigner: true });
    expect(ix.keys[3]).toMatchObject({ pubkey: prices, isWritable: true });
    const badVersion = Buffer.from(policy); badVersion.writeUInt32LE(3, 104);
    expect(() => buildUpdatePolicyInstruction(program, admin, config, admin, prices, 1, badVersion, observations)).toThrow('increment');
    expect(() => buildUpdatePolicyInstruction(program, admin, config, admin, prices, 1, policy.subarray(1), observations)).toThrow('652');
    expect(() => buildUpdatePolicyInstruction(program, admin, config, admin, prices, 1, policy, observations.subarray(1))).toThrow('306');
  });

  test('admin rotation binds an expected version and rejects program/system identities', () => {
    const next = Keypair.generate().publicKey;
    const ix = buildUpdateAdminInstruction(program, admin, config, 4, next);
    expect(ix.data.subarray(0, 8)).toEqual(disc('update_admin'));
    expect(ix.data.readUInt32LE(8)).toBe(4);
    expect(new PublicKey(ix.data.subarray(12, 44))).toEqual(next);
    expect(() => buildUpdateAdminInstruction(program, admin, config, 4, program)).toThrow('distinct');
    expect(() => buildUpdateAdminInstruction(program, admin, config, 0, next)).toThrow('version');
  });
});
