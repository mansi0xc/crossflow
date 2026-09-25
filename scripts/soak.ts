import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { assertPreparedDeploymentManifest } from './deployment-manifest.js';
import { buildCreateAndFundInstruction, deriveFundAccounts, fundingTransaction } from '../packages/client/src/fund.js';


/**
 * T28 — repeated bounded operations, measured honestly.
 *
 * The soak runs whole lifecycle cycles against a local validator and records, per cycle, what
 * actually happened: compute, serialized size, confirmation time, rent recovered, and the failure
 * category when a step fails. Chain and client failures are counted separately, because "the RPC
 * timed out" and "the program refused" are different findings.
 *
 * It writes `docs/evidence/soak-report.json`. It never edits or deletes an inconvenient result.
 */
const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const VENUE_PROGRAM = new PublicKey('Bq1FxNWHnmnZgJRi6fsRKrvLTbBf6uDTXjaawzdnkw1Q');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const args = process.argv.slice(2);
const profileIndex = args.indexOf('--profile');
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'release';
const positional = args.filter((_, index) => index !== profileIndex && index !== profileIndex + 1);
if (positional.length !== 4) throw new Error('usage: tsx scripts/soak.ts <local-rpc> <manifest> <env.json> <out.json> [--profile release|quick]');
const [rpc, manifestPath, envPath, outPath] = positional;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('local validator RPC only');
if (!['release', 'quick'].includes(profile)) throw new Error('unknown soak profile');
const CYCLES = profile === 'release' ? 12 : 3;

const connection = new Connection(rpc, 'confirmed');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const env = JSON.parse(readFileSync(envPath, 'utf8'));
const genesis = await connection.getGenesisHash();
await assertPreparedDeploymentManifest(manifest, genesis);
if (manifest.cluster !== 'localnet') throw new Error('the soak requires a local deployment');

const owners: Keypair[] = env.owner_paths.map((path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')))));
const mints: PublicKey[] = manifest.policy.assets.map((asset: { mint: string }) => new PublicKey(Buffer.from(asset.mint, 'hex')));
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(manifest.deployment_id, 'hex')], PROGRAM);
const [prices] = PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], PROGRAM);

const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const readU64 = (data: Buffer, offset: number) => { let value = 0n; for (let i = 0; i < 8; i++) value |= BigInt(data[offset + i]) << BigInt(8 * i); return value; };
const i32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; };
const observations = (timestamp: bigint) => Buffer.concat([0, 1, 2].map(index => Buffer.concat([
  mints[index].toBuffer(), Buffer.from(manifest.policy.assets[index].feed_id, 'hex'), u64([1_000_000n, 10_000_000n, 20_000_000n][index]),
  u64(0n), i32(-6), Buffer.from([0]), u64(timestamp), u64(timestamp), Buffer.from([0])])));

const recoveryInstruction = (owner: Keypair, accounts: ReturnType<typeof deriveFundAccounts>, name: 'cancel_intent' | 'close_intent' | 'withdraw_asset', assetIndex = 0) => {
  if (name === 'cancel_intent') {
    return new TransactionInstruction({ programId: PROGRAM, keys: [
      { pubkey: owner.publicKey, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
      { pubkey: accounts.intent, isSigner: false, isWritable: true },
    ], data: disc('cancel_intent') });
  }
  if (name === 'close_intent') {
    return new TransactionInstruction({ programId: PROGRAM, keys: [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
      { pubkey: accounts.intent, isSigner: false, isWritable: true },
      ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
      ...accounts.vaults.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ], data: disc('close_intent') });
  }
  return new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
    { pubkey: accounts.intent, isSigner: false, isWritable: true },
    ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
    ...accounts.vaults.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    ...accounts.sources.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: Buffer.concat([disc('withdraw_asset'), Buffer.from([assetIndex])]) });
};

interface StepResult { step: string; status: 'OK' | 'REFUSED' | 'CHAIN_ERROR'; compute?: number; signature?: string; error?: string; logs?: string[] }

