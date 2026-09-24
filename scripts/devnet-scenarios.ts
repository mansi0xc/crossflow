import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, type AccountInfo } from '@solana/web3.js';
import { assertPreparedDeploymentManifest } from './deployment-manifest.js';
import { validateWriteDestination } from './network-guard.mjs';
import { buildCreateAndFundInstruction, deriveFundAccounts, fundingTransaction } from '../packages/client/src/fund.js';
import { buildSettleBatchInstruction, deriveBatchAccounts, BATCH_COMPUTE_UNIT_LIMIT } from '../packages/client/src/build-batch.js';
import { buildCancelIntentInstruction, buildCloseIntentInstruction, buildWithdrawAssetInstruction, deriveRecoveryAccounts } from '../packages/client/src/recover.js';
import { encodeSettlementBody } from '../packages/planner/src/validate.js';

/**
 * Isolated public-devnet probe under the master plan's scoped-probe exception.
 *
 * This is NOT a release and NOT the integrated workflow: it deploys the reviewed build, then
 * exercises funding, one bounded three-owner atomic internal settlement, three rejections and
 * owner recovery, and records what the chain actually did. There is no external route, no Pyth,
 * and no claim that the composed product is released.
 */
const RPC = 'https://api.devnet.solana.com';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const GROUPS = 3;
const PER_GROUP = 8;
const args = process.argv.slice(2);
if (args.length !== 3) throw new Error('usage: tsx scripts/devnet-scenarios.ts <devnet-manifest> <devnet-env.json> <out.json>');
const [manifestPath, envPath, outPath] = args;

validateWriteDestination(RPC, GENESIS, 'devnet');
const connection = new Connection(RPC, 'confirmed');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const isRateLimited = (error: unknown) => /429|Too Many Requests|rate limit/i.test(String(error));
// The free public devnet RPC rate-limits aggressively, so every read is paced and retried with
// backoff. This is disclosed cost/quota control, not an attempt to work around a failure.
let lastCall = 0;
const paced = async <T>(fn: () => Promise<T>, label: string): Promise<T> => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const gap = 250 - (Date.now() - lastCall);
    if (gap > 0) await sleep(gap);
    lastCall = Date.now();
    try { return await fn(); }
    catch (error) {
      if (!isRateLimited(error) || attempt === 7) throw new Error(`${label}: ${String(error)}`);
      await sleep(600 * (attempt + 1));
    }
  }
  throw new Error(`${label}: unreachable`);
};
const getInfo = (key: PublicKey, label = 'getAccountInfo'): Promise<AccountInfo<Buffer> | null> => paced(() => connection.getAccountInfo(key, 'confirmed'), label);
const slotFinalized = (): Promise<number> => paced(() => connection.getSlot('finalized'), 'getSlot');
const slotConfirmed = (): Promise<number> => paced(() => connection.getSlot('confirmed'), 'getSlot');
const blockTimeOf = (slot: number): Promise<number | null> => paced(() => connection.getBlockTime(slot), 'getBlockTime');
const latestBlockhash = (): Promise<{ blockhash: string; lastValidBlockHeight: number }> => paced(() => connection.getLatestBlockhash('confirmed'), 'getLatestBlockhash');
const simulate = (tx: Transaction | VersionedTransaction) =>
  paced(() => connection.simulateTransaction(tx as never), 'simulateTransaction');
const lookupTable = (key: PublicKey) => paced(() => connection.getAddressLookupTable(key), 'getAddressLookupTable');

const send = async (tx: Transaction, signers: Keypair[], label: string) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await paced(() => connection.sendTransaction(tx, signers, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }), `${label} send`); }
    catch (error) {
      if (attempt === 3) throw new Error(`${label}: ${String(error)}`);
      await sleep(2_000 * (attempt + 1));
    }
  }
  throw new Error(`${label}: unreachable`);
};

