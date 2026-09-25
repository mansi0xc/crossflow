import { Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { parsePolicyBytes } from '../../contracts/src/index.js';

/**
 * Deployment identity read from the chain.
 *
 * The service is a convenience, not a dependency: an operator whose service is down must still be
 * able to find its own intents and recover them. Before this existed the interface could not even
 * name the config without the API, so a cold start during an outage showed nothing at all.
 *
 * The program id is a build-time constant; everything else is derived from the Config account.
 */
export const CONFIG_SPACE = 831;
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const CONFIG_DISCRIMINATOR = Buffer.from([0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82]);

export interface ChainAsset { index: number; mint: string; tokenProgram: string; decimals: number; testAsset: boolean }
export interface ChainDeployment {
  cluster: string;
  genesis: string;
  programId: string;
  config: string;
  deploymentId: string;
  policyHash: string;
  routeEnabled: boolean;
  oracleMode: number;
  oracleLabel: string;
  protocolFeeBps: string;
  maxIntentLifetimeSeconds: string;
  assets: ChainAsset[];
  policy: Record<string, unknown>;
  /** Where this identity came from, so the interface can say so rather than implying one source. */
  source: 'service' | 'chain';
}

function decodeConfig(address: string, data: Buffer) {
  if (data.length !== CONFIG_SPACE) throw new RangeError(`config has unexpected length ${data.length}`);
  if (!data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) throw new TypeError('config discriminator mismatch');
  const policy = parsePolicyBytes(data.subarray(136, 788));
  return {
    address,
    deploymentId: data.subarray(8, 40).toString('hex'),
    policyHash: data.subarray(104, 136).toString('hex'),
    admin: new PublicKey(data.subarray(788, 820)).toBase58(),
    fundingPaused: data[820] === 1,
    settlementPaused: data[821] === 1,
    outstandingClaimIntents: data.readBigUInt64LE(822).toString(),
    policy,
  };
}

export type DecodedConfig = ReturnType<typeof decodeConfig>;
export { decodeConfig };

/**
 * Find the program's Config account and build the same identity shape the service returns.
 * Returns null when the program has no config on this cluster, rather than throwing: a healthy
 * "not deployed yet" is a different situation from a failure.
 */
export async function deriveDeploymentFromChain(connection: Connection, programId: PublicKey): Promise<ChainDeployment | null> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    // A size filter keeps this cheap; the discriminator is still checked on decode.
    filters: [{ dataSize: CONFIG_SPACE }],
  });
  let decoded: DecodedConfig | null = null;
  for (const { pubkey, account } of accounts) {
    try { decoded = decodeConfig(pubkey.toBase58(), account.data as Buffer); break; }
    catch { /* not a config account */ }
  }
  if (!decoded) return null;

  const genesis = await connection.getGenesisHash();
  const assets = (decoded.policy.assets as { mint: string; token_program: string; decimals: string }[])
    .map((asset, index) => ({ index, mint: asset.mint, tokenProgram: asset.token_program,
      decimals: Number(asset.decimals), testAsset: true }));
  return {
    cluster: genesis === DEVNET_GENESIS ? 'devnet' : 'localnet',
    genesis,
    programId: programId.toBase58(),
    config: decoded.address,
    deploymentId: decoded.deploymentId,
    policyHash: decoded.policyHash,
    routeEnabled: decoded.policy.route_kind === '1',
    oracleMode: Number(decoded.policy.oracle_mode),
    oracleLabel: 'TEST PRICES; synthetic fixture oracle; no equity price claim',
    protocolFeeBps: decoded.policy.protocol_fee_bps as string,
    maxIntentLifetimeSeconds: decoded.policy.max_intent_lifetime_seconds as string,
    assets,
    policy: decoded.policy,
    source: 'chain',
  };
}
