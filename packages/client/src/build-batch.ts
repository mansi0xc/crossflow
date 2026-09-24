import { createHash } from 'node:crypto';
import { AccountMeta, ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
export const MAX_BATCH = 3;

/** T09 settlement does up to 6 crosses (12 transfers) plus 9 output transfers. */
export const BATCH_COMPUTE_UNIT_LIMIT = 1_400_000;

export interface BatchMember { owner: PublicKey; nonce: bigint }

export interface BatchAccounts {
  config: PublicKey;
  prices: PublicKey;
  mints: PublicKey[];
  members: BatchMember[];
  owner_states: PublicKey[];
  intents: PublicKey[];
  vaults: PublicKey[][];
  recipients: PublicKey[][];
}

function u64Bytes(value: bigint): Buffer {
  if (value < 0n || value > (1n << 64n) - 1n) throw new RangeError('u64 out of range');
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes;
}

function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}

export function deriveBatchAccounts(program: PublicKey, config: PublicKey, prices: PublicKey, mints: PublicKey[], members: BatchMember[]): BatchAccounts {
  if (mints.length !== 3) throw new TypeError('exactly three configured mints required');
  for (let i = 1; i < 3; i++) if (Buffer.compare(mints[i - 1].toBuffer(), mints[i].toBuffer()) >= 0) throw new TypeError('mint order must be unique ascending bytes');
  if (!Array.isArray(members) || members.length < 1 || members.length > MAX_BATCH) throw new RangeError('batch size must be 1–3');
  const ordered = members.map(member => {
    if (!PublicKey.isOnCurve(member.owner.toBytes())) throw new TypeError('batch owner must be a wallet signer');
    if (member.nonce < 0n || member.nonce > (1n << 64n) - 1n) throw new RangeError('batch nonce out of range');
    return { ...member };
  }).sort((a, b) => Buffer.compare(a.owner.toBuffer(), b.owner.toBuffer()));
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1].owner.equals(ordered[i].owner)) throw new TypeError('duplicate batch owner');
  }
  const owner_states = ordered.map(member => PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), member.owner.toBuffer()], program)[0]);
  const intents = ordered.map((member, i) => {
    const derived = PublicKey.findProgramAddressSync([Buffer.from('intent'), config.toBuffer(), member.owner.toBuffer(), u64Bytes(member.nonce)], program)[0];
    if (derived.equals(owner_states[i])) throw new TypeError('intent and owner state collided');
    return derived;
  });
  const vaults = intents.map(intent => mints.map(mint => ata(intent, mint)));
  const recipients = ordered.map(member => mints.map(mint => ata(member.owner, mint)));
  const seen = new Set<string>();
  for (const group of [owner_states, intents, ...vaults, ...recipients]) {
    for (const key of group) {
      if (seen.has(key.toBase58())) throw new TypeError(`aliased batch account ${key.toBase58()}`);
      seen.add(key.toBase58());
    }
  }
  return { config, prices, mints, members: ordered, owner_states, intents, vaults, recipients };
}

/** Anchor encodes a `Vec<u8>` argument as a four-byte little-endian length followed by the bytes. */
export function encodeSettleBatchData(body: Uint8Array): Buffer {
  if (!(body instanceof Uint8Array) || body.length === 0 || body.length > 194) throw new RangeError('settlement body must be 1–194 bytes');
  const length = Buffer.alloc(4); length.writeUInt32LE(body.length);
  return Buffer.concat([createHash('sha256').update('global:settle_batch').digest().subarray(0, 8), length, Buffer.from(body)]);
}

export function buildSettleBatchInstruction(program: PublicKey, accounts: BatchAccounts, body: Uint8Array): TransactionInstruction {
  const grouped: AccountMeta[] = [];
  for (let i = 0; i < accounts.members.length; i++) {
    grouped.push(
      { pubkey: accounts.owner_states[i], isSigner: false, isWritable: false },
      { pubkey: accounts.intents[i], isSigner: false, isWritable: true },
      ...accounts.vaults[i].map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
      ...accounts.recipients[i].map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    );
  }
  return new TransactionInstruction({ programId: program, data: encodeSettleBatchData(body), keys: [
    { pubkey: accounts.config, isSigner: false, isWritable: false },
    { pubkey: accounts.prices, isSigner: false, isWritable: false },
    ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ...grouped,
  ] });
}

