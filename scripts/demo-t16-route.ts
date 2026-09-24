import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { assertPreparedDeploymentManifest } from './deployment-manifest.js';
import { ControlledVenue, deriveControlledPool } from '../packages/adapters/src/controlled.js';
import { canonicalAta } from '../packages/adapters/src/types.js';
import { buildCreateAndFundInstruction, deriveFundAccounts, fundingTransaction } from '../packages/client/src/fund.js';
import { buildSettleRoutedInstruction, deriveRoutedBatchAccounts, BATCH_COMPUTE_UNIT_LIMIT, batchTransaction } from '../packages/client/src/build-batch.js';
import { encodeSettlementBody } from '../packages/planner/src/validate.js';

const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const VENUE_PROGRAM = new PublicKey('Bq1FxNWHnmnZgJRi6fsRKrvLTbBf6uDTXjaawzdnkw1Q');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const GROUPS = 3;
const PER_GROUP = 8;
const FEE_BPS = 30;
const SEED = { cash: 50_000_000n, stock1: 5_000_000n };
const args = process.argv.slice(2);
if (args.length !== 4) throw new Error('usage: tsx scripts/demo-t16-route.ts <local-rpc> <manifest> <env.json> <out.json>');
const [rpc, manifestPath, envPath, outPath] = args;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('local validator RPC only');
const connection = new Connection(rpc, 'confirmed');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const env = JSON.parse(readFileSync(envPath, 'utf8'));
const genesis = await connection.getGenesisHash();
await assertPreparedDeploymentManifest(manifest, genesis);
if (manifest.cluster !== 'localnet' || manifest.program_id !== PROGRAM.toBase58()) throw new Error('local CrossFlow manifest required');
if (manifest.policy.route_kind !== '1' || manifest.policy.route_program !== VENUE_PROGRAM.toBuffer().toString('hex')) {
  throw new Error('this run requires the route-enabled manifest bound to the controlled venue');
}
const signers: Keypair[] = env.owner_paths.map((path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')))));
const mints: PublicKey[] = manifest.policy.assets.map((asset: { mint: string }) => new PublicKey(Buffer.from(asset.mint, 'hex')));
const feeds: Buffer[] = manifest.policy.assets.map((asset: { feed_id: string }) => Buffer.from(asset.feed_id, 'hex'));
const prices = [1_000_000n, 10_000_000n, 20_000_000n];
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(manifest.deployment_id, 'hex')], PROGRAM);
const [priceFeed] = PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], PROGRAM);
const pool = deriveControlledPool(VENUE_PROGRAM, mints);
const venue = new ControlledVenue({ programId: VENUE_PROGRAM, pool, poolAuthority: signers[0].publicKey, mints, feeBps: FEE_BPS,
  label: 'CONTROLLED SYNTHETIC VENUE; test liquidity only' });
const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const i32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; };
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const readU64 = (data: Buffer, offset: number) => { let value = 0n; for (let i = 0; i < 8; i++) value |= BigInt(data[offset + i]) << BigInt(8 * i); return value; };
const sendIx = async (ix: TransactionInstruction, signersForTransaction: Keypair[], withBudget = false) =>
  sendAndConfirmTransaction(connection, withBudget ? batchTransaction(ix) : new Transaction().add(ix), signersForTransaction, { commitment: 'confirmed' });
const sendTx = async (tx: Transaction, signersForTransaction: Keypair[]) =>
  sendAndConfirmTransaction(connection, tx, signersForTransaction, { commitment: 'confirmed' });
