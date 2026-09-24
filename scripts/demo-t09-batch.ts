import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { assertPreparedDeploymentManifest } from './deployment-manifest.js';
import { buildCreateAndFundInstruction, deriveFundAccounts, fundingTransaction } from '../packages/client/src/fund.js';
import { buildSettleBatchInstruction, deriveBatchAccounts, BATCH_COMPUTE_UNIT_LIMIT } from '../packages/client/src/build-batch.js';
import { encodeSettlementBody } from '../packages/planner/src/validate.js';
import { mandateBytes } from '../packages/contracts/src/index.js';

const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const GROUPS = 3;
const PER_GROUP = 8;
const args = process.argv.slice(2);
if (args.length !== 4) throw new Error('usage: tsx scripts/demo-t09-batch.ts <local-rpc> <manifest> <env.json> <out.json>');
const [rpc, manifestPath, envPath, outPath] = args;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('local validator RPC only');
const connection = new Connection(rpc, 'confirmed');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const env = JSON.parse(readFileSync(envPath, 'utf8'));
const genesis = await connection.getGenesisHash();
await assertPreparedDeploymentManifest(manifest, genesis);
if (manifest.cluster !== 'localnet' || manifest.program_id !== PROGRAM.toBase58()) throw new Error('local CrossFlow manifest required');
if (env.genesis !== genesis || env.wallet !== manifest.expected_initializer || env.owners.length !== 3) throw new Error('local environment does not match the prepared manifest');

const signers: Keypair[] = env.owner_paths.map((path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')))));
if (signers.map(signer => signer.publicKey.toBase58()).join() !== env.owners.join()) throw new Error('owner keypair files do not match the environment record');
const mints: PublicKey[] = manifest.policy.assets.map((asset: { mint: string }) => new PublicKey(Buffer.from(asset.mint, 'hex')));
const feeds: Buffer[] = manifest.policy.assets.map((asset: { feed_id: string }) => Buffer.from(asset.feed_id, 'hex'));
const prices = [1_000_000n, 10_000_000n, 20_000_000n];
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(manifest.deployment_id, 'hex')], PROGRAM);
const [priceFeed] = PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], PROGRAM);
const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const i32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; };
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const readU64 = (data: Buffer, offset: number) => { let value = 0n; for (let i = 0; i < 8; i++) value |= BigInt(data[offset + i]) << BigInt(8 * i); return value; };
const sendInstruction = async (ix: TransactionInstruction, txSigners: Keypair[]) =>
  sendAndConfirmTransaction(connection, new Transaction().add(ix), txSigners, { commitment: 'confirmed' });
const sendTx = async (tx: Transaction, txSigners: Keypair[]) => sendAndConfirmTransaction(connection, tx, txSigners, { commitment: 'confirmed' });
const balance = async (key: PublicKey) => {
  const info = await connection.getAccountInfo(key, 'confirmed');
  if (!info) return 0n;
  if (!info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 165) throw new Error(`unexpected token account ${key.toBase58()}`);
  let amount = 0n; for (let i = 0; i < 8; i++) amount |= BigInt(info.data[64 + i]) << BigInt(8 * i);
  return amount;
};
const negativeResults: { label: string; expected: string; log: string }[] = [];

