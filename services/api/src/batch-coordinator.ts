import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { buildSettleBatchInstruction, buildSettleRoutedInstruction, deriveBatchAccounts, deriveBatchAuthority, deriveRoutedBatchAccounts } from '../../../packages/client/src/build-batch.js';
import { compileProposal } from '../../../packages/planner/src/proposal.js';
import { encodeSettlementBody, validateCandidatePlan } from '../../../packages/planner/src/validate.js';
import { decodeIntent, listFundedIntents, readOwnerState, withTimeout, type OnChainIntent } from './intent-index.js';

/**
 * Turn a caller-supplied plan into an unsigned settlement transaction.
 *
 * The service never invents a plan and never signs. It reloads the funded mandates from chain,
 * validates the plan through the independent planner, and only then builds the instruction. A
 * plan that the validator rejects never becomes a transaction.
 */
/// Comfortably above the measured 205k for an internal batch; the network rejects the excess anyway.
export const COMPUTE_UNIT_LIMIT = 1_400_000;

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
    // Hex, not base58: the planner compares this against the policy's hex fixture publisher.
    publisher: data.subarray(72, 104).toString('hex'),
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
  /**
   * A proposal to compile into the settlement instead of a caller-built body. `accounts` are the
   * per-owner internal/external splits (in any order; owners come from the funded intents on chain).
   * Supplying this is how the optimizer's own output, rather than a hand-built plan, reaches the
   * settlement boundary.
   */
  proposal?: { accounts: unknown[]; prices: Record<string, string> };
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
  if (request.proposal && (!Array.isArray(request.proposal.accounts) || request.proposal.accounts.length !== funded.length)) {
    // A proposal must describe the funded set exactly; a mismatch is refused before any chain read.
    return { status: 'REJECTED', reason: `a proposal must cover exactly the ${funded.length} funded intents` };
  }

  // Every identity in the canonical mandate is 32-byte hex; the service also carries base58 forms
  // for RPC use, and the two are not interchangeable.
  const canonical = options.manifest.policy as { genesis: string; program_id: string; config_address: string };
  const snapshot = await readSnapshot(options, observedAt);
  const config = new PublicKey(options.manifest.config_address);

  // A proposal is compiled here, by the same compiler the demonstration uses, rather than trusting a
  // caller-built settlement body. The funded intents are already in ascending owner-byte order,
  // which is the order the compiler sorts into and the order the body's indices refer to.
  let planInput: unknown = request.plan;
  let compiledNote: string | null = null;
  if (request.proposal) {
    const proposal = request.proposal;
    let compiled;
    try {
      compiled = compileProposal({
        accounts: funded.map((intent, index) => ({
          ...(proposal.accounts[index] as Record<string, unknown>),
          owner: Buffer.from(new PublicKey(intent.owner).toBytes()).toString('hex'),
        })) as never,
        prices: proposal.prices,
      });
    } catch (error) {
      return { status: 'REJECTED', reason: `the proposal could not be compiled: ${String(error instanceof Error ? error.message : error)}` };
    }
    if (compiled.unrepresented.length > 0) {
      return { status: 'REJECTED', reason: `the proposal is not fully representable: ${JSON.stringify(compiled.unrepresented)}` };
    }
    planInput = { schema_version: '1', expected_snapshot_sequence: snapshot.sequence,
      mandate_hashes: funded.map(intent => intent.mandateHash),
      crosses: compiled.crosses, residuals: compiled.residuals, estimated_outputs: compiled.expected_outputs };
    compiledNote = `compiled from a proposal: ${compiled.crosses.length} cross(es), ${compiled.residuals.length} residual leg(s)`;
  }

  const contextIntents = [];
  for (const intent of funded) {
    const owner = new PublicKey(intent.owner);
    const state = await readOwnerState(options.connection, options.programId, config, owner, options.timeoutMs);
    if (!state || state.activeIntent !== intent.address) return { status: 'REJECTED', reason: `owner state for ${intent.owner} is not bound to ${intent.address}` };
    const vaults = intent.vaults.map(vault => new PublicKey(vault));
    const balances = await vaultBalances(options, vaults);
    contextIntents.push({
      mandate: {
        genesis: canonical.genesis, program_id: canonical.program_id,
        config_address: canonical.config_address, schema_version: '1',
        policy_hash: intent.policyHash, owner: Buffer.from(owner.toBytes()).toString('hex'), nonce: intent.nonce,
        expiry_unix_seconds: intent.expiryUnixSeconds, optimization_commitment: intent.optimizationCommitment,
        assets: (options.manifest.policy as { assets: { mint: string; token_program: string; decimals: string }[] }).assets
          .map((asset, i) => ({
            mint: asset.mint, token_program: asset.token_program, decimals: asset.decimals,
            // Hex, like every other 32-byte identity in the canonical mandate.
            recipient_ata: Buffer.from(new PublicKey(intent.recipients[i]).toBytes()).toString('hex'),
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
    expected_genesis: canonical.genesis,
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
    validated = await validateCandidatePlan(structuredClone(planInput), context);
  } catch (error) {
    return { status: 'REJECTED', reason: `plan rejected: ${String(error instanceof Error ? error.message : error)}` };
  }

  const mints = (options.manifest.policy as { assets: { mint: string }[] }).assets
    .map(asset => new PublicKey(Buffer.from(asset.mint, 'hex')));
  const members = funded.map(intent => ({ owner: new PublicKey(intent.owner), nonce: BigInt(intent.nonce) }));
  const body = encodeSettlementBody(validated.plan, funded.length);
  const route = (options.manifest.policy as { route_kind: string }).route_kind === '1';

  let transaction: Transaction | VersionedTransaction;
  let blockhash: string;
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
    blockhash = (await withTimeout(options.connection.getLatestBlockhash('confirmed'), options.timeoutMs, 'getLatestBlockhash')).blockhash;
    // A three-owner batch exceeds the 200k default, so the budget must travel with the transaction.
    (transaction as Transaction).instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
    transaction.feePayer = operator;
    transaction.recentBlockhash = blockhash;
    if (request.lookupTable) {
      // Three owners do not fit the legacy packet, so a supplied lookup table is not optional
      // decoration: it is how the instruction is made sendable at all.
      const fetched = await withTimeout(options.connection.getAddressLookupTable(new PublicKey(request.lookupTable)), options.timeoutMs, 'getAddressLookupTable');
      if (!fetched.value) throw new Error('the supplied lookup table does not exist or is not active');
      const message = new TransactionMessage({ payerKey: operator, recentBlockhash: blockhash,
        instructions: (transaction as Transaction).instructions }).compileToV0Message([fetched.value]);
      transaction = new VersionedTransaction(message);
    }
  } catch (error) {
    return { status: 'REJECTED', reason: `cannot build a settlement transaction: ${String(error instanceof Error ? error.message : error)}` };
  }

  const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  return {
    status: 'PREPARED',
    transaction: Buffer.from(serialized).toString('base64'),
    versioned: transaction instanceof VersionedTransaction,
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
      legacyBytesBeforeCompilation: serialized.length,
      compiledNote,
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