const balance = async (key: PublicKey) => {
  const info = await connection.getAccountInfo(key, 'confirmed');
  if (!info) return 0n;
  if (!info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 165) throw new Error(`unexpected token account ${key.toBase58()}`);
  let amount = 0n; for (let i = 0; i < 8; i++) amount |= BigInt(info.data[64 + i]) << BigInt(8 * i);
  return amount;
};
const negativeResults: { label: string; expected: string; log: string }[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 1. Configuration with labelled TEST PRICES.
let now = BigInt((await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? 0);
if (now === 0n) throw new Error('local validator has no confirmed block time');
const observations = (timestamp: bigint) => Buffer.concat([0, 1, 2].map(i => Buffer.concat([
  mints[i].toBuffer(), feeds[i], u64(prices[i]), u64(0n), i32(-6), Buffer.from([0]), u64(timestamp), u64(timestamp), Buffer.from([0])])));
let configInfo = await connection.getAccountInfo(config, 'confirmed');
if (!configInfo) {
  await sendIx(SystemProgram.transfer({ fromPubkey: signers[0].publicKey, toPubkey: config,
    lamports: await connection.getMinimumBalanceForRentExemption(831) }), [signers[0]]);
  await sendIx(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: signers[0].publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: priceFeed, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: Buffer.concat([disc('initialize_config'), observations(now)]) }), [signers[0]]);
}
const publishPrices = async (): Promise<bigint> => {
  now = BigInt((await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? 0);
  const info = await connection.getAccountInfo(priceFeed, 'confirmed');
  if (!info) throw new Error('fixture snapshot missing');
  const sequence = readU64(info.data, 105) + 1n;
  await sendIx(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: signers[0].publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: priceFeed, isSigner: false, isWritable: true },
  ], data: Buffer.concat([disc('publish_prices'), u64(sequence), observations(now)]) }), [signers[0]]);
  return sequence;
};

// 2. Bring up the pinned venue pool and seed it with synthetic test liquidity.
const createVault = (mint: PublicKey) => new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [
  { pubkey: signers[0].publicKey, isSigner: true, isWritable: true },
  { pubkey: venue.vaults()[mints.indexOf(mint)], isSigner: false, isWritable: true },
  { pubkey: pool, isSigner: false, isWritable: false },
  { pubkey: mint, isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
] });
const transfer = (mintIndex: number, amount: bigint) => new TransactionInstruction({
  programId: TOKEN_PROGRAM,
  data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([6])]),
  keys: [
    { pubkey: canonicalAta(signers[0].publicKey, mints[mintIndex]), isSigner: false, isWritable: true },
    { pubkey: mints[mintIndex], isSigner: false, isWritable: false },
    { pubkey: venue.vaults()[mintIndex], isSigner: false, isWritable: true },
    { pubkey: signers[0].publicKey, isSigner: true, isWritable: false },
  ] });
if (!(await connection.getAccountInfo(pool, 'confirmed'))) await sendIx(venue.buildInitializePool(), [signers[0]]);
for (let a = 0; a < 3; a++) {
  if (!(await connection.getAccountInfo(venue.vaults()[a], 'confirmed'))) await sendIx(createVault(mints[a]), [signers[0]]);
}
if (await balance(venue.vaults()[0]) < SEED.cash) {
  await sendTx(new Transaction().add(transfer(0, SEED.cash), transfer(1, SEED.stock1)), [signers[0]]);
}
const reserveCash = await balance(venue.vaults()[0]);
const reserveStock = await balance(venue.vaults()[1]);
if (reserveCash < SEED.cash || reserveStock < SEED.stock1) throw new Error('venue reserves were not seeded');