// 1. Canonical config with labelled TEST PRICES at the validator's own clock.
let now = BigInt((await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? 0);
if (now === 0n) throw new Error('local validator has no confirmed block time');
let sequence = 1n;
const observations = (timestamp: bigint) => Buffer.concat([0, 1, 2].map(i => Buffer.concat([
  mints[i].toBuffer(), feeds[i], u64(prices[i]), u64(0n), i32(-6), Buffer.from([0]), u64(timestamp), u64(timestamp), Buffer.from([0]),
])));
const configRent = await connection.getMinimumBalanceForRentExemption(831);
let prefundSignature: string | null = null;
let configSignature: string | null = null;
let configInfo = await connection.getAccountInfo(config, 'confirmed');
if (!configInfo) {
  prefundSignature = await sendInstruction(SystemProgram.transfer({ fromPubkey: signers[0].publicKey, toPubkey: config, lamports: configRent }), [signers[0]]);
  configInfo = await connection.getAccountInfo(config, 'confirmed');
}
if (!configInfo?.owner.equals(PROGRAM)) {
  configSignature = await sendInstruction(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: signers[0].publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: priceFeed, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: Buffer.concat([disc('initialize_config'), observations(now)]) }), [signers[0]]);
}
const publishPrices = async () => {
  const time = await connection.getBlockTime(await connection.getSlot('confirmed'));
  if (time === null) throw new Error('local validator has no confirmed block time');
  now = BigInt(time);
  const info = await connection.getAccountInfo(priceFeed, 'confirmed');
  if (!info) throw new Error('fixture snapshot missing');
  sequence = readU64(info.data, 105) + 1n;
  await sendInstruction(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: signers[0].publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: priceFeed, isSigner: false, isWritable: true },
  ], data: Buffer.concat([disc('publish_prices'), u64(sequence), observations(now)]) }), [signers[0]]);
};
await publishPrices();

// 2. Each owner funds its own selected slice into its own per-intent vaults.
// The buyer's stock bound is exactly its target, so this owner cannot be settled by a no-op.
const sliceSpecs = [
  { cash: { funding: '10000000', min: '0', max: '60000000' }, stock1: { funding: '4000000', min: '0', max: '4000000' }, stock2: { funding: '0', min: '0', max: '0' } },
  { cash: { funding: '40000000', min: '0', max: '40000000' }, stock1: { funding: '0', min: '2000000', max: '2000000' }, stock2: { funding: '0', min: '0', max: '0' } },
  { cash: { funding: '30000000', min: '0', max: '30000000' }, stock1: { funding: '0', min: '0', max: '0' }, stock2: { funding: '0', min: '0', max: '0' } },
];
const funded: { owner: PublicKey; funding: string[]; vaults: PublicKey[]; recipients: PublicKey[]; mandate_hash: string }[] = [];
const fundingSignatures: string[] = [];
for (let i = 0; i < signers.length; i++) {
  const owner = signers[i].publicKey;
  const spec = sliceSpecs[i];
  const accounts = deriveFundAccounts(PROGRAM, config, priceFeed, owner, 0n, mints);
  const assets = [spec.cash, spec.stock1, spec.stock2].map((asset, a) => ({
    funding: asset.funding, min_output: asset.min, max_output: asset.max, funding_reference_price: prices[a].toString(),
  }));
  const commitment = createHash('sha256').update(`t09-slice-${i}`).digest('hex');
  const expiry = (now + 600n).toString();
  fundingSignatures.push(await sendTx(fundingTransaction(buildCreateAndFundInstruction(PROGRAM, owner, accounts, {
    expected_policy_hash: manifest.initial_policy_hash, nonce: '0', expiry_unix_seconds: expiry,
    optimization_commitment: commitment, assets,
  })), [signers[i]]));
  const mandate = {
    schema_version: '1', genesis: manifest.policy.genesis, program_id: manifest.policy.program_id,
    config_address: manifest.policy.config_address, policy_hash: manifest.initial_policy_hash,
    owner: owner.toBuffer().toString('hex'), nonce: '0', expiry_unix_seconds: expiry, optimization_commitment: commitment,
    assets: assets.map((asset, a) => ({ ...asset, mint: manifest.policy.assets[a].mint,
      token_program: manifest.policy.assets[a].token_program, decimals: String(manifest.policy.assets[a].decimals),
      recipient_ata: accounts.sources[a].toBuffer().toString('hex') })),
  };
  funded.push({ owner, funding: assets.map(asset => asset.funding), vaults: accounts.vaults, recipients: accounts.sources,
    mandate_hash: createHash('sha256').update(mandateBytes(mandate)).digest('hex') });
}

