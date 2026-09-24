import { createHash } from 'node:crypto';
import { AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

export interface RecoveryAccounts {
  config: PublicKey;
  owner_state: PublicKey;
  intent: PublicKey;
  nonce: string;
  prices: PublicKey;
  mints: PublicKey[];
  vaults: PublicKey[];
  recipients: PublicKey[];
}

function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}
function u64(value: string): Buffer {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('u64 must be a canonical unsigned decimal string');
  const n = BigInt(value);
  if (n < 0n || n > (1n << 64n) - 1n) throw new RangeError('u64 out of range');
  const out = Buffer.alloc(8); out.writeBigUInt64LE(n); return out;
}
function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}

export function deriveRecoveryAccounts(program: PublicKey, config: PublicKey, prices: PublicKey, owner: PublicKey, nonce: bigint, mints: PublicKey[]): RecoveryAccounts {
  if (!PublicKey.isOnCurve(owner.toBytes())) throw new TypeError('recovery owner must be a wallet signer');
  if (nonce < 0n || nonce > (1n << 64n) - 1n || mints.length !== 3) throw new RangeError('recovery requires three mints and a u64 nonce');
  for (let i = 1; i < mints.length; i++) if (Buffer.compare(mints[i - 1].toBuffer(), mints[i].toBuffer()) >= 0) throw new TypeError('mint order must be unique ascending bytes');
  const nonceBytes = Buffer.alloc(8); nonceBytes.writeBigUInt64LE(nonce);
  const [owner_state] = PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), owner.toBuffer()], program);
  const [intent] = PublicKey.findProgramAddressSync([Buffer.from('intent'), config.toBuffer(), owner.toBuffer(), nonceBytes], program);
  return { config, owner_state, intent, nonce: nonce.toString(), prices, mints,
    vaults: mints.map(mint => ata(intent, mint)), recipients: mints.map(mint => ata(owner, mint)) };
}

function assertCanonical(program: PublicKey, owner: PublicKey, accounts: RecoveryAccounts): void {
  const expected = deriveRecoveryAccounts(program, accounts.config, accounts.prices, owner, BigInt(accounts.nonce), accounts.mints);
  for (const field of ['owner_state', 'intent'] as const) if (!accounts[field].equals(expected[field])) throw new TypeError(`noncanonical ${field} PDA`);
  for (const field of ['vaults', 'recipients'] as const) for (let i = 0; i < 3; i++) if (!accounts[field][i].equals(expected[field][i])) throw new TypeError(`noncanonical ${field}[${i}] ATA`);
}

export function buildThinSettleInstruction(program: PublicKey, owner: PublicKey, accounts: RecoveryAccounts,
  expectedSnapshotSequence: string, finalOutputs: string[]): TransactionInstruction {
  assertCanonical(program, owner, accounts);
  if (finalOutputs.length !== 3) throw new TypeError('settlement requires exactly three outputs');
  const data = Buffer.concat([discriminator('settle_thin'), u64(expectedSnapshotSequence), ...finalOutputs.map(u64)]);
  const keys: AccountMeta[] = [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: accounts.config, isSigner: false, isWritable: false },
    { pubkey: accounts.owner_state, isSigner: false, isWritable: false },
    { pubkey: accounts.intent, isSigner: false, isWritable: true },
    { pubkey: accounts.prices, isSigner: false, isWritable: false },
    ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
    ...accounts.vaults.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    ...accounts.recipients.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: program, keys, data });
}

export function buildCancelIntentInstruction(program: PublicKey, owner: PublicKey, accounts: RecoveryAccounts): TransactionInstruction {
  assertCanonical(program, owner, accounts);
  return new TransactionInstruction({ programId: program, data: discriminator('cancel_intent'), keys: [
    { pubkey: owner, isSigner: true, isWritable: false },
    { pubkey: accounts.config, isSigner: false, isWritable: true },
    { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
    { pubkey: accounts.intent, isSigner: false, isWritable: true },
  ] });
}

export function buildWithdrawAssetInstruction(program: PublicKey, owner: PublicKey, accounts: RecoveryAccounts, assetIndex: number): TransactionInstruction {
  assertCanonical(program, owner, accounts);
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex > 2) throw new RangeError('asset index must be 0, 1, or 2');
  return new TransactionInstruction({ programId: program, data: Buffer.concat([discriminator('withdraw_asset'), Buffer.from([assetIndex])]), keys: [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: accounts.config, isSigner: false, isWritable: false },
    { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
    { pubkey: accounts.intent, isSigner: false, isWritable: true },
    ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
    ...accounts.vaults.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    ...accounts.recipients.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
  ] });
}

export function buildCloseIntentInstruction(program: PublicKey, owner: PublicKey, accounts: RecoveryAccounts): TransactionInstruction {
  assertCanonical(program, owner, accounts);
  return new TransactionInstruction({ programId: program, data: discriminator('close_intent'), keys: [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: accounts.config, isSigner: false, isWritable: true },
    { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
    { pubkey: accounts.intent, isSigner: false, isWritable: true },
    ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
    ...accounts.vaults.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
  ] });
}

/** Reclaim a donation sent to a recreated vault of an already closed nonce. */
export function buildRecoverClosedVaultInstruction(program: PublicKey, owner: PublicKey, config: PublicKey,
  nonce: bigint, mint: PublicKey): TransactionInstruction {
  if (!PublicKey.isOnCurve(owner.toBytes())) throw new TypeError('recovery owner must be a wallet signer');
  if (nonce < 0n || nonce > (1n << 64n) - 1n) throw new RangeError('closed-vault nonce out of range');
  const nonceBytes = Buffer.alloc(8); nonceBytes.writeBigUInt64LE(nonce);
  const [ownerState] = PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), owner.toBuffer()], program);
  const [oldIntent] = PublicKey.findProgramAddressSync([Buffer.from('intent'), config.toBuffer(), owner.toBuffer(), nonceBytes], program);
  return new TransactionInstruction({ programId: program, data: Buffer.concat([discriminator('recover_closed_vault'), nonceBytes]), keys: [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: ownerState, isSigner: false, isWritable: false },
    { pubkey: oldIntent, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: ata(oldIntent, mint), isSigner: false, isWritable: true },
    { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
  ] });
}