// 3. Fund the three slices. A sells 1,000,000 internally and 50,000 against the venue.
const sliceSpecs = [
  { cash: { funding: '0', min: '0', max: '60000000' }, stock1: { funding: '4000000', min: '0', max: '4000000' }, stock2: { funding: '0', min: '0', max: '0' } },
  { cash: { funding: '40000000', min: '0', max: '40000000' }, stock1: { funding: '0', min: '0', max: '2000000' }, stock2: { funding: '0', min: '0', max: '0' } },
  { cash: { funding: '30000000', min: '0', max: '30000000' }, stock1: { funding: '0', min: '0', max: '0' }, stock2: { funding: '0', min: '0', max: '0' } },
];
const funded: { owner: PublicKey; vaults: PublicKey[]; recipients: PublicKey[] }[] = [];
for (let i = 0; i < signers.length; i++) {
  const owner = signers[i].publicKey;
  const spec = sliceSpecs[i];
  const accounts = deriveFundAccounts(PROGRAM, config, priceFeed, owner, 0n, mints);
  const assets = [spec.cash, spec.stock1, spec.stock2].map((asset, index) => ({
    funding: asset.funding, min_output: asset.min, max_output: asset.max,
    funding_reference_price: prices[index].toString(),
  }));
  await sendAndConfirmTransaction(connection, fundingTransaction(buildCreateAndFundInstruction(PROGRAM, owner, accounts, {
    expected_policy_hash: manifest.initial_policy_hash, nonce: '0', expiry_unix_seconds: (now + 600n).toString(),
    optimization_commitment: createHash('sha256').update(`t16-slice-${i}`).digest('hex'), assets,
  })), [signers[i]], { commitment: 'confirmed' });
  funded.push({ owner, vaults: accounts.vaults, recipients: accounts.sources });
}
let sequence = await publishPrices();

// 4. One cross plus one admitted residual leg that must be executed against the venue.
const batch = deriveRoutedBatchAccounts(PROGRAM, config, priceFeed, mints,
  funded.map(entry => ({ owner: entry.owner, nonce: 0n })), { program: VENUE_PROGRAM, pool });
const ordered = batch.members.map(member => funded.find(entry => entry.owner.equals(member.owner))!);
const sellerIndex = batch.members.findIndex(member => member.owner.equals(signers[0].publicKey));
const buyerIndex = batch.members.findIndex(member => member.owner.equals(signers[1].publicKey));
if (sellerIndex < 0 || buyerIndex < 0 || sellerIndex === buyerIndex) throw new Error('batch member ordering failed');

// The transient batch pools are derived from the batch PDA; they are created once by the
// operator before any settlement and must start empty.
for (let a = 0; a < 3; a++) {
  if (await connection.getAccountInfo(batch.pools[a], 'confirmed')) continue;
  await sendIx(new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [
    { pubkey: signers[0].publicKey, isSigner: true, isWritable: true },
    { pubkey: batch.pools[a], isSigner: false, isWritable: true },
    { pubkey: batch.batch_authority, isSigner: false, isWritable: false },
    { pubkey: mints[a], isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
  ] }), [signers[0]]);
}
for (let a = 0; a < 3; a++) {
  if (await balance(batch.pools[a]) !== 0n) throw new Error(`batch pool ${a} must start empty`);
}
const cross = { stock_index: '1', seller_index: String(sellerIndex), buyer_index: String(buyerIndex), stock_quantity: '1000000', cash_amount: '10000000' };
const residualInputs = ordered.map(() => '0');
residualInputs[sellerIndex] = '50000';
const bodyFor = (seq: string, crosses: unknown[], residuals: unknown[]) =>
  encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: seq, crosses: crosses as never, residuals: residuals as never }, GROUPS);
const residual = { stock_index: '1', direction: '0', minimum_output: '400000', input_allocations: residualInputs };
const settleInstruction = buildSettleRoutedInstruction(PROGRAM, batch, bodyFor(sequence.toString(), [cross], [residual]));
const groupsOf = (ix: TransactionInstruction) => Array.from({ length: GROUPS }, (_, i) => ix.keys.slice(ix.keys.length - GROUPS * PER_GROUP + i * PER_GROUP, ix.keys.length - GROUPS * PER_GROUP + (i + 1) * PER_GROUP));
const withGroups = (groups: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[][]) =>
  new TransactionInstruction({ programId: PROGRAM, data: settleInstruction.data,
    keys: [...settleInstruction.keys.slice(0, settleInstruction.keys.length - GROUPS * PER_GROUP), ...groups.flat()] });
