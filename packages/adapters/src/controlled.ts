import { createHash } from 'node:crypto';
import { AccountMeta, ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { CONTROLLED_VENUE_MAX_FEE_BPS, CONTROLLED_VENUE_MAX_LEGS, ResidualAdapter, canonicalAta, controlledQuote, requireAscendingMints } from './types.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SDK_PROGRAM = new PublicKey('Bq1FxNWHnmnZgJRi6fsRKrvLTbBf6uDTXjaawzdnkw1Q');
export const VENUE_COMPUTE_UNIT_LIMIT = 200_000;

export interface ControlledVenueConfig {
  programId: PublicKey;
  pool: PublicKey;
  /** CrossFlow's batch PDA: the only account that may sign a venue swap. */
  poolAuthority: PublicKey;
  mints: PublicKey[];
  feeBps: number;
  label: string;
}

/** The public deployment manifest pins the venue program; a local run may override it explicitly. */
export function deriveControlledPool(programId: PublicKey, mints: PublicKey[]): PublicKey {
  requireAscendingMints(mints);
  return PublicKey.findProgramAddressSync([Buffer.from('pool'), mints[0].toBuffer(), mints[1].toBuffer(), mints[2].toBuffer()], programId)[0];
}

export class ControlledVenue implements ResidualAdapter {
  readonly programId: PublicKey;
  readonly pool: PublicKey;
  readonly poolAuthority: PublicKey;
  readonly mints: PublicKey[];
  readonly feeBps: number;
  readonly label: string;

  constructor(config: ControlledVenueConfig) {
    if (!(config.programId instanceof PublicKey) || !(config.pool instanceof PublicKey) || !(config.poolAuthority instanceof PublicKey)) {
      throw new TypeError('venue program, pool and authority must be public keys');
    }
    requireAscendingMints(config.mints);
    if (!Number.isInteger(config.feeBps) || config.feeBps < 0 || config.feeBps > CONTROLLED_VENUE_MAX_FEE_BPS) throw new RangeError('venue fee out of range');
    const expected = deriveControlledPool(config.programId, config.mints);
    if (!expected.equals(config.pool)) throw new TypeError('pool is not the derived venue pool for these mints');
    this.programId = config.programId;
    this.pool = config.pool;
    this.poolAuthority = config.poolAuthority;
    this.mints = [...config.mints];
    this.feeBps = config.feeBps;
    this.label = config.label;
  }

  vaults(): PublicKey[] {
    return this.mints.map(mint => canonicalAta(this.pool, mint));
  }

  /** The venue holds one reserve per mint; a caller reads them from chain before quoting. */
  quoteFromReserves(reserves: bigint[], inputIndex: number, outputIndex: number, amountIn: bigint): bigint {
    if (reserves.length !== 3) throw new TypeError('three reserves required');
    if (!Number.isInteger(inputIndex) || !Number.isInteger(outputIndex) || inputIndex === outputIndex || inputIndex < 0 || outputIndex < 0 || inputIndex > 2 || outputIndex > 2) {
      throw new RangeError('swap direction must name two distinct configured reserves');
    }
    return controlledQuote(reserves[inputIndex], reserves[outputIndex], amountIn, this.feeBps);
  }

  /** Build the only instruction form the pinned venue admits. */
  buildSwap(inputIndex: number, outputIndex: number, amountIn: bigint, minOut: bigint): TransactionInstruction {
    if (!Number.isInteger(inputIndex) || !Number.isInteger(outputIndex) || inputIndex === outputIndex || inputIndex < 0 || outputIndex < 0 || inputIndex > 2 || outputIndex > 2) {
      throw new RangeError('swap direction must name two distinct configured reserves');
    }
    if (amountIn <= 0n || amountIn > (1n << 64n) - 1n) throw new RangeError('amount in out of range');
    if (minOut <= 0n || minOut > (1n << 64n) - 1n) throw new RangeError('minimum out must be positive');
    const vaults = this.vaults();
    const keys: AccountMeta[] = [
      { pubkey: this.poolAuthority, isSigner: true, isWritable: false },
      { pubkey: this.pool, isSigner: false, isWritable: true },
      { pubkey: this.mints[inputIndex], isSigner: false, isWritable: false },
      { pubkey: this.mints[outputIndex], isSigner: false, isWritable: false },
      { pubkey: canonicalAta(this.poolAuthority, this.mints[inputIndex]), isSigner: false, isWritable: true },
      { pubkey: canonicalAta(this.poolAuthority, this.mints[outputIndex]), isSigner: false, isWritable: true },
      { pubkey: vaults[inputIndex], isSigner: false, isWritable: true },
      { pubkey: vaults[outputIndex], isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), isSigner: false, isWritable: false },
    ];
    const data = Buffer.alloc(8 + 1 + 1 + 8 + 8);
    createHash('sha256').update('global:swap').digest().subarray(0, 8).copy(data, 0);
    data.writeUInt8(inputIndex, 8);
    data.writeUInt8(outputIndex, 9);
    data.writeBigUInt64LE(amountIn, 10);
    data.writeBigUInt64LE(minOut, 18);
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  buildInitializePool(): TransactionInstruction {
    const data = Buffer.alloc(8 + 2);
    createHash('sha256').update('global:initialize_pool').digest().subarray(0, 8).copy(data, 0);
    data.writeUInt16LE(this.feeBps, 8);
    return new TransactionInstruction({ programId: this.programId, keys: [
      { pubkey: this.poolAuthority, isSigner: true, isWritable: true },
      { pubkey: this.pool, isSigner: false, isWritable: true },
      ...this.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
    ], data });
  }

  static readonly MAX_LEGS = CONTROLLED_VENUE_MAX_LEGS;
  static readonly SDK_PROGRAM_ID = SDK_PROGRAM;
}

/** The venue swap is one bounded instruction; the caller pays an explicit compute budget. */
export function venueTransaction(instruction: TransactionInstruction): Transaction {
  return new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: VENUE_COMPUTE_UNIT_LIMIT }), instruction);
}