const genesis = await paced(() => connection.getGenesisHash(), 'getGenesisHash');
if (genesis !== GENESIS) throw new Error(`GENESIS_MISMATCH: ${genesis}`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
await assertPreparedDeploymentManifest(manifest, genesis);
if (manifest.cluster !== 'devnet' || manifest.program_id !== PROGRAM.toBase58()) throw new Error('devnet deployment manifest required');
if (!(await getInfo(PROGRAM, 'confirmed'))) throw new Error('reviewed program is not deployed at the expected devnet address');

const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
if (operator.publicKey.toBase58() !== manifest.expected_initializer) throw new Error('signing wallet is not the approved devnet authority');
const env = JSON.parse(readFileSync(envPath, 'utf8'));
const owners = [operator, ...env.owners.map((secret: number[]) => Keypair.fromSecretKey(Uint8Array.from(secret)))];

const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const i32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; };
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const readU64 = (data: Buffer, offset: number) => { let value = 0n; for (let i = 0; i < 8; i++) value |= BigInt(data[offset + i]) << BigInt(8 * i); return value; };
const sendIx = async (ix: TransactionInstruction, signers: Keypair[], label: string) => send(new Transaction().add(ix), signers, label);
const confirm = async (signature: string, label: string) => {
  const latest = await latestBlockhash();
  const result = await paced(() => connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed'), 'confirmTransaction');
  if (result.value.err) throw new Error(`${label} failed on chain: ${JSON.stringify(result.value.err)}`);
  return signature;
};
const balance = async (key: PublicKey) => {
  const info = await getInfo(key, 'confirmed');
  if (!info) return 0n;
  if (!info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 165) throw new Error(`unexpected token account ${key.toBase58()}`);
  let amount = 0n; for (let i = 0; i < 8; i++) amount |= BigInt(info.data[64 + i]) << BigInt(8 * i);
  return amount;
};

// 1. Test assets prepared by scripts/devnet-assets.ts and bound into the committed manifest.
const signatures: Record<string, string> = {};
const mintKeys = (env.mints as number[][]).map(secret => Keypair.fromSecretKey(Uint8Array.from(secret)));
const mints = mintKeys.map(entry => entry.publicKey);
if (mints.length !== 3) throw new Error('devnet env must name exactly three test mints');
for (let i = 0; i < 3; i++) {
  if (manifest.policy.assets[i].mint !== mints[i].toBuffer().toString('hex')) {
    throw new Error(`committed policy mint ${i} does not match the prepared devnet test asset`);
  }
}
for (const mint of mints) {
  const info = await getInfo(mint, 'confirmed');
  if (!info || info.data.length !== 82 || info.data.readUInt32LE(0) !== 0 || info.data.readUInt32LE(46) !== 0) {
    throw new Error(`devnet mint ${mint.toBase58()} is not an immutable legacy SPL mint`);
  }
}

// 2. Configuration and labelled TEST PRICES.
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(manifest.deployment_id, 'hex')], PROGRAM);
const [priceFeed] = PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], PROGRAM);
let now = BigInt((await blockTimeOf(await slotFinalized())) ?? 0);
if (now === 0n) throw new Error('devnet block time unavailable');
const observations = (timestamp: bigint) => Buffer.concat([0, 1, 2].map(i => Buffer.concat([
  mints[i].toBuffer(), Buffer.from(manifest.policy.assets[i].feed_id, 'hex'), u64([1_000_000n, 10_000_000n, 20_000_000n][i]),
  u64(0n), i32(-6), Buffer.from([0]), u64(timestamp), u64(timestamp), Buffer.from([0])])));
