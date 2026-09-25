import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey,
  SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { assertPreparedDeploymentManifest } from './deployment-manifest.js';
import { buildCreateAndFundInstruction, deriveFundAccounts, fundingTransaction } from '../packages/client/src/fund.js';
import { decodeSettlementBody, encodeSettlementBody } from '../packages/planner/src/validate.js';
import { buildSettleBatchInstruction, deriveBatchAccounts } from '../packages/client/src/build-batch.js';

/**
 * T32 end-to-end: the service path without manually pasting anything.
 *
 * Phase `fund` prepares the fixture (one intent per owner). Phase `e2e` drives the running service
 * over HTTP — plan, funded-intent discovery, batch preparation, operator signing, broadcast and
 * reconciliation from chain — and records what each step actually returned.
 */
const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const args = process.argv.slice(2);
if (args.length !== 5) throw new Error('usage: tsx scripts/demo-t32-service.ts <local-rpc> <manifest> <env.json> <service-url> <out.json>');
const [rpc, manifestPath, envPath, serviceUrl, outPath] = args;
const phase = process.env.T32_PHASE ?? 'e2e';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('local validator RPC only');
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(serviceUrl)) throw new Error('loopback service URL required');
const connection = new Connection(rpc, 'confirmed');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const env = JSON.parse(readFileSync(envPath, 'utf8'));
const genesis = await connection.getGenesisHash();
await assertPreparedDeploymentManifest(manifest, genesis);
if (manifest.cluster !== 'localnet' || manifest.program_id !== PROGRAM.toBase58()) throw new Error('local CrossFlow manifest required');
const signers: Keypair[] = env.owner_paths.map((path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')))));
const mints: PublicKey[] = manifest.policy.assets.map((asset: { mint: string }) => new PublicKey(Buffer.from(asset.mint, 'hex')));
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(manifest.deployment_id, 'hex')], PROGRAM);
const [prices] = PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], PROGRAM);
const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const readU64 = (data: Buffer, offset: number) => { let value = 0n; for (let i = 0; i < 8; i++) value |= BigInt(data[offset + i]) << BigInt(8 * i); return value; };
const i32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; };
const observations = (timestamp: bigint) => Buffer.concat([0, 1, 2].map(i => Buffer.concat([
  mints[i].toBuffer(), Buffer.from(manifest.policy.assets[i].feed_id, 'hex'), u64([1_000_000n, 10_000_000n, 20_000_000n][i]),
  u64(0n), i32(-6), Buffer.from([0]), u64(timestamp), u64(timestamp), Buffer.from([0])])));
const send = async (tx: Transaction, txSigners: Keypair[]) => sendAndConfirmTransaction(connection, tx, txSigners, { commitment: 'confirmed' });
const json = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${serviceUrl}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

let now = BigInt((await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? 0);
if (now === 0n) throw new Error('local validator has no confirmed block time');
let configInfo = await connection.getAccountInfo(config, 'confirmed');
if (!configInfo) {
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: signers[0].publicKey, toPubkey: config,
    lamports: await connection.getMinimumBalanceForRentExemption(831) })), [signers[0]]);
  await send(new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: signers[0].publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: prices, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: Buffer.concat([disc('initialize_config'), observations(now)]) })), [signers[0]]);
}
const publishPrices = async (): Promise<bigint> => {
  now = BigInt((await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? 0);
  const info = await connection.getAccountInfo(prices, 'confirmed');
  if (!info) throw new Error('fixture snapshot missing');
  const sequence = readU64(info.data as Buffer, 105) + 1n;
  await send(new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: signers[0].publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: prices, isSigner: false, isWritable: true },
  ], data: Buffer.concat([disc('publish_prices'), u64(sequence), observations(now)]) })), [signers[0]]);
  return sequence;
};

