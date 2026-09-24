import { PublicKey } from '@solana/web3.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * The residual adapter contract. CrossFlow pins a program, a pool, a pool authority and the
 * pool's canonical vaults in its committed policy; an adapter may only build the exact
 * instruction form the pinned program admits. It never chooses a destination: outputs go to the
 * caller-derived canonical account for the output mint.
 */
export interface ResidualAdapter {
  readonly programId: PublicKey;
  readonly pool: PublicKey;
  readonly poolAuthority: PublicKey;
  readonly mints: PublicKey[];
  /** Canonical pool vault per configured mint, in policy mint order. */
  vaults(): PublicKey[];
  /** Deterministic quote for an exact-in leg. The on-chain program recomputes and enforces it. */
  quoteFromReserves(reserves: bigint[], inputIndex: number, outputIndex: number, amountIn: bigint): bigint;
  readonly feeBps: number;
  readonly label: string;
}

export const CONTROLLED_VENUE_MAX_FEE_BPS = 300;
export const CONTROLLED_VENUE_MAX_LEGS = 2;

export function canonicalAta(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM): PublicKey {
  if (!(tokenProgram instanceof PublicKey)) throw new TypeError('token program required');
  if (owner.equals(PublicKey.default) || mint.equals(PublicKey.default)) throw new TypeError('zero owner or mint rejected');
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}

export function requireAscendingMints(mints: PublicKey[]): void {
  if (mints.length !== 3) throw new TypeError('exactly three configured mints required');
  for (let i = 1; i < mints.length; i++) {
    if (Buffer.compare(mints[i - 1].toBuffer(), mints[i].toBuffer()) >= 0) throw new TypeError('mint order must be unique ascending bytes');
  }
}

/** Exact-in constant product with the fee charged on the input and floored, mirroring the program. */
export function controlledQuote(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > CONTROLLED_VENUE_MAX_FEE_BPS) throw new RangeError('venue fee out of range');
  if (amountIn <= 0n || amountIn > (1n << 64n) - 1n) throw new RangeError('exact-in amount out of range');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new RangeError('empty reserve cannot quote');
  const net = amountIn * BigInt(10_000 - feeBps);
  const out = (reserveOut * net) / (reserveIn * 10_000n + net);
  if (out >= reserveOut) throw new RangeError('quote would exhaust the reserve');
  return out;
}