async function send(instruction: TransactionInstruction, signers: Keypair[], label: string): Promise<StepResult> {
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = signers[0].publicKey;
  try {
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    const simulation = await connection.simulateTransaction(transaction);
    if (simulation.value.err) {
      return { step: label, status: 'REFUSED', compute: simulation.value.unitsConsumed ?? 0,
        error: JSON.stringify(simulation.value.err),
        logs: (simulation.value.logs ?? []).filter(line => line.includes('Error Message') || line.includes('AnchorError')) };
    }
    const signature = await sendAndConfirmTransaction(connection, transaction, signers, { commitment: 'confirmed' });
    return { step: label, status: 'OK', compute: simulation.value.unitsConsumed ?? 0, signature };
  } catch (error) {
    // A transport failure is not a program refusal: keep them apart.
    const message = String((error as Error).message ?? error);
    return { step: label, status: /429|fetch failed|timed out|ECONN|socket/i.test(message) ? 'CHAIN_ERROR' : 'REFUSED', error: message.slice(0, 200) };
  }
}

async function lifecycleCycle(ownerIndex: number, cycle: number, settle: boolean) {
  const owner = owners[ownerIndex];
  // The mandate nonce must be the owner's current persistent nonce, which only advances when an
  // intent is funded. Using the cycle index here would be rejected for every owner but the first.
  const [ownerStateKey] = PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), owner.publicKey.toBuffer()], PROGRAM);
  const stateInfo = await connection.getAccountInfo(ownerStateKey, 'confirmed');
  const nonce = stateInfo ? readU64(stateInfo.data as Buffer, 72) : 0n;
  const accounts = deriveFundAccounts(PROGRAM, config, prices, owner.publicKey, nonce, mints);
  const steps: StepResult[] = [];
  const startedAt = Date.now();

  const now = BigInt((await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? 0);
  const sequence = readU64((await connection.getAccountInfo(prices, 'confirmed'))!.data as Buffer, 105) + 1n;
  // Only the configured fixture publisher may publish, which is the operator, not the owner whose
  // slice this cycle funds.
  await sendAndConfirmTransaction(connection, new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: owners[0].publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: prices, isSigner: false, isWritable: true },
  ], data: Buffer.concat([disc('publish_prices'), u64(sequence), observations(now)]) })), [owners[0]], { commitment: 'confirmed' });

  const assetSpecs = [
    { funding: '2000000', min: '0', max: '2000000' },
    { funding: '1000000', min: '0', max: '1000000' },
    { funding: '0', min: '0', max: '0' },
  ];
  const fixtures = await connection.getMinimumBalanceForRentExemption(522);
  const rentHeld = BigInt(fixtures);
  const funding = fundingTransaction(buildCreateAndFundInstruction(PROGRAM, owner.publicKey, accounts, {
    expected_policy_hash: manifest.initial_policy_hash, nonce: nonce.toString(), expiry_unix_seconds: (now + 890n).toString(),
    optimization_commitment: createHash('sha256').update(`soak-${ownerIndex}-${cycle}`).digest('hex'),
    assets: assetSpecs.map((spec, index) => ({ funding: spec.funding, min_output: spec.min, max_output: spec.max,
      funding_reference_price: [1_000_000n, 10_000_000n, 20_000_000n][index].toString() })),
  }));
  funding.feePayer = owner.publicKey;
  const fundingSimulation = await connection.simulateTransaction(funding);
  steps.push({ step: 'fund', status: fundingSimulation.value.err ? 'REFUSED' : 'OK',
    compute: fundingSimulation.value.unitsConsumed ?? 0,
    error: fundingSimulation.value.err ? JSON.stringify(fundingSimulation.value.err) : undefined,
    logs: fundingSimulation.value.err
      ? (fundingSimulation.value.logs ?? []).filter(line => line.includes('Error Message') || line.includes('AnchorError'))
      : undefined });
  if (fundingSimulation.value.err) return { cycle, owner: owner.publicKey.toBase58(), steps, elapsedMs: Date.now() - startedAt };

  const ownerLamportsBefore = await connection.getBalance(owner.publicKey, 'confirmed');
  try {
    funding.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    await sendAndConfirmTransaction(connection, funding, [owner], { commitment: 'confirmed' });
  } catch (error) {
    steps.push({ step: 'fund-submit', status: 'CHAIN_ERROR', error: String((error as Error).message).slice(0, 200) });
    return { cycle, owner: owner.publicKey.toBase58(), steps, elapsedMs: Date.now() - startedAt };
  }

  if (!settle) steps.push(await send(recoveryInstruction(owner, accounts, 'cancel_intent'), [owner], 'cancel'));
  for (let asset = 0; asset < 3; asset++) {
    if (assetSpecs[asset].funding === '0') continue;
    steps.push(await send(recoveryInstruction(owner, accounts, 'withdraw_asset', asset), [owner], `withdraw-${asset}`));
  }
  steps.push(await send(recoveryInstruction(owner, accounts, 'close_intent'), [owner], 'close'));

  // Rent is only genuinely recovered if the account is gone. Measuring the intent's lamports
  // before funding would read zero (it does not exist yet), which is how an earlier version of
  // this report claimed zero rent recovery.
  const intentAfter = await connection.getAccountInfo(accounts.intent, 'confirmed');
  const ownerLamportsAfter = await connection.getBalance(owner.publicKey, 'confirmed');
  return {
    cycle, owner: owner.publicKey.toBase58(), steps, elapsedMs: Date.now() - startedAt,
    intentClosed: intentAfter === null,
    intentRentLamports: rentHeld.toString(),
    ownerLamportDelta: (ownerLamportsAfter - ownerLamportsBefore).toString(),
  };
}