// 3. One explicit internal cross: the first owner sells two test shares to the second at reference.
const batch = deriveBatchAccounts(PROGRAM, config, priceFeed, mints, funded.map(entry => ({ owner: entry.owner, nonce: 0n })));
const ordered = batch.members.map(member => {
  const entry = funded.find(candidate => candidate.owner.equals(member.owner));
  if (!entry) throw new Error('batch member has no funded intent');
  return entry;
});
const sellerIndex = batch.members.findIndex(member => member.owner.equals(signers[0].publicKey));
const buyerIndex = batch.members.findIndex(member => member.owner.equals(signers[1].publicKey));
if (sellerIndex < 0 || buyerIndex < 0 || sellerIndex === buyerIndex) throw new Error('batch member ordering failed');
const cross = { stock_index: '1', seller_index: String(sellerIndex), buyer_index: String(buyerIndex), stock_quantity: '2000000', cash_amount: '20000000' };
const bodyFor = (crosses: unknown[], seq = sequence.toString()) =>
  encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: seq, crosses: crosses as never, residuals: [] }, GROUPS);
const settleInstruction = buildSettleBatchInstruction(PROGRAM, batch, bodyFor([cross]));
const groupsOf = (ix: TransactionInstruction) => Array.from({ length: GROUPS }, (_, i) => ix.keys.slice(ix.keys.length - GROUPS * PER_GROUP + i * PER_GROUP, ix.keys.length - GROUPS * PER_GROUP + (i + 1) * PER_GROUP));
const withGroups = (groups: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[][]) =>
  new TransactionInstruction({ programId: PROGRAM, data: settleInstruction.data,
    keys: [...settleInstruction.keys.slice(0, settleInstruction.keys.length - GROUPS * PER_GROUP), ...groups.flat()] });

// A three-owner batch does not fit the legacy 1232-byte packet, so the proposer uses an
// address lookup table for the instruction accounts, exactly as the capacity plan requires.
// No batch instruction account is a signer, so every one of them can be table-resolved.
const lookupAddresses: PublicKey[] = [];
const seenAddresses = new Set<string>();
for (const key of [...settleInstruction.keys.map(meta => meta.pubkey), PROGRAM, MEMO]) {
  if (seenAddresses.has(key.toBase58())) continue;
  seenAddresses.add(key.toBase58());
  lookupAddresses.push(key);
}
if (settleInstruction.keys.some(meta => meta.isSigner)) throw new Error('batch instruction must not require a signer account');
// The lookup-table program only accepts a slot the slot-hashes sysvar already retains, so probe
// candidate slots with a simulation before submitting the real creation transaction.
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let lookupTableAddress: PublicKey | null = null;
let createTableSignature: string | null = null;
for (let attempt = 0; attempt < 40 && !lookupTableAddress; attempt++) {
  const slot = Math.max(0, (await connection.getSlot('finalized')) - 1 - attempt);
  const [candidateIx, candidateAddress] = AddressLookupTableProgram.createLookupTable({
    authority: signers[0].publicKey, payer: signers[0].publicKey, recentSlot: slot,
  });
  const probe = new Transaction().add(candidateIx)
    .add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(randomBytes(4).toString('hex')) }));
  probe.feePayer = signers[0].publicKey;
  probe.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  probe.sign(signers[0]);
  const result = await connection.simulateTransaction(probe);
  if (result.value.err) { await sleep(400); continue; }
  createTableSignature = await sendInstruction(candidateIx, [signers[0]]);
  lookupTableAddress = candidateAddress;
}
if (!lookupTableAddress) throw new Error('no usable recent slot for an address lookup table');
// Each extension transaction is itself a legacy packet, so append the addresses in chunks.
const extendTableSignatures: string[] = [];
const LOOKUP_CHUNK = 12;
for (let offset = 0; offset < lookupAddresses.length; offset += LOOKUP_CHUNK) {
  extendTableSignatures.push(await sendInstruction(AddressLookupTableProgram.extendLookupTable({
    lookupTable: lookupTableAddress, authority: signers[0].publicKey, payer: signers[0].publicKey,
    addresses: lookupAddresses.slice(offset, offset + LOOKUP_CHUNK),
  }), [signers[0]]));
}
let lookupAccount: AddressLookupTableAccount | null = null;
for (let attempt = 0; attempt < 60; attempt++) {
  const fetched = await connection.getAddressLookupTable(lookupTableAddress);
  if (fetched.value && fetched.value.state.addresses.length === lookupAddresses.length &&
      (await connection.getSlot('confirmed')) > fetched.value.state.lastExtendedSlot) { lookupAccount = fetched.value; break; }
  await new Promise(resolve => setTimeout(resolve, 400));
}
if (!lookupAccount) throw new Error('address lookup table did not activate');