const withKeys = (mutate: (keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) => void) => {
  const keys = settleInstruction.keys.map(meta => ({ ...meta }));
  mutate(keys);
  return new TransactionInstruction({ programId: PROGRAM, data: settleInstruction.data, keys });
};

// The routed instruction carries the batch, its pools and the whole pinned venue, so it cannot
// fit the legacy packet; an address lookup table is part of the proposal, not an optimisation.
const lookupAddresses: PublicKey[] = [];
const seenAddresses = new Set<string>();
for (const key of [...settleInstruction.keys.map(meta => meta.pubkey), PROGRAM, MEMO]) {
  if (seenAddresses.has(key.toBase58())) continue;
  seenAddresses.add(key.toBase58());
  lookupAddresses.push(key);
}
if (settleInstruction.keys.some(meta => meta.isSigner)) throw new Error('routed settlement must not require a signer account');
let lookupTableAddress: PublicKey | null = null;
for (let attempt = 0; attempt < 40 && !lookupTableAddress; attempt++) {
  const slot = Math.max(0, (await connection.getSlot('finalized')) - 1 - attempt);
  const [candidateIx, candidateAddress] = AddressLookupTableProgram.createLookupTable({
    authority: signers[0].publicKey, payer: signers[0].publicKey, recentSlot: slot,
  });
  const probe = new Transaction().add(candidateIx)
    .add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(randomBytes(6).toString('hex')) }));
  probe.feePayer = signers[0].publicKey;
  probe.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  probe.sign(signers[0]);
  if ((await connection.simulateTransaction(probe)).value.err) { await sleep(400); continue; }
  await sendIx(candidateIx, [signers[0]]);
  lookupTableAddress = candidateAddress;
}
if (!lookupTableAddress) throw new Error('no usable lookup-table slot');
const LOOKUP_CHUNK = 12;
for (let offset = 0; offset < lookupAddresses.length; offset += LOOKUP_CHUNK) {
  await sendIx(AddressLookupTableProgram.extendLookupTable({
    lookupTable: lookupTableAddress, authority: signers[0].publicKey, payer: signers[0].publicKey,
    addresses: lookupAddresses.slice(offset, offset + LOOKUP_CHUNK),
  }), [signers[0]]);
}
let lookupAccount: AddressLookupTableAccount | null = null;
for (let attempt = 0; attempt < 60; attempt++) {
  const fetched = await connection.getAddressLookupTable(lookupTableAddress);
  if (fetched.value && fetched.value.state.addresses.length === lookupAddresses.length &&
      (await connection.getSlot('confirmed')) > fetched.value.state.lastExtendedSlot) { lookupAccount = fetched.value; break; }
  await sleep(400);
}
if (!lookupAccount) throw new Error('address lookup table did not activate');
const compile = async (ix: TransactionInstruction, salt: boolean) => {
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: BATCH_COMPUTE_UNIT_LIMIT }), ix];
  if (salt) instructions.push(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(randomBytes(6).toString('hex')) }));
  return new VersionedTransaction(new TransactionMessage({
    payerKey: signers[0].publicKey, recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash, instructions,
  }).compileToV0Message([lookupAccount!]));
};
const expectReject = async (label: string, ix: TransactionInstruction, expected: RegExp) => {
  const tx = await compile(ix, true);
  tx.sign([signers[0]]);
  const result = await connection.simulateTransaction(tx, { commitment: 'confirmed' });
  const log = (result.value.logs ?? []).join('\n');
  if (!result.value.err || !log.includes(`Program ${PROGRAM.toBase58()} failed:`) || !expected.test(log)) {
    throw new Error(`${label}: expected ${expected}; got err=${JSON.stringify(result.value.err)}\n${log}`);
  }
  negativeResults.push({ label, expected: String(expected), log });
};

