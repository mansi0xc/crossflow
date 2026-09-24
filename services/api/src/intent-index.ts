import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Read funded intents for the configured program from chain. The index is advisory: every value
 * it returns is re-verified against the account bytes, and nothing here is trusted by the
 * settlement builder, which validates the plan through the independent planner.
 */
export const INTENT_SPACE = 522;
const INTENT_DISCRIMINATOR = createHash('sha256').update('account:Intent').digest().subarray(0, 8);
const OWNER_STATE_SPACE = 114;

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
  observedAt: string;
}

const u64 = (data: Buffer, offset: number) => data.readBigUInt64LE(offset).toString();
const key = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
const hex = (data: Buffer, offset: number) => data.subarray(offset, offset + 32).toString('hex');

export function decodeIntent(address: string, data: Buffer, observedAt: string): OnChainIntent {
  if (data.length !== INTENT_SPACE) throw new RangeError(`intent ${address} has unexpected length ${data.length}`);
  if (!data.subarray(0, 8).equals(INTENT_DISCRIMINATOR)) throw new TypeError(`intent ${address} discriminator mismatch`);
  return {
    address,
    config: key(data, 8),
    owner: key(data, 40),
    nonce: u64(data, 72),
    expiryUnixSeconds: u64(data, 80),
    policyHash: hex(data, 88),
    mandateHash: hex(data, 120),
    optimizationCommitment: hex(data, 152),
    assets: [0, 1, 2].map(i => ({
      funding: u64(data, 184 + i * 32),
      minOutput: u64(data, 192 + i * 32),
      maxOutput: u64(data, 200 + i * 32),
      fundingReferencePrice: u64(data, 208 + i * 32),
    })),
    recipients: [0, 1, 2].map(i => key(data, 280 + i * 32)),
    vaults: [0, 1, 2].map(i => key(data, 376 + i * 32)),
    bookedClaims: [0, 1, 2].map(i => u64(data, 472 + i * 8)),
    initialSurplus: [0, 1, 2].map(i => u64(data, 496 + i * 8)),
    status: data[520],
    observedAt,
  };
}

export interface IntentIndexOptions {
  connection: Connection;
  programId: PublicKey;
  configAddress: PublicKey;
  timeoutMs: number;
}

/** Funded intents for one config. Cancelled and settled intents are returned too, labelled. */
export async function listFundedIntents(options: IntentIndexOptions): Promise<OnChainIntent[]> {
  const { connection, programId, configAddress, timeoutMs } = options;
  const observedAt = new Date().toISOString();
  const accounts = await withTimeout(
    connection.getProgramAccounts(programId, {
      commitment: 'confirmed',
      // A data-size filter avoids base58 memcmp encoding and is cheap server-side; the
      // discriminator and the config field are both checked below.
      filters: [{ dataSize: INTENT_SPACE }],
    }),
    timeoutMs,
    'getProgramAccounts',
  );
  const config = configAddress.toBase58();
  return accounts
    .map(({ pubkey, account }) => {
      try {
        return decodeIntent(pubkey.toBase58(), account.data as Buffer, observedAt);
      } catch {
        return null;
      }
    })
    .filter((intent): intent is OnChainIntent => intent !== null && intent.config === config)
    .sort((a, b) => a.owner.localeCompare(b.owner));
}

/** Owner states carry the persistent nonce and the single active intent. */
export async function readOwnerState(connection: Connection, programId: PublicKey, config: PublicKey, owner: PublicKey, timeoutMs: number) {
  const [address] = PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), owner.toBuffer()], programId);
  const info = await withTimeout(connection.getAccountInfo(address, 'confirmed'), timeoutMs, 'getAccountInfo');
  if (!info) return null;
  const data = info.data as Buffer;
  if (data.length !== OWNER_STATE_SPACE) return null;
  return { address: address.toBase58(), nextNonce: u64(data, 72), activeIntent: data[80] === 1 ? key(data, 81) : null };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}