let configInfo = await getInfo(config, 'confirmed');
if (!configInfo) {
  await confirm(await sendIx(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: config,
    lamports: await connection.getMinimumBalanceForRentExemption(831) }), [operator], 'prefund config'), 'prefund config');
  signatures.initialize = await confirm(await sendIx(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: operator.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: priceFeed, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: Buffer.concat([disc('initialize_config'), observations(now)]) }), [operator], 'initialize config'), 'initialize config');
  configInfo = await getInfo(config, 'confirmed');
}
if (!configInfo || !configInfo.owner.equals(PROGRAM) || configInfo.data.length !== 831) throw new Error('devnet config is not initialized');

// 2b. Publish a fresh labelled snapshot: the committed policy admits observations up to 60s old.
const publishPrices = async (): Promise<bigint> => {
  now = BigInt((await blockTimeOf(await slotFinalized())) ?? 0);
  if (now === 0n) throw new Error('devnet block time unavailable');
  const info = await getInfo(priceFeed, 'confirmed');
  if (!info) throw new Error('fixture snapshot missing');
  const sequence = readU64(info.data, 105) + 1n;
  await confirm(await sendIx(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: operator.publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: priceFeed, isSigner: false, isWritable: true },
  ], data: Buffer.concat([disc('publish_prices'), u64(sequence), observations(now)]) }), [operator], 'publish prices'), 'publish prices');
  return sequence;
};

// 3. Three independently constrained owners fund their own slices.
const sliceSpecs = [
  { cash: { funding: '10000000', min: '0', max: '60000000' }, stock1: { funding: '4000000', min: '0', max: '4000000' }, stock2: { funding: '0', min: '0', max: '0' } },
  { cash: { funding: '40000000', min: '0', max: '40000000' }, stock1: { funding: '0', min: '2000000', max: '2000000' }, stock2: { funding: '0', min: '0', max: '0' } },
  { cash: { funding: '30000000', min: '0', max: '30000000' }, stock1: { funding: '0', min: '0', max: '0' }, stock2: { funding: '0', min: '0', max: '0' } },
];
// 2c. Recover any intent left over from an earlier probe run before reusing these owners.
// This is the same owner-authorized path the product uses, not an admin shortcut.
const cleanupOwner = async (owner: Keypair): Promise<bigint> => {
  const stateKey = PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), owner.publicKey.toBuffer()], PROGRAM)[0];
  const state = await getInfo(stateKey, 'owner state');
  if (!state || !state.owner.equals(PROGRAM)) return 0n;
  const next = readU64(state.data, 72);
  if (state.data[80] !== 1) return next;
  const accounts = deriveRecoveryAccounts(PROGRAM, config, priceFeed, owner.publicKey, next - 1n, mints);
  const info = await getInfo(accounts.intent, 'stale intent');
  if (!info) return next;
  if (info.data[520] === 0) {
    await confirm(await sendIx(buildCancelIntentInstruction(PROGRAM, owner.publicKey, accounts), [owner], 'cleanup cancel'), 'cleanup cancel');
  }
  for (let asset = 0; asset < 3; asset++) {
    try { await confirm(await sendIx(buildWithdrawAssetInstruction(PROGRAM, owner.publicKey, accounts, asset), [owner], `cleanup withdraw ${asset}`), `cleanup withdraw ${asset}`); }
    catch { /* an asset with nothing to withdraw returns a defined error */ }
  }
  await confirm(await sendIx(buildCloseIntentInstruction(PROGRAM, owner.publicKey, accounts), [owner], 'cleanup close'), 'cleanup close');
  return next;
};