const compile = async (ix: TransactionInstruction, salt: boolean) => {
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: BATCH_COMPUTE_UNIT_LIMIT }), ix];
  if (salt) instructions.push(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(randomBytes(6).toString('hex')) }));
  const message = new TransactionMessage({
    payerKey: signers[0].publicKey, recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash, instructions,
  }).compileToV0Message([lookupAccount!]);
  return new VersionedTransaction(message);
};
const expectReject = async (label: string, ix: TransactionInstruction, expected: RegExp) => {
  const tx = await compile(ix, true);
  tx.sign([signers[0]]);
  const result = await connection.simulateTransaction(tx);
  const log = (result.value.logs ?? []).join('\n');
  if (!result.value.err || !log.includes(`Program ${PROGRAM.toBase58()} invoke [1]`) ||
      !log.includes(`Program ${PROGRAM.toBase58()} failed:`) || !expected.test(log)) {
    throw new Error(`${label}: expected ${expected}; got err=${JSON.stringify(result.value.err)}\n${log}`);
  }
  negativeResults.push({ label, expected: String(expected), log });
};

// Measure the same instruction without lookup tables: the legacy packet is what the ALT replaces.
const legacyProbe = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: BATCH_COMPUTE_UNIT_LIMIT }), settleInstruction);
legacyProbe.feePayer = signers[0].publicKey;
legacyProbe.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
const legacyEncodedBytes = legacyProbe.compileMessage().serialize().length + 65;

const vaultBefore = await Promise.all(ordered.map(entry => Promise.all(entry.vaults.map(balance))));
const recipientBefore = await Promise.all(ordered.map(entry => Promise.all(entry.recipients.map(balance))));

await expectReject('unsorted-owner-accounts',
  withGroups([groupsOf(settleInstruction)[1], groupsOf(settleInstruction)[0], groupsOf(settleInstruction)[2]]), /Error Code: BatchAccount/);
await expectReject('duplicate-intent-group',
  withGroups([groupsOf(settleInstruction)[0], groupsOf(settleInstruction)[0], groupsOf(settleInstruction)[2]]), /Error Code: (?:BatchAccount|Alias)/);
await expectReject('output-above-owner-maximum',
  buildSettleBatchInstruction(PROGRAM, batch, bodyFor([{ ...cross, stock_quantity: '3000000', cash_amount: '30000000' }])), /Error Code: Output/);
await expectReject('cross-price-outside-committed-band',
  buildSettleBatchInstruction(PROGRAM, batch, bodyFor([{ ...cross, cash_amount: '30000000' }])), /Error Code: TradePrice/);
await expectReject('output-below-owner-minimum',
  buildSettleBatchInstruction(PROGRAM, batch, bodyFor([{ ...cross, stock_quantity: '1000000', cash_amount: '10000000' }])), /Error Code: Output/);
