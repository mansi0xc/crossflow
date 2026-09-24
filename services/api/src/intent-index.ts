import { Connection, PublicKey } from '@solana/web3.js';
import { INTENT_SPACE, decodeIntent as decode, decodeOwnerState, listIntents, withTimeout,
  type OnChainIntent } from '../../../packages/client/src/intents.js';

export { INTENT_SPACE, withTimeout, listIntents };

/**
 * Read funded intents for the configured program from chain. The index is advisory: every value
 * it returns is re-verified against the account bytes, and nothing here is trusted by the
 * settlement builder, which validates the plan through the independent planner.
 */
export type { OnChainIntent };

/** The service uses the same decoder as the browser so the two cannot disagree. */
export function decodeIntent(address: string, data: Buffer, observedAt?: string): OnChainIntent {
  return decode(address, data, observedAt);
}

export interface IntentIndexOptions {
  connection: Connection;
  programId: PublicKey;
  configAddress: PublicKey;
  timeoutMs: number;
}

/** Funded intents for one config, in raw owner-byte order. */
export async function listFundedIntents(options: IntentIndexOptions): Promise<OnChainIntent[]> {
  return listIntents(options.connection, options.programId, options.configAddress, options.timeoutMs);
}

/** Owner states carry the persistent nonce and the single active intent. */
export async function readOwnerState(connection: Connection, programId: PublicKey, config: PublicKey, owner: PublicKey, timeoutMs: number) {
  const [address] = PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), owner.toBuffer()], programId);
  const info = await withTimeout(connection.getAccountInfo(address, 'confirmed'), timeoutMs, 'getAccountInfo');
  if (!info) return null;
  const decoded = decodeOwnerState(info.data as Buffer);
  return { address: address.toBase58(), ...decoded };
}