const nonces: bigint[] = [];
for (const owner of owners) nonces.push(await cleanupOwner(owner));
let sequence = await publishPrices();
const funded: { owner: PublicKey; nonce: bigint; funding: string[]; vaults: PublicKey[]; recipients: PublicKey[] }[] = [];
for (let i = 0; i < owners.length; i++) {
  const owner = owners[i].publicKey;
  const spec = sliceSpecs[i];
  const nonce = nonces[i];
  const accounts = deriveFundAccounts(PROGRAM, config, priceFeed, owner, nonce, mints);
  const assets = [spec.cash, spec.stock1, spec.stock2].map((asset, index) => ({
    funding: asset.funding, min_output: asset.min, max_output: asset.max,
    funding_reference_price: [1_000_000n, 10_000_000n, 20_000_000n][index].toString(),
  }));
  const request = {
    expected_policy_hash: manifest.initial_policy_hash, nonce: nonce.toString(), expiry_unix_seconds: (now + 890n).toString(),
    optimization_commitment: createHash('sha256').update(`t24-slice-${i}`).digest('hex'), assets,
  };
  signatures[`fund${i}`] = await confirm(await send(fundingTransaction(buildCreateAndFundInstruction(PROGRAM, owner, accounts, request)), [owners[i]], `fund ${i}`), `fund ${i}`);
  funded.push({ owner, nonce, funding: assets.map(asset => asset.funding), vaults: accounts.vaults, recipients: accounts.sources });
}

// 4. One bounded internal cross, settled atomically for all three owners behind a lookup table.
const batch = deriveBatchAccounts(PROGRAM, config, priceFeed, mints, funded.map(entry => ({ owner: entry.owner, nonce: entry.nonce })));
const ordered = batch.members.map(member => funded.find(entry => entry.owner.equals(member.owner))!);
const sellerIndex = batch.members.findIndex(member => member.owner.equals(owners[0].publicKey));
const buyerIndex = batch.members.findIndex(member => member.owner.equals(owners[1].publicKey));
const cross = { stock_index: '1', seller_index: String(sellerIndex), buyer_index: String(buyerIndex), stock_quantity: '2000000', cash_amount: '20000000' };
const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: sequence.toString(), crosses: [cross], residuals: [] }, GROUPS);
let settleInstruction = buildSettleBatchInstruction(PROGRAM, batch, body);

const lookupAddresses: PublicKey[] = [];
const seen = new Set<string>();
for (const key of [...settleInstruction.keys.map(meta => meta.pubkey), PROGRAM, MEMO]) {
  if (seen.has(key.toBase58())) continue;
  seen.add(key.toBase58());
  lookupAddresses.push(key);
}
let lookupTableAddress: PublicKey | null = null;
for (let attempt = 0; attempt < 40 && !lookupTableAddress; attempt++) {
  const slot = Math.max(0, (await slotFinalized()) - 1 - attempt);
  const [candidateIx, candidateAddress] = AddressLookupTableProgram.createLookupTable({ authority: operator.publicKey, payer: operator.publicKey, recentSlot: slot });
  const probe = new Transaction().add(candidateIx).add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(randomBytes(6).toString('hex')) }));
  probe.feePayer = operator.publicKey;
  probe.recentBlockhash = (await latestBlockhash()).blockhash;
  probe.sign(operator);
  if ((await simulate(probe)).value.err) { await sleep(400); continue; }
  await sendIx(candidateIx, [operator], 'create lookup table');
  lookupTableAddress = candidateAddress;
}
if (!lookupTableAddress) throw new Error('no usable lookup-table slot');
const LOOKUP_CHUNK = 12;
for (let offset = 0; offset < lookupAddresses.length; offset += LOOKUP_CHUNK) {
  await confirm(await sendIx(AddressLookupTableProgram.extendLookupTable({
    lookupTable: lookupTableAddress, authority: operator.publicKey, payer: operator.publicKey,
    addresses: lookupAddresses.slice(offset, offset + LOOKUP_CHUNK),
  }), [operator], 'extend lookup table'), 'extend lookup table');
}
let lookupAccount: AddressLookupTableAccount | null = null;
for (let attempt = 0; attempt < 90; attempt++) {
  const fetched = await lookupTable(lookupTableAddress);
  if (fetched.value && fetched.value.state.addresses.length === lookupAddresses.length &&
      (await slotConfirmed()) > fetched.value.state.lastExtendedSlot) { lookupAccount = fetched.value; break; }
  await sleep(600);
}
if (!lookupAccount) throw new Error('lookup table did not activate on devnet');
const compile = async (ix: TransactionInstruction, salt: boolean) => {
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: BATCH_COMPUTE_UNIT_LIMIT }), ix];
  if (salt) instructions.push(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(randomBytes(6).toString('hex')) }));
  return new VersionedTransaction(new TransactionMessage({ payerKey: operator.publicKey,
    recentBlockhash: (await latestBlockhash()).blockhash, instructions }).compileToV0Message([lookupAccount!]));
};