await expectReject('debit-exceeds-original-funding',
  buildSettleBatchInstruction(PROGRAM, batch, bodyFor([{ ...cross, stock_quantity: '5000000', cash_amount: '50000000' }])), /Error Code: BatchRecord/);
// Ascending tuples, so the strict-order rule passes and the no-round-trip rule is the guard that fires.
await expectReject('round-trip-buy-and-sell-same-stock', buildSettleBatchInstruction(PROGRAM, batch, bodyFor([
  { stock_index: '1', seller_index: String(sellerIndex), buyer_index: String(buyerIndex), stock_quantity: '2000000', cash_amount: '20000000' },
  { stock_index: '1', seller_index: String(buyerIndex), buyer_index: String(sellerIndex), stock_quantity: '1000000', cash_amount: '10000000' }])), /Error Code: BatchRecord/);
{
  const groups = groupsOf(settleInstruction).map((group, index) => {
    if (index !== 1) return group;
    const swapped = [...group];
    swapped[2] = group[5];
    swapped[5] = group[2];
    return swapped;
  });
  await expectReject('substituted-vault-and-recipient', withGroups(groups), /Error Code: TokenIdentity/);
}
{
  const keys = settleInstruction.keys.map(meta => ({ ...meta }));
  keys[3] = { ...keys[3], pubkey: mints[2] };
  await expectReject('wrong-mint-rejected', new TransactionInstruction({ programId: PROGRAM, data: settleInstruction.data, keys }), /Error Code: Mint/);
}
{
  const padded = Buffer.concat([settleInstruction.data, Buffer.from([0, 0, 0])]);
  await expectReject('trailing-instruction-bytes-rejected', new TransactionInstruction({ programId: PROGRAM, data: padded, keys: settleInstruction.keys }), /Error Code: Instruction/);
}
await expectReject('wrong-snapshot-sequence',
  buildSettleBatchInstruction(PROGRAM, batch, bodyFor([cross], (sequence + 1n).toString())), /Error Code: (?:SnapshotSequence|Sequence)/);
{
  const residualBody = Buffer.concat([Buffer.from([1, GROUPS]), u64(sequence), Buffer.from([0, 1]), Buffer.from([1, 0]), u64(1000n), u64(1000n), u64(0n), u64(0n)]);
  await expectReject('residual-record-rejected', new TransactionInstruction({ programId: PROGRAM,
    data: Buffer.concat([disc('settle_batch'), u32(residualBody.length), residualBody]), keys: settleInstruction.keys }), /Error Code: Instruction/);
}
const pause = (funding: boolean, settlement: boolean) => new TransactionInstruction({ programId: PROGRAM, keys: [
  { pubkey: signers[0].publicKey, isSigner: true, isWritable: false },
  { pubkey: config, isSigner: false, isWritable: true },
], data: Buffer.concat([disc('set_pause'), Buffer.from([funding ? 1 : 0, settlement ? 1 : 0])]) });
await sendInstruction(pause(true, true), [signers[0]]);
await expectReject('settlement-paused', settleInstruction, /Error Code: Paused/);
await sendInstruction(pause(false, false), [signers[0]]);

// 4. The reviewed bounded batch settles atomically for every participant.
const settleTransaction = await compile(settleInstruction, false);
settleTransaction.sign([signers[0]]);
const serializedSize = settleTransaction.serialize().length;
const simulation = await connection.simulateTransaction(settleTransaction, { commitment: 'confirmed' });
if (simulation.value.err) throw new Error(`valid batch simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs ?? []).join('\n')}`);
const computeUnits = simulation.value.unitsConsumed ?? 0;
if (computeUnits <= 0 || computeUnits > BATCH_COMPUTE_UNIT_LIMIT) throw new Error('batch compute envelope outside the declared budget');
const settleSignature = await connection.sendRawTransaction(settleTransaction.serialize(), { preflightCommitment: 'confirmed' });
await connection.confirmTransaction(settleSignature, 'confirmed');