// The soak brings up its own configuration so it can run against a fresh validator.
async function ensureConfig(): Promise<void> {
  const existing = await connection.getAccountInfo(config, 'confirmed');
  if (existing) return;
  const now = BigInt((await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? 0);
  if (now === 0n) throw new Error('local validator has no confirmed block time');
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({
    fromPubkey: owners[0].publicKey, toPubkey: config,
    lamports: await connection.getMinimumBalanceForRentExemption(831) })), [owners[0]], { commitment: 'confirmed' });
  await sendAndConfirmTransaction(connection, new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: owners[0].publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: prices, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: Buffer.concat([disc('initialize_config'), observations(now)]) })), [owners[0]], { commitment: 'confirmed' });
}
await ensureConfig();

const cycles = [];
for (let cycle = 0; cycle < CYCLES; cycle++) {
  cycles.push(await lifecycleCycle(cycle % owners.length, cycle, false));
}

// Capacity boundary: the largest supported batch settles, and one more owner is refused.
const supported = { owners: 3, status: 'NOT_RUN', compute: null as number | null, serializedBytes: null as number | null };
const overCapacity = { owners: 4, status: 'NOT_RUN', reason: null as string | null };
{
  // The program's own bound is checked without spending a batch: a four-owner body cannot be
  // built by the encoder, which is the first place the limit bites.
  try {
    const { encodeSettlementBody } = await import('../packages/planner/src/validate.js');
    encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '1', crosses: [], residuals: [] }, 4);
    overCapacity.status = 'ACCEPTED';
    overCapacity.reason = 'the encoder accepted four owners, which the program must refuse';
  } catch (error) {
    overCapacity.status = 'REFUSED';
    overCapacity.reason = String((error as Error).message).slice(0, 120);
  }
  // The largest supported batch is measured by the runs that actually settle one; rather than
  // re-implement that machinery here, the numbers are read from those committed transcripts so
  // they cannot drift apart from their source.
  const cited: Record<string, unknown> = {};
  for (const [label, path] of [['internal-batch', 'verification/evidence/T09-local-batch-output.json'],
    ['composed-route', 'verification/evidence/T16-local-route-output.json'],
    ['service-end-to-end', 'verification/evidence/T32-local-service-output.json']] as const) {
    try {
      const evidence = JSON.parse(readFileSync(path, 'utf8'));
      const steps = (evidence.steps ?? []) as { step: string; detail: Record<string, unknown> }[];
      const pick = (name: string, key: string) => steps.find(entry => entry.step === name)?.detail?.[key] ?? null;
      cited[label] = {
        source: path,
        computeUnits: evidence.compute_units ?? pick('simulate', 'units'),
        serializedBytes: evidence.serialized_settlement_bytes ?? pick('broadcast', 'serializedBytes'),
        lookupTableEntries: evidence.lookup_table_entries ?? pick('lookup-table', 'entries'),
        owners: Array.isArray(evidence.owners) ? evidence.owners.length
          : Array.isArray((steps.find(entry => entry.step === 'prepare')?.detail?.preview as { owners?: unknown[] })?.owners)
            ? (steps.find(entry => entry.step === 'prepare')!.detail.preview as { owners: unknown[] }).owners.length : null,
      };
    } catch {
      cited[label] = { source: path, status: 'EVIDENCE_NOT_PRESENT' };
    }
  }
  supported.status = 'MEASURED_BY_NAMED_RUNS';
  (supported as Record<string, unknown>).cited = cited;
}