await expectReject('unsorted-owner-accounts',
  withGroups([groupsOf(settleInstruction)[1], groupsOf(settleInstruction)[0], groupsOf(settleInstruction)[2]]), /Error Code: BatchAccount/);
await expectReject('wrong-venue-program', withKeys(keys => { keys[9] = { ...keys[9], pubkey: PROGRAM }; }), /Error Code: RouteIdentity/);
await expectReject('cross-price-outside-committed-band',
  buildSettleRoutedInstruction(PROGRAM, batch, bodyFor(sequence.toString(), [{ ...cross, cash_amount: '30000000' }], [residual])), /Error Code: TradePrice/);
// The pinned venue enforces the caller's minimum before CrossFlow re-checks the measured delta.
await expectReject('minimum-output-above-the-measured-quote',
  buildSettleRoutedInstruction(PROGRAM, batch, bodyFor(sequence.toString(), [cross], [{ ...residual, minimum_output: '30000000' }])), /Error Code: (?:RouteOutput|MinOut)/);
await expectReject('wrong-snapshot-sequence',
  buildSettleRoutedInstruction(PROGRAM, batch, bodyFor((sequence + 1n).toString(), [cross], [residual])), /Error Code: (?:SnapshotSequence|Sequence)/);

// 5. The composed batch settles atomically: pool intake, venue leg, credits and payouts.
sequence = await publishPrices();
const settledInstruction = buildSettleRoutedInstruction(PROGRAM, batch, bodyFor(sequence.toString(), [cross], [residual]));
const vaultBefore = await Promise.all(ordered.map(entry => Promise.all(entry.vaults.map(balance))));
const recipientBefore = await Promise.all(ordered.map(entry => Promise.all(entry.recipients.map(balance))));
const settleTransaction = await compile(settledInstruction, true);
settleTransaction.sign([signers[0]]);
const serializedBytes = settleTransaction.serialize().length;
const simulation = await connection.simulateTransaction(settleTransaction, { commitment: 'confirmed' });
if (simulation.value.err) throw new Error(`valid routed batch failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs ?? []).join('\n')}`);
const computeUnits = simulation.value.unitsConsumed ?? 0;
const settleSignature = await connection.sendRawTransaction(settleTransaction.serialize(), { preflightCommitment: 'confirmed' });
await connection.confirmTransaction(settleSignature, 'confirmed');
await expectReject('double-settle-rejected', settledInstruction, /Error Code: Settle/);

// Only the seller's external leg can move the pool reserves, so only cash and stock1 may differ.
const reserveCashAfter = await balance(venue.vaults()[0]);
const reserveStockAfter = await balance(venue.vaults()[1]);
// The seller pays stock1 into the venue and receives cash out of it.
if (reserveStockAfter <= reserveStock || reserveCashAfter >= reserveCash) throw new Error('venue reserves did not move with the routed leg');
const executedExternal = reserveStockAfter - reserveStock;
const receivedCash = reserveCash - reserveCashAfter;
if (receivedCash < 400_000n) throw new Error('measured external output is below the committed minimum');