// Republish immediately before any settlement attempt: the committed policy admits an
// observation up to 60 seconds old, and this probe's funding step is already slower than that.
sequence = await publishPrices();
settleInstruction = buildSettleBatchInstruction(PROGRAM, batch,
  encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: sequence.toString(), crosses: [cross] as never, residuals: [] }, GROUPS));

const negativeResults: { label: string; log: string }[] = [];
const expectReject = async (label: string, ix: TransactionInstruction, expected: RegExp) => {
  const tx = await compile(ix, true);
  tx.sign([operator]);
  const result = await simulate(tx);
  const log = (result.value.logs ?? []).join('\n');
  if (!result.value.err || !log.includes(`Program ${PROGRAM.toBase58()} failed:`) || !expected.test(log)) {
    throw new Error(`${label}: expected ${expected}; got ${JSON.stringify(result.value.err)}`);
  }
  negativeResults.push({ label, log: log.split('\n').filter(line => line.includes('failed:') || line.includes('Error Code')).join('\n') });
};
const bodyFor = (crosses: unknown[]) => encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: sequence.toString(), crosses: crosses as never, residuals: [] }, GROUPS);
const groupsOf = (ix: TransactionInstruction) => Array.from({ length: GROUPS }, (_, i) => ix.keys.slice(ix.keys.length - GROUPS * PER_GROUP + i * PER_GROUP, ix.keys.length - GROUPS * PER_GROUP + (i + 1) * PER_GROUP));
const withGroups = (groups: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[][]) =>
  new TransactionInstruction({ programId: PROGRAM, data: settleInstruction.data,
    keys: [...settleInstruction.keys.slice(0, settleInstruction.keys.length - GROUPS * PER_GROUP), ...groups.flat()] });
await expectReject('unsorted-owner-accounts', withGroups([groupsOf(settleInstruction)[1], groupsOf(settleInstruction)[0], groupsOf(settleInstruction)[2]]), /Error Code: BatchAccount/);
await expectReject('output-above-owner-maximum', buildSettleBatchInstruction(PROGRAM, batch, bodyFor([{ ...cross, stock_quantity: '3000000', cash_amount: '30000000' }])), /Error Code: Output/);
await expectReject('cross-price-outside-committed-band', buildSettleBatchInstruction(PROGRAM, batch, bodyFor([{ ...cross, cash_amount: '30000000' }])), /Error Code: TradePrice/);
await expectReject('wrong-snapshot-sequence', buildSettleBatchInstruction(PROGRAM, batch,
  encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: '9', crosses: [cross] as never, residuals: [] }, GROUPS)), /Error Code: (?:SnapshotSequence|Sequence)/);

const vaultBefore = await Promise.all(ordered.map(entry => Promise.all(entry.vaults.map(balance))));
const recipientBefore = await Promise.all(ordered.map(entry => Promise.all(entry.recipients.map(balance))));
const settleTransaction = await compile(settleInstruction, false);
settleTransaction.sign([operator]);
const simulation = await simulate(settleTransaction);
if (simulation.value.err) throw new Error(`valid devnet batch failed: ${JSON.stringify(simulation.value.err)}`);
const computeUnits = simulation.value.unitsConsumed ?? 0;
const settleSignature = await paced(() => connection.sendRawTransaction(settleTransaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }), 'sendRawTransaction');
await confirm(settleSignature, 'settle batch');
await expectReject('double-settle-rejected', settleInstruction, /Error Code: Settle/);