const sliceSpecs = [
  { cash: { funding: '10000000', min: '0', max: '60000000' }, stock1: { funding: '4000000', min: '0', max: '4000000' }, stock2: { funding: '0', min: '0', max: '0' } },
  { cash: { funding: '40000000', min: '0', max: '40000000' }, stock1: { funding: '0', min: '2000000', max: '2000000' }, stock2: { funding: '0', min: '0', max: '0' } },
  { cash: { funding: '30000000', min: '0', max: '30000000' }, stock1: { funding: '0', min: '0', max: '0' }, stock2: { funding: '0', min: '0', max: '0' } },
];

async function fundedIntentCount(): Promise<number> {
  const listed = await json('/intents');
  const intents = (listed.body.intents ?? []) as { status: string }[];
  return intents.filter(intent => intent.status === 'Funded').length;
}

if (phase === 'fund') {
  // Recover anything a previous run left, then fund one intent per owner.
  for (const signer of signers) {
    const [stateKey] = PublicKey.findProgramAddressSync([Buffer.from('owner'), config.toBuffer(), signer.publicKey.toBuffer()], PROGRAM);
    const state = await connection.getAccountInfo(stateKey, 'confirmed');
    if (!state) continue;
    const next = readU64(state.data as Buffer, 72);
    if ((state.data as Buffer)[80] !== 1) continue;
    const nonce = next - 1n;
    const [intentKey] = PublicKey.findProgramAddressSync([Buffer.from('intent'), config.toBuffer(), signer.publicKey.toBuffer(), u64(nonce)], PROGRAM);
    if (!(await connection.getAccountInfo(intentKey, 'confirmed'))) continue;
    const accounts = deriveFundAccounts(PROGRAM, config, prices, signer.publicKey, nonce, mints);
    const statusInfo = await connection.getAccountInfo(intentKey, 'confirmed');
    if (statusInfo && (statusInfo.data as Buffer)[520] === 0) {
      await send(new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
        { pubkey: intentKey, isSigner: false, isWritable: true },
      ], data: disc('cancel_intent') })), [signer]);
    }
    for (let asset = 0; asset < 3; asset++) {
      try {
        await send(new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
          { pubkey: signer.publicKey, isSigner: true, isWritable: true },
          { pubkey: config, isSigner: false, isWritable: false },
          { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
          { pubkey: intentKey, isSigner: false, isWritable: true },
          ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
          ...accounts.vaults.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
          ...accounts.sources.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ], data: Buffer.concat([disc('withdraw_asset'), Buffer.from([asset])]) })), [signer]);
      } catch { /* nothing to withdraw for this asset */ }
    }
    await send(new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
      { pubkey: intentKey, isSigner: false, isWritable: true },
      ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
      ...accounts.vaults.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ], data: disc('close_intent') })), [signer]);
  }

  await publishPrices();
  const fundingSignatures: string[] = [];
  for (let index = 0; index < signers.length; index++) {
    const spec = sliceSpecs[index];
    const owner = signers[index].publicKey;
    const accounts = deriveFundAccounts(PROGRAM, config, prices, owner, 0n, mints);
    const assets = [spec.cash, spec.stock1, spec.stock2].map((asset, assetIndex) => ({
      funding: asset.funding, min_output: asset.min, max_output: asset.max,
      funding_reference_price: [1_000_000n, 10_000_000n, 20_000_000n][assetIndex].toString(),
    }));
    const transaction = fundingTransaction(buildCreateAndFundInstruction(PROGRAM, owner, accounts, {
      expected_policy_hash: manifest.initial_policy_hash, nonce: '0', expiry_unix_seconds: (now + 890n).toString(),
      optimization_commitment: createHash('sha256').update(`t32-slice-${index}`).digest('hex'), assets,
    }));
    fundingSignatures.push(await send(transaction, [signers[index]]));
  }
  writeFileSync(outPath, `${JSON.stringify({ status: 'FUNDED', task: 'T32', cluster: 'localnet', genesis,
    funded_intents: signers.length, funding_signatures: fundingSignatures }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'FUNDED', funded: signers.length }));
} else {
  const steps: { step: string; detail: unknown }[] = [];
  const health = await json('/health');
  steps.push({ step: 'health', detail: health.body });
  const deployment = await json('/deployment');
  steps.push({ step: 'deployment', detail: { cluster: deployment.body.cluster, config: deployment.body.config, routeEnabled: deployment.body.routeEnabled } });
  const price = await json('/price');
  steps.push({ step: 'price', detail: { sequence: price.body.sequence, label: price.body.label } });

  const plans = await json('/plans', { method: 'POST', body: JSON.stringify({ scenario_id: 'opposite-01', grid_step: 4 }) });
  if (plans.status !== 200) throw new Error(`/plans failed: ${JSON.stringify(plans.body)}`);
  const proposals = plans.body.proposals as Record<string, { feasible: boolean; status: string }>;
  steps.push({ step: 'plans', detail: { scenario: plans.body.scenario_id,
    status: Object.fromEntries(Object.entries(proposals).map(([k, v]) => [k, v.status])) } });

  const listed = await json('/intents');
  const intents = (listed.body.intents ?? []) as { address: string; owner: string; status: string; nonce: string;
    mandateHash: string; bookedClaims: string[] }[];
  const funded = intents.filter(intent => intent.status === 'Funded');
  steps.push({ step: 'intents', detail: { total: intents.length, funded: funded.length,
    statuses: intents.map(intent => intent.status) } });
  if (funded.length < 2) throw new Error(`expected at least two funded intents, found ${funded.length}; response=${JSON.stringify(listed.body).slice(0, 400)}`);
  if (funded.length !== (await fundedIntentCount())) throw new Error('service intent counts disagree between calls');

  // A plan is built from what the service reports, exactly as an operator client would.
  // The plan names bound mandate hashes, not account addresses.
  const ordered = funded.map(intent => intent.mandateHash);
  // The batch order is raw owner-byte order, so the participants are found by what they signed
  // rather than by the order the fixture happened to fund them in.
  const first = funded.findIndex(intent => intent.bookedClaims[1] === '4000000');
  const second = funded.findIndex(intent => intent.bookedClaims[0] === '40000000');
  if (first < 0 || second < 0 || first === second) throw new Error('could not identify the seller and buyer slices from booked claims');
  // Sized so every owner's realized output stays inside the bounds its own slice signed: owner 1
  // requires at least 2,000,000 stock1, so the cross must deliver exactly that.
  const cross = { stock_index: '1', seller_index: String(first), buyer_index: String(second),
    stock_quantity: '2000000', cash_amount: '20000000' };
  const snapshotSequence = String(price.body.sequence);
  const plan = { schema_version: '1', expected_snapshot_sequence: snapshotSequence, mandate_hashes: ordered,
    crosses: [cross], residuals: [], estimated_outputs: [] };

  // Three owners exceed the legacy packet, so the operator publishes a lookup table first and the
  // service compiles the transaction against it. The service never creates or owns the table.
  const rentPayer = signers[0];
  const memo = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  const candidates: PublicKey[] = [config, prices, PROGRAM,
    new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    new PublicKey('Sysvar1nstructions1111111111111111111111111'), ...mints];
  for (const intent of funded) {
    const accounts = deriveFundAccounts(PROGRAM, config, prices, new PublicKey(intent.owner), BigInt(intent.nonce), mints);
    candidates.push(accounts.owner_state, accounts.intent, ...accounts.vaults, ...accounts.sources);
  }
  let lookupTable: PublicKey | null = null;
  for (let attempt = 0; attempt < 40 && !lookupTable; attempt++) {
    const [ix, address] = AddressLookupTableProgram.createLookupTable({ authority: rentPayer.publicKey,
      payer: rentPayer.publicKey, recentSlot: Math.max(0, (await connection.getSlot('finalized')) - 1 - attempt) });
    const probe = new Transaction().add(ix)
      .add(new TransactionInstruction({ programId: memo, keys: [], data: Buffer.from(randomBytes(6).toString('hex')) }));
    probe.feePayer = rentPayer.publicKey;
    probe.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    probe.sign(rentPayer);
    if ((await connection.simulateTransaction(probe)).value.err) { await new Promise(resolve => setTimeout(resolve, 400)); continue; }
    await send(new Transaction().add(ix), [rentPayer]);
    lookupTable = address;
  }
  if (!lookupTable) throw new Error('no usable lookup-table slot on this validator');
  const unique = [...new Map(candidates.map(key => [key.toBase58(), key])).values()];
  for (let offset = 0; offset < unique.length; offset += 12) {
    await send(new Transaction().add(AddressLookupTableProgram.extendLookupTable({ lookupTable,
      authority: rentPayer.publicKey, payer: rentPayer.publicKey, addresses: unique.slice(offset, offset + 12) })), [rentPayer]);
  }
  // The extending slot must be *rooted* before a transaction may reference the table: waiting on
  // the confirmed slot alone leaves a race in which the leader silently drops the transaction.
  let lookupAccount: AddressLookupTableAccount | null = null;
  for (let attempt = 0; attempt < 90 && !lookupAccount; attempt++) {
    const fetched = await connection.getAddressLookupTable(lookupTable);
    if (fetched.value && fetched.value.state.addresses.length === unique.length &&
        (await connection.getSlot('finalized')) > fetched.value.state.lastExtendedSlot) lookupAccount = fetched.value;
    else await new Promise(resolve => setTimeout(resolve, 400));
  }
  if (!lookupAccount) throw new Error('lookup table did not activate in time');
  await new Promise(resolve => setTimeout(resolve, 600));

  const prepared = await json('/batches/prepare', { method: 'POST', body: JSON.stringify({
    plan, operator: rentPayer.publicKey.toBase58(), lookupTable: lookupTable.toBase58() }) });
  if (prepared.status !== 200) throw new Error(`/batches/prepare rejected: ${JSON.stringify(prepared.body)}`);
  steps.push({ step: 'lookup-table', detail: { address: lookupTable.toBase58(), entries: unique.length } });

  // The prepared transaction is versioned when a lookup table was supplied, so the body is read
  // from the compiled instruction rather than from a legacy `instructions` array.
  const preparedBytes = Buffer.from(String(prepared.body.transaction), 'base64');
  // The compute-budget instruction is prepended, so the settlement is the last compiled one.
  const compiled = VersionedTransaction.deserialize(preparedBytes).message.compiledInstructions;
  const instructionData = compiled[compiled.length - 1].data;
  const decoded = decodeSettlementBody(Buffer.from(instructionData).subarray(12));
  steps.push({ step: 'prepare', detail: { preview: prepared.body.preview, bodyBatchCount: decoded.batch_count,
    outputs: prepared.body.outputs, debits: prepared.body.debits, credits: prepared.body.credits } });

  // The operator signs what the service returned; the service never sees a key.
  const transaction = VersionedTransaction.deserialize(Buffer.from(String(prepared.body.transaction), 'base64'));
  transaction.sign([signers[0]]);
  {
    // Simulate exactly what will be sent, so a malformed message surfaces here rather than as a
    // silent drop.
    const probe = VersionedTransaction.deserialize(transaction.serialize());
    const simulated = await connection.simulateTransaction(probe, { sigVerify: false, commitment: 'confirmed' });
    steps.push({ step: 'simulate', detail: { err: simulated.value.err, units: simulated.value.unitsConsumed,
      logs: (simulated.value.logs ?? []).slice(-6) } });
    if (simulated.value.err) throw new Error(`prepared transaction does not simulate: ${JSON.stringify(simulated.value.err)}\n${(simulated.value.logs ?? []).join('\n')}`);
  }
  const heightSamples: number[] = [];
  for (let i = 0; i < 6; i++) { heightSamples.push(await connection.getBlockHeight('confirmed')); await new Promise(resolve => setTimeout(resolve, 400)); }
  steps.push({ step: 'height-samples', detail: { samples: heightSamples, slot: await connection.getSlot('confirmed') } });
  // The service must have built exactly what a local client would build from the same validated
  // plan. Comparing the bytes is the strongest available check that it did not improvise.
  {
    const localAccounts = deriveBatchAccounts(PROGRAM, config, prices, mints,
      funded.map(entry => ({ owner: new PublicKey(entry.owner), nonce: BigInt(entry.nonce) })));
    const localInstruction = buildSettleBatchInstruction(PROGRAM, localAccounts, encodeSettlementBody(
      { schema_version: '1', expected_snapshot_sequence: snapshotSequence, crosses: [cross], residuals: [] }, funded.length));
    const localMessage = new TransactionMessage({ payerKey: signers[0].publicKey,
      recentBlockhash: preparedBytes.length ? transaction.message.recentBlockhash : '',
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), localInstruction] })
      .compileToV0Message([lookupAccount]);
    steps.push({ step: 'local-build-equivalence', detail: {
      localInstructionAccounts: localInstruction.keys.length,
      batchCount: decoded.batch_count,
      sameCompiledInstructions: JSON.stringify(localMessage.compiledInstructions.map(entry => [...entry.data])) ===
        JSON.stringify(transaction.message.compiledInstructions.map(entry => [...entry.data])),
      sameStaticKeys: JSON.stringify(localMessage.staticAccountKeys.map(key => key.toBase58())) ===
        JSON.stringify(transaction.message.staticAccountKeys.map(key => key.toBase58())),
    } });
  }

  const heightBefore = await connection.getBlockHeight('confirmed');
  const settleSignature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed', maxRetries: 5 });
  const heightAfter = await connection.getBlockHeight('confirmed');
  steps.push({ step: 'broadcast', detail: {
    operator: signers[0].publicKey.toBase58(),
    feePayer: transaction.message.staticAccountKeys[0]?.toBase58(),
    signatureCount: transaction.signatures.length,
    signature: settleSignature, heightBefore, heightAfter,
    serializedBytes: transaction.serialize().length,
    lookupTables: transaction.message.addressTableLookups.length,
    blockhash: transaction.message.recentBlockhash } });

  // Poll the signature rather than relying on a timeout strategy, so a failure reports the
  // program's own logs instead of "unknown whether it succeeded".
  let confirmed = false;
  let failure: unknown = null;
  for (let attempt = 0; attempt < 40 && !confirmed; attempt++) {
    const statuses = await connection.getSignatureStatuses([settleSignature], { searchTransactionHistory: true });
    const status = statuses.value[0];
    if (status?.err) { failure = status.err; break; }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') confirmed = true;
    else await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!confirmed) {
    const detail = await connection.getTransaction(settleSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
    const logs = detail?.meta?.logMessages ?? [];
    throw new Error(`settlement did not confirm (err=${JSON.stringify(failure ?? detail?.meta?.err ?? null)})\n${logs.join('\n')}`);
  }

  const reconciled = await json('/intents');
  const after = (reconciled.body.intents ?? []) as { address: string; status: string }[];
  const settled = after.filter(intent => funded.some(entry => entry.address === intent.address) && intent.status === 'Settled');
  steps.push({ step: 'reconciled', detail: { settled: settled.length, statuses: after.map(intent => intent.status) } });
  // Every funded participant is settled by the batch, not only the two that crossed.
  if (settled.length !== funded.length) throw new Error(`expected ${funded.length} settled intents, found ${settled.length}`);

  const record = {
    status: 'PASS', task: 'T32', scope: 'LOCAL SERVICE END-TO-END; no devnet, no route, no UI',
    cluster: 'localnet', genesis, program_id: PROGRAM.toBase58(), config: config.toBase58(),
    service_url: serviceUrl, operator: signers[0].publicKey.toBase58(),
    settlement_signature: settleSignature, settle_nonce: randomBytes(4).toString('hex'),
    steps, limitations: [
      'Local validator and synthetic TEST PRICES; the plan is a fixture scenario, not a live market.',
      'The service returns an unsigned transaction: the operator wallet signs and pays the network fee.',
      'No external residual route and no UI are exercised here; those are T16 and T18–T20.',
    ],
    hashes: {
      manifest: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
      env: createHash('sha256').update(readFileSync(envPath)).digest('hex'),
    },
  };
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'PASS', settled: settled.length, signature: settleSignature }, null, 2));
}