// The seller's authorized cash output is the internal premium plus the measured venue proceeds.
const expectedOutputs = ordered.map((entry, memberIndex) => {
  const funding = vaultBefore[memberIndex];
  const debit = [0n, 0n, 0n];
  const credit = [0n, 0n, 0n];
  if (memberIndex === sellerIndex) { debit[1] += 1_000_000n; credit[0] += 10_000_000n; debit[1] += 50_000n; credit[0] += receivedCash; }
  if (memberIndex === buyerIndex) { debit[0] += 10_000_000n; credit[1] += 1_000_000n; }
  return funding.map((amount, index) => amount - debit[index] + credit[index]);
});
const measuredOutputs: string[][] = [];
for (let i = 0; i < ordered.length; i++) {
  const info = await connection.getAccountInfo(batch.intents[i], 'confirmed');
  if (!info || info.data[520] !== 1 || [0, 1, 2].some(a => readU64(info.data, 472 + a * 8) !== 0n)) throw new Error(`intent ${i} did not settle with cleared claims`);
  const row: string[] = [];
  for (let a = 0; a < 3; a++) {
    if (await balance(ordered[i].vaults[a]) !== 0n) throw new Error(`intent ${i} vault ${a} retained value`);
    const delta = await balance(ordered[i].recipients[a]) - recipientBefore[i][a];
    row.push(delta.toString());
  }
  measuredOutputs.push(row);
}
for (let a = 0; a < 3; a++) {
  const info = await connection.getAccountInfo(batch.pools[a], 'confirmed');
  if (!info || info.data.readBigUInt64LE(64) !== 0n) throw new Error(`batch pool ${a} did not end empty`);
}
const record = {
  status: 'PASS', task: 'T16', cluster: 'localnet', genesis, program_id: PROGRAM.toBase58(),
  config: config.toBase58(), prices: priceFeed.toBase58(), snapshot_sequence: sequence.toString(),
  deployment_id: manifest.deployment_id, policy_hash: manifest.initial_policy_hash,
  price_label: 'TEST PRICES; synthetic fixture oracle; no equity price claim',
  route: { program: VENUE_PROGRAM.toBase58(), pool: pool.toBase58(), fee_bps: FEE_BPS,
    vaults: venue.vaults().map(vault => vault.toBase58()), vaults_are_pool_atas: venue.vaults().every(
      (vault, index) => vault.equals(PublicKey.findProgramAddressSync([pool.toBuffer(), TOKEN_PROGRAM.toBuffer(), mints[index].toBuffer()], ATA_PROGRAM)[0])) },
  batch_authority: batch.batch_authority.toBase58(),
  pools: batch.pools.map(key => key.toBase58()),
  owners: ordered.map(entry => entry.owner.toBase58()),
  cross, residual: { ...residual }, residual_inputs: residualInputs,
  venue_before: { cash: reserveCash.toString(), stock1: reserveStock.toString() },
  venue_after: { cash: reserveCashAfter.toString(), stock1: reserveStockAfter.toString() },
  measured_external_input: executedExternal.toString(), measured_external_output: receivedCash.toString(),
  vault_before: vaultBefore.map(row => row.map(value => value.toString())),
  recipient_before: recipientBefore.map(row => row.map(value => value.toString())),
  expected_outputs: expectedOutputs.map(row => row.map(value => value.toString())),
  measured_outputs: measuredOutputs,
  pools_ended_empty: true, vaults_ended_at_surplus: true, intents_settled: true,
  compute_units: computeUnits, requested_compute_units: BATCH_COMPUTE_UNIT_LIMIT,
  serialized_settlement_bytes: serializedBytes, lookup_table: lookupTableAddress.toBase58(),
  lookup_table_entries: lookupAddresses.length,
  mandatory_negative_cases: negativeResults.length, negativeResults,
  signatures: { settle: settleSignature },
  hashes: {
    manifest: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    binary: createHash('sha256').update(readFileSync('target/deploy/crossflow.so')).digest('hex'),
    venue_binary: createHash('sha256').update(readFileSync('target/deploy/test_venue.so')).digest('hex'),
    body: createHash('sha256').update(settledInstruction.data).digest('hex'),
    instruction: createHash('sha256').update(Buffer.from(disc('settle_routed'))).digest('hex'),
  },
  limitations: [
    'Isolated local validator with synthetic TEST PRICES and test-token venue liquidity; no devnet, market or equity claim.',
    'The venue is a fixed constant-product test venue pinned by the committed policy; it is not Meteora, Jupiter or a real market.',
    'The routed leg is a single small sell; larger legs would exceed the committed ±200 bps per-owner execution band and must be rejected.',
  ],
};
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
