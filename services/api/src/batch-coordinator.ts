import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { buildSettleBatchInstruction, buildSettleRoutedInstruction, deriveBatchAccounts, deriveBatchAuthority, deriveRoutedBatchAccounts } from '../../../packages/client/src/build-batch.js';
import { encodeSettlementBody, validateCandidatePlan } from '../../../packages/planner/src/validate.js';
import { decodeIntent, listFundedIntents, readOwnerState, withTimeout, type OnChainIntent } from './intent-index.js';

/**
 * Turn a caller-supplied plan into an unsigned settlement transaction.
 *
 * The service never invents a plan and never signs. It reloads the funded mandates from chain,
 * validates the plan through the independent planner, and only then builds the instruction. A
 * plan that the validator rejects never becomes a transaction.
 */
export const SNAPSHOT_SPACE = 419;
const OBSERVATION_SIZE = 102;
const OBSERVATION_START = 113;

export interface CoordinatorOptions {
  connection: Connection;
  programId: PublicKey;
  manifest: { deployment_id: string; genesis: string; config_address: string; initial_policy_hash: string; policy: unknown };
  timeoutMs: number;
  maxOwners: number;
}

export interface ReadSnapshot {
  policyHash: string;
  publisher: string;
  sequence: string;
  marketClosed: boolean;
  assets: { feedId: string; price: string; confidence: string; underlyingObservedAt: string; publishedAt: string }[];
}

export function decodeSnapshot(data: Buffer): ReadSnapshot {
  if (data.length !== SNAPSHOT_SPACE) throw new RangeError(`snapshot has unexpected length ${data.length}`);
  const assets = [0, 1, 2].map(i => {
    const base = OBSERVATION_START + i * OBSERVATION_SIZE;
    return {
      feedId: data.subarray(base + 32, base + 64).toString('hex'),
      price: data.readBigUInt64LE(base + 64).toString(),
      confidence: data.readBigUInt64LE(base + 72).toString(),
      underlyingObservedAt: data.readBigUInt64LE(base + 85).toString(),
      publishedAt: data.readBigUInt64LE(base + 93).toString(),
    };
  });
  return {
    policyHash: data.subarray(40, 72).toString('hex'),
    publisher: new PublicKey(data.subarray(72, 104)).toBase58(),
    sequence: data.readBigUInt64LE(105).toString(),
    marketClosed: assets.some((_, i) => data[OBSERVATION_START + i * OBSERVATION_SIZE + 101] === 1),
    assets,
  };
}

export async function readSnapshot(options: CoordinatorOptions, observedAt: string): Promise<ReadSnapshot & { address: string; observedAt: string }> {
  const config = new PublicKey(options.manifest.config_address);
  const [address] = PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], options.programId);
  const info = await withTimeout(options.connection.getAccountInfo(address, 'confirmed'), options.timeoutMs, 'getAccountInfo');
  if (!info || !info.owner.equals(options.programId)) throw new Error('fixture snapshot is missing or has the wrong owner');
  return { ...decodeSnapshot(info.data as Buffer), address: address.toBase58(), observedAt };
}

async function vaultBalances(options: CoordinatorOptions, vaults: PublicKey[]): Promise<string[]> {
  const infos = await withTimeout(options.connection.getMultipleAccountsInfo(vaults, 'confirmed'), options.timeoutMs, 'getMultipleAccountsInfo');
  return infos.map((info, i) => {
    if (!info) throw new Error(`vault ${vaults[i].toBase58()} is missing`);
    if (info.data.length !== 165) throw new Error(`vault ${vaults[i].toBase58()} is not a token account`);
    return (info.data as Buffer).readBigUInt64LE(64).toString();
  });
}

export interface PrepareRequest {
  plan: unknown;
  operator: string;
  lookupTable?: string;
  technicalProbe?: boolean;
}

export interface PrepareResult {
  status: 'PREPARED' | 'REJECTED';
  reason?: string;
  transaction?: string;
  versioned?: boolean;
  preview?: Record<string, unknown>;
  mandateHashes?: string[];
  debits?: string[][];
  credits?: string[][];
  outputs?: string[][];
  externalNet?: string[];
}

