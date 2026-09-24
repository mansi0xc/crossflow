import { AccountMeta, ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { discriminator } from './discriminators.js';
import { Buffer } from 'buffer';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const MAX_AMOUNT = 1_000_000_000_000n;
export const FUNDING_COMPUTE_UNIT_LIMIT = 600_000;
const MAX_U64 = (1n << 64n) - 1n;

export interface FundAssetInput { funding: string; min_output: string; max_output: string; funding_reference_price: string }
export interface FundRequestInput { expected_policy_hash: string; nonce: string; expiry_unix_seconds: string; optimization_commitment: string; assets: FundAssetInput[] }
export interface FundAccounts { config: PublicKey; owner_state: PublicKey; intent: PublicKey; prices: PublicKey; mints: PublicKey[]; sources: PublicKey[]; vaults: PublicKey[] }

function decimal(value: unknown, label: string, max: bigint): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${label}: canonical unsigned decimal string required`);
  const parsed = BigInt(value);
  if (parsed > max) throw new RangeError(`${label}: exceeds protocol cap`);
  return parsed;
}
function hex32(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label}: lowercase 32-byte hex required`);
  return Buffer.from(value, 'hex');
}
function u64(value: bigint): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; }
function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}


export function deriveFundAccounts(program: PublicKey, config: PublicKey, prices: PublicKey, owner: PublicKey, nonce: bigint, mints: PublicKey[]): FundAccounts {
  if (!PublicKey.isOnCurve(owner.toBytes())) throw new TypeError('funding owner must be an on-curve wallet');
  if (nonce < 0n || nonce > MAX_U64 || mints.length !== 3) throw new RangeError('invalid nonce or three-mint set required');
  for (let i = 1; i < mints.length; i++) if (Buffer.compare(mints[i - 1].toBuffer(), mints[i].toBuffer()) >= 0) throw new TypeError('mint order must be unique ascending bytes');
  const [ownerState] = PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), owner.toBuffer()], program);
  const [intent] = PublicKey.findProgramAddressSync([Buffer.from('intent'), config.toBuffer(), owner.toBuffer(), u64(nonce)], program);
  return { config, owner_state: ownerState, intent, prices, mints, sources: mints.map(mint => ata(owner, mint)), vaults: mints.map(mint => ata(intent, mint)) };
}

export function buildCreateAndFundInstruction(program: PublicKey, owner: PublicKey, accounts: FundAccounts, request: FundRequestInput): TransactionInstruction {
  if (accounts.mints.length !== 3 || accounts.sources.length !== 3 || accounts.vaults.length !== 3 || request.assets.length !== 3) throw new TypeError('exactly three configured assets required');
  const expectedAccounts = deriveFundAccounts(program, accounts.config, accounts.prices, owner, decimal(request.nonce, 'nonce', MAX_U64), accounts.mints);
  for (const key of ['owner_state', 'intent'] as const) if (!accounts[key].equals(expectedAccounts[key])) throw new TypeError(`noncanonical ${key} PDA`);
  for (const key of ['sources', 'vaults'] as const) for (let i = 0; i < 3; i++) if (!accounts[key][i].equals(expectedAccounts[key][i])) throw new TypeError(`noncanonical ${key}[${i}] ATA`);
  const policyHash = hex32(request.expected_policy_hash, 'policy hash');
  const commitment = hex32(request.optimization_commitment, 'optimization commitment');
  const nonce = decimal(request.nonce, 'nonce', MAX_U64);
  const expiry = decimal(request.expiry_unix_seconds, 'expiry', MAX_U64);
  if (expiry === 0n || commitment.equals(Buffer.alloc(32))) throw new RangeError('expiry and optimization commitment must be nonzero');
  const assets = request.assets.map((asset, i) => {
    const funding = decimal(asset.funding, `assets[${i}].funding`, MAX_AMOUNT);
    const minOutput = decimal(asset.min_output, `assets[${i}].min_output`, MAX_AMOUNT);
    const maxOutput = decimal(asset.max_output, `assets[${i}].max_output`, MAX_AMOUNT);
    const reference = decimal(asset.funding_reference_price, `assets[${i}].funding_reference_price`, MAX_AMOUNT);
    if (minOutput > maxOutput || reference === 0n) throw new RangeError(`invalid output bounds or reference price for asset ${i}`);
    return Buffer.concat([u64(funding), u64(minOutput), u64(maxOutput), u64(reference)]);
  });
  if (assets.every((_, i) => request.assets[i].funding === '0')) throw new RangeError('empty funding slice');
  const data = Buffer.concat([Buffer.from([1]), policyHash, u64(nonce), u64(expiry), commitment, ...assets]);
  if (data.length !== 177) throw new Error('funding wire body must be exactly 177 bytes');
  const keys: AccountMeta[] = [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: accounts.config, isSigner: false, isWritable: true },
    { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
    { pubkey: accounts.intent, isSigner: false, isWritable: true },
    { pubkey: accounts.prices, isSigner: false, isWritable: false },
    ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
    ...accounts.sources.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    ...accounts.vaults.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: program, keys, data: Buffer.concat([discriminator('create_and_fund'), data]) });
}

/** Funding creates up to three ATAs and performs three checked transfers; simulations use an explicit bounded CU budget. */
export function fundingTransaction(instruction: TransactionInstruction): Transaction {
  return new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: FUNDING_COMPUTE_UNIT_LIMIT }), instruction);
}
