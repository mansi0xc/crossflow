import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

/**
 * Chain-side intent reading, shared by the browser and the service.
 *
 * The browser must be able to enumerate an owner's intents **without the service**, because
 * recovery is advertised as needing only the wallet and the chain. There is one decoder here so
 * the two callers cannot disagree about the account layout.
 */
export const INTENT_SPACE = 522;
export const OWNER_STATE_SPACE = 114;
const INTENT_DISCRIMINATOR = Buffer.from([0xf7, 0xa2, 0x23, 0xa5, 0xfe, 0x6f, 0x81, 0x6d]);

export interface OnChainIntent {
  address: string;
  config: string;
  owner: string;
  nonce: string;
  expiryUnixSeconds: string;
  policyHash: string;
  mandateHash: string;
  optimizationCommitment: string;
  assets: { funding: string; minOutput: string; maxOutput: string; fundingReferencePrice: string }[];
  recipients: string[];
  vaults: string[];
  bookedClaims: string[];
  initialSurplus: string[];
  status: number;
  statusLabel: 'Funded' | 'Settled' | 'Cancelled' | 'Unknown';
  observedAt: string;
}

const STATUS_LABELS = ['Funded', 'Settled', 'Cancelled'] as const;
const keyAt = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
const hexAt = (data: Buffer, offset: number) => data.subarray(offset, offset + 32).toString('hex');

export function decodeIntent(address: string, data: Buffer, observedAt = new Date().toISOString()): OnChainIntent {
  if (data.length !== INTENT_SPACE) throw new RangeError(`intent ${address} has unexpected length ${data.length}`);
  if (!data.subarray(0, 8).equals(INTENT_DISCRIMINATOR)) throw new TypeError(`intent ${address} discriminator mismatch`);
  const status = data[520];
  return {
    address,
    config: keyAt(data, 8),
    owner: keyAt(data, 40),
    nonce: data.readBigUInt64LE(72).toString(),
    expiryUnixSeconds: data.readBigUInt64LE(80).toString(),
    policyHash: hexAt(data, 88),
    mandateHash: hexAt(data, 120),
    optimizationCommitment: hexAt(data, 152),
    assets: [0, 1, 2].map(index => ({
      funding: data.readBigUInt64LE(184 + index * 32).toString(),
      minOutput: data.readBigUInt64LE(192 + index * 32).toString(),
      maxOutput: data.readBigUInt64LE(200 + index * 32).toString(),
      fundingReferencePrice: data.readBigUInt64LE(208 + index * 32).toString(),
    })),
    recipients: [0, 1, 2].map(index => keyAt(data, 280 + index * 32)),
    vaults: [0, 1, 2].map(index => keyAt(data, 376 + index * 32)),
    bookedClaims: [0, 1, 2].map(index => data.readBigUInt64LE(472 + index * 8).toString()),
    initialSurplus: [0, 1, 2].map(index => data.readBigUInt64LE(496 + index * 8).toString()),
    status,
    statusLabel: STATUS_LABELS[status] ?? 'Unknown',
    observedAt,
  };
}

/** Order by raw owner bytes, which is the order the program and the planner both require. */
export function byOwnerBytes(a: OnChainIntent, b: OnChainIntent): number {
  return Buffer.compare(new PublicKey(a.owner).toBuffer(), new PublicKey(b.owner).toBuffer());
}

/**
 * The owner's persistent nonce, read from chain.
 *
 * Every funding consumes the current nonce and increments it, so a client that hard-codes zero can
 * fund once and never again. Returns 0 for an owner that has never funded.
 */
export async function readOwnerNextNonce(connection: Connection, programId: PublicKey, config: PublicKey, owner: PublicKey, timeoutMs = 15_000) {
  const [address] = PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), owner.toBuffer()], programId);
  const info = await withTimeout(connection.getAccountInfo(address, 'confirmed'), timeoutMs, 'getAccountInfo');
  if (!info) return { nonce: 0n, activeIntent: null as string | null, exists: false };
  const state = decodeOwnerState(info.data as Buffer);
  return { nonce: BigInt(state.nextNonce), activeIntent: state.activeIntent, exists: true };
}

export function decodeOwnerState(data: Buffer) {
  if (data.length !== OWNER_STATE_SPACE) throw new RangeError(`owner state has unexpected length ${data.length}`);
  return {
    nextNonce: data.readBigUInt64LE(72).toString(),
    activeIntent: data[80] === 1 ? keyAt(data, 81) : null,
  };
}

async function scan(connection: Connection, programId: PublicKey, config: PublicKey, timeoutMs: number): Promise<OnChainIntent[]> {
  const accounts = await connection.getProgramAccounts(programId, { commitment: 'confirmed', filters: [{ dataSize: INTENT_SPACE }] });
  const configAddress = config.toBase58();
  return accounts
    .map(({ pubkey, account }: { pubkey: PublicKey; account: AccountInfo<Buffer> }) => {
      try { return decodeIntent(pubkey.toBase58(), account.data as Buffer); }
      catch { return null; }
    })
    .filter((intent): intent is OnChainIntent => intent !== null && intent.config === configAddress)
    .sort(byOwnerBytes);
}

/** Every intent for one config. Used by the service, which then summarises them. */
export function listIntents(connection: Connection, programId: PublicKey, config: PublicKey, timeoutMs = 15_000) {
  return withTimeout(scan(connection, programId, config, timeoutMs), timeoutMs, 'getProgramAccounts');
}

/** One owner's intents. The browser uses this so recovery never depends on the service. */
export async function listOwnerIntents(connection: Connection, programId: PublicKey, config: PublicKey, owner: PublicKey, timeoutMs = 15_000) {
  const all = await listIntents(connection, programId, config, timeoutMs);
  const address = owner.toBase58();
  return all.filter(intent => intent.owner === address);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