export async function prepareBatch(options: CoordinatorOptions, request: PrepareRequest): Promise<PrepareResult> {
  const operator = new PublicKey(request.operator);
  if (!PublicKey.isOnCurve(operator.toBytes())) return { status: 'REJECTED', reason: 'operator must be a wallet key' };
  const observedAt = new Date().toISOString();
  const intents = await listFundedIntents({
    connection: options.connection, programId: options.programId,
    configAddress: new PublicKey(options.manifest.config_address), timeoutMs: options.timeoutMs,
  });
  const funded = intents.filter(intent => intent.status === 0);
  if (funded.length < 2 || funded.length > options.maxOwners) {
    return { status: 'REJECTED', reason: `expected 2–${options.maxOwners} funded intents, found ${funded.length}` };
  }

  const snapshot = await readSnapshot(options, observedAt);
  const config = new PublicKey(options.manifest.config_address);
  const contextIntents = [];
  for (const intent of funded) {
    const owner = new PublicKey(intent.owner);
    const state = await readOwnerState(options.connection, options.programId, config, owner, options.timeoutMs);
    if (!state || state.activeIntent !== intent.address) return { status: 'REJECTED', reason: `owner state for ${intent.owner} is not bound to ${intent.address}` };
    const vaults = intent.vaults.map(vault => new PublicKey(vault));
    const balances = await vaultBalances(options, vaults);
    contextIntents.push({
      mandate: {
        genesis: options.manifest.genesis, program_id: options.programId.toBase58(),
        config_address: options.manifest.config_address, schema_version: '1',
        policy_hash: intent.policyHash, owner: intent.owner, nonce: intent.nonce,
        expiry_unix_seconds: intent.expiryUnixSeconds, optimization_commitment: intent.optimizationCommitment,
        assets: (options.manifest.policy as { assets: { mint: string; token_program: string; decimals: string }[] }).assets
          .map((asset, i) => ({
            mint: asset.mint, token_program: asset.token_program, decimals: asset.decimals,
            recipient_ata: intent.recipients[i],
            funding: intent.assets[i].funding, min_output: intent.assets[i].minOutput,
            max_output: intent.assets[i].maxOutput, funding_reference_price: intent.assets[i].fundingReferencePrice,
          })),
      },
      stored_mandate_hash: intent.mandateHash,
      stored_status: 'Funded',
      stored_nonce: intent.nonce,
      booked_funding: intent.bookedClaims,
      vault_balances: balances,
    });
  }

  const context = {
    policy: options.manifest.policy,
    expected_genesis: options.manifest.genesis,
    now_unix_seconds: Math.floor(Date.now() / 1000).toString(),
    technical_probe: request.technicalProbe === true,
    snapshot: {
      policy_hash: snapshot.policyHash, publisher: snapshot.publisher, sequence: snapshot.sequence,
      market_closed: snapshot.marketClosed,
      assets: snapshot.assets.map(asset => ({ feed_id: asset.feedId, price: asset.price, confidence: asset.confidence,
        underlying_observed_at: asset.underlyingObservedAt, published_at: asset.publishedAt })),
    },
    intents: contextIntents,
  };

  let validated;
  try {
    validated = await validateCandidatePlan(structuredClone(request.plan), context);
  } catch (error) {
    return { status: 'REJECTED', reason: `plan rejected: ${String(error instanceof Error ? error.message : error)}` };
  }

  const mints = (options.manifest.policy as { assets: { mint: string }[] }).assets
    .map(asset => new PublicKey(Buffer.from(asset.mint, 'hex')));
  const members = funded.map(intent => ({ owner: new PublicKey(intent.owner), nonce: BigInt(intent.nonce) }));
  const body = encodeSettlementBody(validated.plan, funded.length);
  const route = (options.manifest.policy as { route_kind: string }).route_kind === '1';

  let transaction: Transaction | VersionedTransaction;
  try {
    if (route) {
      if (!validated.quote_dependent) throw new Error('an enabled route requires at least one residual record');
      const policy = options.manifest.policy as { route_program: string; pool: string };
      const accounts = deriveRoutedBatchAccounts(options.programId, config, new PublicKey(snapshot.address), mints, members,
        { program: new PublicKey(Buffer.from(policy.route_program, 'hex')), pool: new PublicKey(Buffer.from(policy.pool, 'hex')) });
      const instruction = buildSettleRoutedInstruction(options.programId, accounts, body);
      transaction = new Transaction().add(instruction);
    } else {
      if (validated.quote_dependent) throw new Error('the committed policy has routing disabled');
      const accounts = deriveBatchAccounts(options.programId, config, new PublicKey(snapshot.address), mints, members);
      transaction = new Transaction().add(buildSettleBatchInstruction(options.programId, accounts, body));
    }
    transaction.feePayer = operator;
    transaction.recentBlockhash = (await withTimeout(options.connection.getLatestBlockhash('confirmed'), options.timeoutMs, 'getLatestBlockhash')).blockhash;
  } catch (error) {
    return { status: 'REJECTED', reason: `cannot build a settlement transaction: ${String(error instanceof Error ? error.message : error)}` };
  }

  const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  return {
    status: 'PREPARED',
    transaction: Buffer.from(serialized).toString('base64'),
    versioned: false,
    mandateHashes: validated.mandate_hashes,
    debits: validated.debits, credits: validated.credits, outputs: validated.outputs, externalNet: validated.external_net,
    preview: {
      batchAuthority: deriveBatchAuthority(options.programId, config).toBase58(),
      snapshotSequence: snapshot.sequence,
      owners: funded.map(intent => intent.owner),
      noOp: validated.no_op,
      quoteDependent: validated.quote_dependent,
      settlementBodyBytes: body.length,
      planHash: Buffer.from(body).toString('hex').slice(0, 32),
      requiresLookupTable: serialized.length > 1232,
      lookupTableProvided: Boolean(request.lookupTable),
      decoded: null,
      observedAt,
    },
  };
}

export function summariseIntent(intent: OnChainIntent) {
  return {
    address: intent.address, owner: intent.owner, nonce: intent.nonce,
    status: ['Funded', 'Settled', 'Cancelled'][intent.status] ?? 'Unknown',
    expiryUnixSeconds: intent.expiryUnixSeconds, mandateHash: intent.mandateHash,
    bookedClaims: intent.bookedClaims, initialSurplus: intent.initialSurplus, observedAt: intent.observedAt,
  };
}