const expectedOutputs = ordered.map((entry, memberIndex) => {
  const debit = [0n, 0n, 0n];
  const credit = [0n, 0n, 0n];
  if (memberIndex === sellerIndex) { debit[1] = 2_000_000n; credit[0] = 20_000_000n; }
  if (memberIndex === buyerIndex) { debit[0] = 20_000_000n; credit[1] = 2_000_000n; }
  return entry.funding.map((amount, a) => BigInt(amount) - debit[a] + credit[a]);
});
const status: number[] = [];
for (let i = 0; i < ordered.length; i++) {
  const intent = batch.intents[i];
  const info = await connection.getAccountInfo(intent, 'confirmed');
  if (!info || info.data[520] !== 1 || [0, 1, 2].some(a => readU64(info.data, 472 + a * 8) !== 0n)) throw new Error(`intent ${i} did not reach settled state with cleared claims`);
  status.push(info.data[520]);
  for (let a = 0; a < 3; a++) {
    if (await balance(ordered[i].vaults[a]) !== 0n) throw new Error(`intent ${i} vault ${a} retained value`);
    if (await balance(ordered[i].recipients[a]) !== recipientBefore[i][a] + expectedOutputs[i][a]) throw new Error(`intent ${i} recipient ${a} delta mismatch`);
  }
}
await expectReject('double-settle-rejected', settleInstruction, /Error Code: Settle/);

const record = {
  status: 'PASS', task: 'T09', cluster: 'localnet', genesis, program_id: PROGRAM.toBase58(),
  config: config.toBase58(), prices: priceFeed.toBase58(), snapshot_sequence: sequence.toString(),
  price_label: 'TEST PRICES; synthetic fixture oracle; no equity price claim',
  batch_count: GROUPS, owners: ordered.map(entry => entry.owner.toBase58()),
  mandate_hashes: ordered.map(entry => entry.mandate_hash),
  crosses: [cross], estimated_outputs: expectedOutputs.map(row => row.map(value => value.toString())),
  vault_before: vaultBefore.map(row => row.map(value => value.toString())),
  recipient_before: recipientBefore.map(row => row.map(value => value.toString())),
  final_status: status, compute_units: computeUnits, requested_compute_units: BATCH_COMPUTE_UNIT_LIMIT,
  serialized_settlement_bytes: serializedSize, legacy_packet_limit: 1232,
  legacy_encoded_bytes: legacyEncodedBytes, lookup_table: lookupTableAddress.toBase58(),
  lookup_table_entries: lookupAddresses.length,
  mandatory_negative_cases: negativeResults.length, negativeResults,
  signature_count: [prefundSignature, configSignature, ...fundingSignatures, createTableSignature, ...extendTableSignatures, settleSignature].filter(Boolean).length,
  signatures: { prefund: prefundSignature, initialize: configSignature, funding: fundingSignatures,
    createLookupTable: createTableSignature, extendLookupTable: extendTableSignatures, settle: settleSignature },
  hashes: {
    manifest: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    binary: createHash('sha256').update(readFileSync('target/deploy/crossflow.so')).digest('hex'),
    body: createHash('sha256').update(Buffer.from(settleInstruction.data)).digest('hex'),
    batch: createHash('sha256').update(JSON.stringify(batch.members.map(member => member.owner.toBase58()))).digest('hex'),
    env: createHash('sha256').update(readFileSync(envPath)).digest('hex'),
  },
  limitations: [
    'Isolated local validator with synthetic TEST PRICES and three funded slices; no devnet or live equity claim.',
    'T09 settles internal crossings only; external residual routing (T10/T16) is not exercised here.',
    `Three-owner settlement requires an address lookup table: the identical instruction encodes to ${legacyEncodedBytes} legacy bytes, above the 1232-byte packet limit.`,
    'Captured signatures are historical local evidence and require the running ledger for later RPC re-query.',
  ],
};
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