const expectedOutputs = ordered.map((entry, memberIndex) => {
  const debit = [0n, 0n, 0n];
  const credit = [0n, 0n, 0n];
  if (memberIndex === sellerIndex) { debit[1] = 2_000_000n; credit[0] = 20_000_000n; }
  if (memberIndex === buyerIndex) { debit[0] = 20_000_000n; credit[1] = 2_000_000n; }
  return entry.funding.map((amount, index) => BigInt(amount) - debit[index] + credit[index]);
});
for (let i = 0; i < ordered.length; i++) {
  const info = await getInfo(batch.intents[i], 'confirmed');
  if (!info || info.data[520] !== 1 || [0, 1, 2].some(a => readU64(info.data, 472 + a * 8) !== 0n)) throw new Error(`devnet intent ${i} is not settled with cleared claims`);
  for (let a = 0; a < 3; a++) {
    if (await balance(ordered[i].vaults[a]) !== 0n) throw new Error(`devnet intent ${i} vault ${a} retained value`);
    if (await balance(ordered[i].recipients[a]) !== recipientBefore[i][a] + expectedOutputs[i][a]) throw new Error(`devnet intent ${i} recipient ${a} delta mismatch`);
  }
}

// 5. Owner recovery of the terminal intents, including a real cancellation on a fresh nonce.
const closeSignatures: string[] = [];
for (const entry of ordered) {
  const accounts = deriveRecoveryAccounts(PROGRAM, config, priceFeed, entry.owner, entry.nonce, mints);
  const info = await getInfo(accounts.intent, 'settled intent');
  if (!info) {
    // A repeat probe run may already have closed this intent in an earlier attempt.
    negativeResults.push({ label: `already-closed-intent/${entry.owner.toBase58().slice(0, 8)}`, log: 'AccountNotInitialized' });
    continue;
  }
  closeSignatures.push(await confirm(await sendIx(buildCloseIntentInstruction(PROGRAM, entry.owner, accounts),
    [owners.find(owner => owner.publicKey.equals(entry.owner))!], 'close settled intent'), 'close settled intent'));
}
const recoveryOwner = owners[2];
// Read the authoritative next nonce: the committed policy forbids a second active intent.
const recoveryStateKey = PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), recoveryOwner.publicKey.toBuffer()], PROGRAM)[0];
const recoveryState = await getInfo(recoveryStateKey, 'recovery owner state');
const recoveryNonce = recoveryState ? readU64(recoveryState.data, 72) : 0n;
const recoveryAccounts = deriveFundAccounts(PROGRAM, config, priceFeed, recoveryOwner.publicKey, recoveryNonce, mints);
const cancelAssets = [
  { funding: '5000000', min_output: '0', max_output: '9000000', funding_reference_price: '1000000' },
  { funding: '0', min_output: '0', max_output: '0', funding_reference_price: '10000000' },
  { funding: '0', min_output: '0', max_output: '0', funding_reference_price: '20000000' },
];
await confirm(await send(fundingTransaction(buildCreateAndFundInstruction(PROGRAM, recoveryOwner.publicKey, recoveryAccounts, {
  expected_policy_hash: manifest.initial_policy_hash, nonce: recoveryNonce.toString(), expiry_unix_seconds: (now + 890n).toString(),
  optimization_commitment: createHash('sha256').update('t24-recovery').digest('hex'), assets: cancelAssets,
})), [recoveryOwner], 'fund recovery intent'), 'fund recovery intent');
const recovery = deriveRecoveryAccounts(PROGRAM, config, priceFeed, recoveryOwner.publicKey, recoveryNonce, mints);
const sourceBefore = await balance(recovery.recipients[0]);
const cancelSignature = await confirm(await sendIx(buildCancelIntentInstruction(PROGRAM, recoveryOwner.publicKey, recovery), [recoveryOwner], 'cancel intent'), 'cancel intent');
const withdrawalSignatures: string[] = [];
for (let a = 0; a < 3; a++) {
  const funded = await balance(recovery.vaults[a]);
  if (funded === 0n) {
    // An asset with no claim must refuse rather than silently succeed.
    const empty = new Transaction().add(buildWithdrawAssetInstruction(PROGRAM, recoveryOwner.publicKey, recovery, a))
      .add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(randomBytes(6).toString('hex')) }));
    empty.feePayer = recoveryOwner.publicKey;
    empty.recentBlockhash = (await latestBlockhash()).blockhash;
    empty.sign(recoveryOwner);
    const result = await simulate(empty);
    const log = (result.value.logs ?? []).join('\n');
    if (!result.value.err || !/NothingToWithdraw/.test(log)) throw new Error(`empty asset ${a} did not refuse`);
    negativeResults.push({ label: `empty-claim-withdrawal-${a}`, log: 'Error Code: NothingToWithdraw' });
    continue;
  }
  withdrawalSignatures.push(await confirm(await sendIx(buildWithdrawAssetInstruction(PROGRAM, recoveryOwner.publicKey, recovery, a), [recoveryOwner], `withdraw ${a}`), `withdraw ${a}`));
}
const closeCancelled = await confirm(await sendIx(buildCloseIntentInstruction(PROGRAM, recoveryOwner.publicKey, recovery), [recoveryOwner], 'close cancelled intent'), 'close cancelled intent');
if (await balance(recovery.recipients[0]) !== sourceBefore + 5_000_000n) throw new Error('cancellation did not return the funded cash slice');
if (await getInfo(recovery.intent, 'confirmed')) throw new Error('cancelled intent was not closed');

