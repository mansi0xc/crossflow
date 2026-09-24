import { createHash } from 'node:crypto';
import { AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js';

const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}
function versionBytes(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 0xffff_ffff) throw new RangeError('configuration version out of range');
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}
function ix(program: PublicKey, name: string, admin: PublicKey, config: PublicKey, args: Buffer,
  extraKeys: AccountMeta[] = []): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: admin, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: true },
    ...extraKeys,
  ];
  return new TransactionInstruction({ programId: program, keys, data: Buffer.concat([discriminator(name), args]) });
}

export function buildSetPauseInstruction(program: PublicKey, admin: PublicKey, config: PublicKey,
  pauseFunding: boolean, pauseSettlement: boolean): TransactionInstruction {
  return ix(program, 'set_pause', admin, config, Buffer.from([Number(pauseFunding), Number(pauseSettlement)]));
}

export function buildUpdatePolicyInstruction(program: PublicKey, admin: PublicKey, config: PublicKey,
  publisher: PublicKey, prices: PublicKey, expectedVersion: number, nextPolicyBytes: Uint8Array,
  encodedObservations: Uint8Array): TransactionInstruction {
  if (nextPolicyBytes.length !== 652) throw new RangeError('policy must contain exactly 652 bytes');
  if (encodedObservations.length !== 306) throw new RangeError('three observations must contain exactly 306 bytes');
  const expected = versionBytes(expectedVersion);
  const next = Buffer.from(nextPolicyBytes);
  const embeddedVersion = next.readUInt32LE(104);
  if (embeddedVersion !== expectedVersion + 1) throw new TypeError('policy must increment the expected version by one');
  return ix(program, 'update_policy', admin, config, Buffer.concat([expected, next, Buffer.from(encodedObservations)]), [
    { pubkey: publisher, isSigner: true, isWritable: false },
    { pubkey: prices, isSigner: false, isWritable: true },
  ]);
}

export function buildUpdateAdminInstruction(program: PublicKey, admin: PublicKey, config: PublicKey,
  expectedVersion: number, nextAdmin: PublicKey): TransactionInstruction {
  versionBytes(expectedVersion);
  if (nextAdmin.equals(SYSTEM_PROGRAM) || nextAdmin.equals(program)) throw new TypeError('next admin must be a distinct non-program identity');
  return ix(program, 'update_admin', admin, config, Buffer.concat([versionBytes(expectedVersion), nextAdmin.toBuffer()]));
}