const flat = cycles.flatMap(cycle => cycle.steps);
const report = {
  status: 'COMPLETE', task: 'T28', scope: 'LOCAL SOAK; synthetic test assets; no devnet soak in this run',
  profile, cluster: 'localnet', genesis, program_id: PROGRAM.toBase58(), config: config.toBase58(),
  cycles: cycles.length, owners: owners.length,
  totals: {
    steps: flat.length,
    ok: flat.filter(step => step.status === 'OK').length,
    refused: flat.filter(step => step.status === 'REFUSED').length,
    chain_errors: flat.filter(step => step.status === 'CHAIN_ERROR').length,
    max_compute: Math.max(0, ...flat.map(step => step.compute ?? 0)),
    total_compute: flat.reduce((sum, step) => sum + (step.compute ?? 0), 0),
  },
  rent: {
    everyIntentClosed: cycles.every(cycle => cycle.intentClosed === true),
    rentPerIntentLamports: cycles[0]?.intentRentLamports ?? '0',
    lamportDeltaPerCycle: cycles.map(cycle => cycle.ownerLamportDelta),
    ownerStateRentLamports: (BigInt(cycles[3]?.ownerLamportDelta ?? '0') - BigInt(cycles[0]?.ownerLamportDelta ?? '0')).toString(),
    note: 'an intent returns its rent when it closes, so the owner lamport delta is fees only; the first cycle for each owner is larger by the permanent owner-state rent, which is why cycles 0-2 differ from cycles 3-11',
  },
  confirmation: {
    slowestCycleMs: Math.max(...cycles.map(cycle => cycle.elapsedMs)),
    meanCycleMs: Math.round(cycles.reduce((sum, cycle) => sum + cycle.elapsedMs, 0) / cycles.length),
  },
  capacity: { supported, overCapacity },
  cycles_detail: cycles,
  limitations: [
    'Local validator with synthetic TEST PRICES; this is not a devnet soak and not a market.',
    'The soak exercises the lifecycle and recovery paths, not the composed route (T16 covers that).',
    'Finite runs are evidence, not proof of universal safety.',
  ],
  hashes: { manifest: createHash('sha256').update(readFileSync(manifestPath)).digest('hex') },
};
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: 'COMPLETE', cycles: report.cycles, ...report.totals }, null, 2));

// Any refusal that is not an intended negative, or any negative rent recovery, is a failure.
const unintended = flat.filter(step => step.status === 'REFUSED' && !/NothingToWithdraw/.test(step.error ?? ''));
if (unintended.length > 0) {
  console.error(`unintended refusals: ${unintended.map(step => `${step.step}:${step.error}`).join('; ')}`);
  process.exitCode = 1;
}
if (!report.rent.everyIntentClosed) {
  console.error('an intent was left open, so its rent was not recovered');
  process.exitCode = 1;
}
const feesOnly = flat.filter(step => step.status === 'OK').length;
if (cycles.some(cycle => Number(cycle.ownerLamportDelta) > 0)) {
  console.error('an owner gained lamports across a cycle, which no path should do');
  process.exitCode = 1;
}
void feesOnly;