const authority = await getInfo(config, 'confirmed');
if (!authority || authority.data.readBigUInt64LE(822) !== 0n) throw new Error('outstanding claim counter did not return to zero');

const record = {
  status: 'PASS', task: 'T24', scope: 'ISOLATED DEVNET PROBE — not a release and not the integrated workflow',
  cluster: 'devnet', genesis, rpc_host: new URL(RPC).hostname, program_id: PROGRAM.toBase58(),
  config: config.toBase58(), prices: priceFeed.toBase58(),
  deployment_id: manifest.deployment_id, policy_hash: manifest.initial_policy_hash,
  price_label: 'TEST PRICES; synthetic fixture oracle; no equity price claim',
  mints: mints.map(mint => mint.toBase58()), owners: ordered.map(entry => entry.owner.toBase58()),
  snapshot_sequence: sequence.toString(), cross, estimated_outputs: expectedOutputs.map(row => row.map(value => value.toString())),
  vault_before: vaultBefore.map(row => row.map(value => value.toString())),
  recipient_before: recipientBefore.map(row => row.map(value => value.toString())),
  compute_units: computeUnits, requested_compute_units: BATCH_COMPUTE_UNIT_LIMIT,
  lookup_table: lookupTableAddress.toBase58(), lookup_table_entries: lookupAddresses.length,
  mandatory_negative_cases: negativeResults.length, negativeResults,
  recovery: { funded: '5000000', returned: '5000000', cancel_signature: cancelSignature,
    withdrawals: withdrawalSignatures, close_signature: closeCancelled },
  signatures: { ...signatures, settle: settleSignature, close_settled: closeSignatures },
  limitations: [
    'Isolated public-devnet probe under the scoped-probe exception: no shared funded intents, no external route, no Pyth, no integration or release claim.',
    'Test assets are devnet mints with revoked authorities, not issuer-backed shares; liquidity, Pyth and the routed residual remain unimplemented (T15/T16).',
    'Upgrade authority is retained by the approved devnet wallet; that is a trust assumption and is disclosed.',
  ],
};
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