/** The batch instruction is account-heavy; an explicit bounded compute budget is part of the proposal. */
export function batchTransaction(instruction: TransactionInstruction): Transaction {
  return new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: BATCH_COMPUTE_UNIT_LIMIT }), instruction);
}

/** The routed instruction declares the batch PDA, its pools and the pinned venue explicitly. */
export interface RoutedBatchAccounts extends BatchAccounts {
  batch_authority: PublicKey;
  pools: PublicKey[];
  venue: { program: PublicKey; pool: PublicKey; vaults: PublicKey[] };
}

/** `sha256("global:settle_routed")[..8]` for the pinned CrossFlow program. */
export const SETTLE_ROUTED_DISCRIMINATOR = Buffer.from([0xf9, 0x3a, 0xb0, 0x2c, 0xd2, 0xdc, 0x77, 0xa7]);

export function deriveBatchAuthority(program: PublicKey, config: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('batch'), config.toBuffer()], program)[0];
}

export function deriveRoutedBatchAccounts(
  program: PublicKey,
  config: PublicKey,
  prices: PublicKey,
  mints: PublicKey[],
  members: BatchMember[],
  venue: { program: PublicKey; pool: PublicKey },
): RoutedBatchAccounts {
  const base = deriveBatchAccounts(program, config, prices, mints, members);
  const batch_authority = deriveBatchAuthority(program, config);
  const pools = mints.map(mint => ata(batch_authority, mint));
  const vaults = mints.map(mint => ata(venue.pool, mint));
  if (venue.program.equals(program)) throw new TypeError('the venue must be a distinct program from CrossFlow');
  if (venue.pool.equals(batch_authority)) throw new TypeError('venue pool aliases the batch authority');
  const reserved = new Set([...base.owner_states, ...base.intents, ...base.vaults.flat(), ...base.recipients.flat(), batch_authority]
    .map(key => key.toBase58()));
  for (const pool of pools) {
    if (reserved.has(pool.toBase58())) throw new TypeError(`a batch pool aliases an intent account: ${pool.toBase58()}`);
  }
  for (const vault of vaults) {
    if (reserved.has(vault.toBase58())) throw new TypeError(`a venue vault aliases a batch account: ${vault.toBase58()}`);
  }
  return { ...base, batch_authority, pools, venue: { ...venue, vaults } };
}

export function encodeSettleRoutedData(body: Uint8Array): Buffer {
  if (!(body instanceof Uint8Array) || body.length === 0 || body.length > 194) throw new RangeError('settlement body must be 1–194 bytes');
  const length = Buffer.alloc(4); length.writeUInt32LE(body.length);
  return Buffer.concat([SETTLE_ROUTED_DISCRIMINATOR, length, Buffer.from(body)]);
}

export function buildSettleRoutedInstruction(program: PublicKey, accounts: RoutedBatchAccounts, body: Uint8Array): TransactionInstruction {
  const grouped: AccountMeta[] = [];
  for (let i = 0; i < accounts.members.length; i++) {
    grouped.push(
      { pubkey: accounts.owner_states[i], isSigner: false, isWritable: false },
      { pubkey: accounts.intents[i], isSigner: false, isWritable: true },
      ...accounts.vaults[i].map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
      ...accounts.recipients[i].map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    );
  }
  return new TransactionInstruction({ programId: program, data: encodeSettleRoutedData(body), keys: [
    { pubkey: accounts.config, isSigner: false, isWritable: false },
    { pubkey: accounts.prices, isSigner: false, isWritable: false },
    ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
    { pubkey: accounts.batch_authority, isSigner: false, isWritable: false },
    ...accounts.pools.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    { pubkey: accounts.venue.program, isSigner: false, isWritable: false },
    { pubkey: accounts.venue.pool, isSigner: false, isWritable: true },
    ...accounts.venue.vaults.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ...grouped,
  ] });
}
