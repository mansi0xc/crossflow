import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey,
  SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { assertPreparedDeploymentManifest } from './deployment-manifest.js';
import { ControlledVenue, deriveControlledPool } from '../packages/adapters/src/controlled.js';
import { canonicalAta } from '../packages/adapters/src/types.js';
import { decodeIntent, listIntents } from '../packages/client/src/intents.js';
import { buildCreateAndFundInstruction, deriveFundAccounts, fundingTransaction } from '../packages/client/src/fund.js';
import { batchTransaction, buildSettleBatchInstruction, buildSettleRoutedInstruction, deriveBatchAccounts, deriveRoutedBatchAccounts } from '../packages/client/src/build-batch.js';
import { compileProposal } from '../packages/planner/src/proposal.js';
import { encodeSettlementBody } from '../packages/planner/src/validate.js';

/**
 * The connection the whole product claim depends on: a portfolio the optimizer has never seen,
 * proposed, approved, settled and reconciled — with the settlement derived from the proposal rather
 * than invented.
 *
 * It runs the flow twice. The second run changes one owner's target, and the demonstration is that
 * both the proposal *and* the shape of the settlement change: a matched cross becomes a smaller
 * cross plus an external residual. That is the behaviour a judge cannot fake and a demo cannot
 * hand-wave.
 */
const args = process.argv.slice(2);
if (args.length !== 5) throw new Error('usage: tsx scripts/demo-optimizer-execution.ts <local-rpc> <manifest> <env.json> <service-url> <out.json>');
const [rpc, manifestPath, envPath, serviceUrl, outPath] = args;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('local validator RPC only');
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(serviceUrl)) throw new Error('loopback service URL required');

const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const connection = new Connection(rpc, 'confirmed');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const env = JSON.parse(readFileSync(envPath, 'utf8'));
const genesis = await connection.getGenesisHash();
await assertPreparedDeploymentManifest(manifest, genesis);
if (manifest.policy.route_kind !== '1') throw new Error('this demo needs the route-enabled manifest, because the second run routes externally');

const owners: Keypair[] = env.owner_paths.map((path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')))));
const mints: PublicKey[] = manifest.policy.assets.map((asset: { mint: string }) => new PublicKey(Buffer.from(asset.mint, 'hex')));
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(manifest.deployment_id, 'hex')], PROGRAM);
const [prices] = PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], PROGRAM);
const venue = new ControlledVenue({ programId: new PublicKey('Bq1FxNWHnmnZgJRi6fsRKrvLTbBf6uDTXjaawzdnkw1Q'),
  pool: deriveControlledPool(new PublicKey('Bq1FxNWHnmnZgJRi6fsRKrvLTbBf6uDTXjaawzdnkw1Q'), mints),
  poolAuthority: owners[0].publicKey, mints, feeBps: 30, label: 'CONTROLLED SYNTHETIC VENUE; test liquidity only' });

const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const readU64 = (data: Buffer, offset: number) => { let value = 0n; for (let i = 0; i < 8; i++) value |= BigInt(data[offset + i]) << BigInt(8 * i); return value; };
const i32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; };
const REFERENCE = [1_000_000n, 10_000_000n, 20_000_000n];
const observations = (timestamp: bigint) => Buffer.concat([0, 1, 2].map(index => Buffer.concat([
  mints[index].toBuffer(), Buffer.from(manifest.policy.assets[index].feed_id, 'hex'), u64(REFERENCE[index]),
  u64(0n), i32(-6), Buffer.from([0]), u64(timestamp), u64(timestamp), Buffer.from([0])])));
const send = async (tx: Transaction, signers: Keypair[]) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
const json = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${serviceUrl}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const balance = async (key: PublicKey) => {
  const info = await connection.getAccountInfo(key, 'confirmed');
  if (!info) return 0n;
  if (!info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 165) throw new Error(`not a token account: ${key.toBase58()}`);
  let amount = 0n; for (let i = 0; i < 8; i++) amount |= BigInt((info.data as Buffer)[64 + i]) << BigInt(8 * i);
  return amount;
};

// ---------------------------------------------------------------------------------------------
// Fixture: three independently bounded slices, one owner per slice, plus test liquidity.
// ---------------------------------------------------------------------------------------------
let now = BigInt((await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? 0);
if (now === 0n) throw new Error('local validator has no confirmed block time');
if (!(await connection.getAccountInfo(config, 'confirmed'))) {
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: owners[0].publicKey, toPubkey: config,
    lamports: await connection.getMinimumBalanceForRentExemption(831) })), [owners[0]]);
  await send(new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: owners[0].publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: prices, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: Buffer.concat([disc('initialize_config'), observations(now)]) })), [owners[0]]);
}
const publishPrices = async (): Promise<bigint> => {
  now = BigInt((await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? 0);
  const info = await connection.getAccountInfo(prices, 'confirmed');
  if (!info) throw new Error('fixture snapshot missing');
  const sequence = readU64(info.data as Buffer, 105) + 1n;
  await send(new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: owners[0].publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: prices, isSigner: false, isWritable: true },
  ], data: Buffer.concat([disc('publish_prices'), u64(sequence), observations(now)]) })), [owners[0]]);
  return sequence;
};

// One slice per owner. The bounds are the signed envelope the optimizer's proposal must respect:
// owner A may end holding between zero and four million stock1, owner B between zero and two
// million, and both may hold up to their cash funding.
const SLICES = [
  { cash: { funding: '1000000', min: '0', max: '60000000' }, stock1: { funding: '4000000', min: '0', max: '4000000' }, stock2: { funding: '0', min: '0', max: '0' } },
  { cash: { funding: '40000000', min: '0', max: '40000000' }, stock1: { funding: '0', min: '0', max: '2000000' }, stock2: { funding: '0', min: '0', max: '0' } },
  { cash: { funding: '30000000', min: '0', max: '30000000' }, stock1: { funding: '0', min: '0', max: '0' }, stock2: { funding: '0', min: '0', max: '0' } },
];

// The venue must hold test liquidity for the second run's residual. Seeded from the operator.
if (!(await connection.getAccountInfo(venue.pool, 'confirmed'))) await send(new Transaction().add(venue.buildInitializePool()), [owners[0]]);
for (let index = 0; index < 3; index++) {
  if (await connection.getAccountInfo(venue.vaults()[index], 'confirmed')) continue;
  await send(new Transaction().add(new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [
    { pubkey: owners[0].publicKey, isSigner: true, isWritable: true },
    { pubkey: venue.vaults()[index], isSigner: false, isWritable: true },
    { pubkey: venue.pool, isSigner: false, isWritable: false },
    { pubkey: mints[index], isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
  ] })), [owners[0]]);
}
const seed = async (index: number, amount: bigint) => {
  if (await balance(venue.vaults()[index]) >= amount) return;
  await send(new Transaction().add(new TransactionInstruction({ programId: TOKEN_PROGRAM,
    data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([6])]), keys: [
      { pubkey: canonicalAta(owners[0].publicKey, mints[index]), isSigner: false, isWritable: true },
      { pubkey: mints[index], isSigner: false, isWritable: false },
      { pubkey: venue.vaults()[index], isSigner: false, isWritable: true },
      { pubkey: owners[0].publicKey, isSigner: true, isWritable: false },
    ] })), [owners[0]]);
};
await seed(0, 50_000_000n);
await seed(1, 5_000_000n);

// ---------------------------------------------------------------------------------------------
// Run one full cycle: proposal, compile, approve, settle, reconcile.
// ---------------------------------------------------------------------------------------------
async function fundedIntentOwners(): Promise<{ owner: string; nonce: string; address: string; assets: { funding: string; minOutput: string; maxOutput: string }[] }[]> {
  const intents = await listIntents(connection, PROGRAM, config);
  return intents.filter(intent => intent.status === 0).map(intent => ({ owner: intent.owner, nonce: intent.nonce,
    address: intent.address, assets: intent.assets }));
}

async function fundSlices(): Promise<string[]> {
  const signatures: string[] = [];
  await publishPrices();
  for (let index = 0; index < SLICES.length; index++) {
    const spec = SLICES[index];
    const owner = owners[index];
    const accounts = deriveFundAccounts(PROGRAM, config, prices, owner.publicKey, 0n, mints);
    const transaction = fundingTransaction(buildCreateAndFundInstruction(PROGRAM, owner.publicKey, accounts, {
      expected_policy_hash: manifest.initial_policy_hash, nonce: '0', expiry_unix_seconds: (now + 890n).toString(),
      optimization_commitment: createHash('sha256').update(`optimizer-demo-${index}`).digest('hex'),
      assets: [spec.cash, spec.stock1, spec.stock2].map((asset, assetIndex) => ({ funding: asset.funding,
        min_output: asset.min, max_output: asset.max, funding_reference_price: REFERENCE[assetIndex].toString() })),
    }));
    signatures.push(await send(transaction, [owner]));
  }
  return signatures;
}

interface CycleResult {
  label: string;
  compiled: { crosses: unknown[]; residuals: unknown[]; explanation: string[] };
  proposal: { per_account: unknown[]; totals: unknown; method: string; status: string };
  settlement: { signature: string; compute_units?: number; serialized_bytes: number; routed: boolean; lookup_table_entries: number };
  preflight_note: string;
  modelled_versus_realized: { owner: string; asset: string; modelled_change_raw: string; realized_change_raw: string; difference_raw: string }[];
  reconciled: { owner: string; proposed_change_raw: Record<string, string>; delivered_change_raw: Record<string, string>; matches_proposal: boolean; signed_bounds: unknown }[];
  portfolio_sha256?: unknown;
  assumptions?: unknown;
}

async function runCycle(label: string, targets: { stock1: Record<string, number> }): Promise<CycleResult> {
  const funded = await fundedIntentOwners();
  if (funded.length !== 3) throw new Error(`expected three funded slices, found ${funded.length}`);
  const ordered = [...funded].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  const assetIds = ['STOCK_A', 'STOCK_B', 'CASH'];
  const toAmounts = (assets: { funding: string }[]) => ({ STOCK_A: Number(assets[1].funding), STOCK_B: Number(assets[2].funding), CASH: Number(assets[0].funding) });

  // The portfolio the optimizer sees is the operator's own book: the funded slices, with targets
  // the operator chooses and bounds the owners already signed.
  const portfolioAccounts = ordered.map((intent, index) => ({
    id: `slice-${index}`,
    initial_raw: toAmounts(intent.assets),
    target_raw: { STOCK_A: targets.stock1[intent.owner] ?? toAmounts(intent.assets).STOCK_A, STOCK_B: 0 },
    final_bounds_raw: {
      STOCK_A: { min: Number(intent.assets[1].minOutput), max: Number(intent.assets[1].maxOutput) },
      STOCK_B: { min: Number(intent.assets[2].minOutput), max: Number(intent.assets[2].maxOutput) },
      CASH: { min: Number(intent.assets[0].minOutput), max: Number(intent.assets[0].maxOutput) },
    },
  }));
  const portfolio = {
    label,
    assets: [
      // Prices are micro-USD per *raw* unit, and every test mint here has six decimals, so one raw
      // stock unit is a millionth of a share. The on-chain fixture prices describe a different
      // denomination and are not reused here.
      { id: 'STOCK_A', decimals: 6, price_micro_usd_per_raw: 10 },
      { id: 'STOCK_B', decimals: 6, price_micro_usd_per_raw: 20 },
      { id: 'CASH', decimals: 6, price_micro_usd_per_raw: 1 },
    ],
    accounts: portfolioAccounts,
  };

  // The search granularity over each owner's signed bounds. Raw quantities here are in millions,
  // so a step of one would exhaust the candidate budget; a million-unit step keeps the space small
  // while still containing every target the operator asked for.
  const planned = await json('/plans', { method: 'POST', body: JSON.stringify({ portfolio, grid_step: 1_000_000 }) });
  if (planned.status !== 200) throw new Error(`/plans refused the portfolio: ${JSON.stringify(planned.body)}`);
  const proposals = planned.body.proposals as Record<string, Record<string, unknown>>;
  const chosen = proposals.C;
  if (!chosen?.feasible) throw new Error(`the cooperative proposal is not feasible: ${JSON.stringify(chosen?.reasons)}`);

  // The settlement is compiled from the proposal, not chosen by the caller.
  const rows = (chosen.settlement_accounts ?? []) as { id: string }[];
  if (rows.length !== ordered.length) throw new Error('the proposal does not cover every slice');
  const byId = new Map(ordered.map((intent, index) => [`slice-${index}`, intent.owner]));
  // The same prices the portfolio declared, so the compiled cash legs reproduce the accounting the
  // engine priced. Using anything else here would be a different trade.
  const compiled = compileProposal({
    accounts: rows.map(row => ({ ...(row as Record<string, unknown>), owner: byId.get(row.id)! }) as never),
    prices: { STOCK_A: '10', STOCK_B: '20', CASH: '1' },
  });
  if (compiled.unrepresented.length > 0) throw new Error(`the proposal could not be fully represented: ${JSON.stringify(compiled.unrepresented)}`);

  const sequence = await publishPrices();
  const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: sequence.toString(),
    crosses: compiled.crosses, residuals: compiled.residuals }, ordered.length);
  const members = ordered.map(intent => ({ owner: new PublicKey(intent.owner), nonce: BigInt(intent.nonce) }));

  // Approval uses the same derived accounts an operator would; the transaction is built here rather
  // than by the service only because the lookup table is created in this process.
  const routed = compiled.residuals.length > 0;
  // A routed batch pools every debit before the venue leg, so its transient pool accounts must
  // exist and start empty. They are derived from the batch PDA and created once by the operator.
  if (routed) {
    const [authority] = PublicKey.findProgramAddressSync([Buffer.from('batch'), config.toBuffer()], PROGRAM);
    for (let asset = 0; asset < 3; asset++) {
      const pool = canonicalAta(authority, mints[asset]);
      if (await connection.getAccountInfo(pool, 'confirmed')) continue;
      await send(new Transaction().add(new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [
        { pubkey: owners[0].publicKey, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: false, isWritable: false },
        { pubkey: mints[asset], isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ] })), [owners[0]]);
    }
  }
  const derived = routed
    ? deriveRoutedBatchAccounts(PROGRAM, config, prices, mints, members, { program: venue.programId, pool: venue.pool })
    : deriveBatchAccounts(PROGRAM, config, prices, mints, members);
  const instruction = routed
    ? buildSettleRoutedInstruction(PROGRAM, derived as never, body)
    : buildSettleBatchInstruction(PROGRAM, derived as never, body);

  const lookupAddresses = [...new Map([...members.map(member => member.owner), config, prices, PROGRAM, ...mints,
    ...derived.vaults.flat(), ...derived.recipients.flat(), ...((derived as { pools?: PublicKey[] }).pools ?? []),
    ...(routed ? [...venue.vaults(), venue.pool] : []), TOKEN_PROGRAM, ATA_PROGRAM].map(key => [key.toBase58(), key])).values()];
  let lookup: AddressLookupTableAccount | null = null;
  for (let attempt = 0; attempt < 40 && !lookup; attempt++) {
    const [createIx, address] = AddressLookupTableProgram.createLookupTable({ authority: owners[0].publicKey,
      payer: owners[0].publicKey, recentSlot: Math.max(0, (await connection.getSlot('finalized')) - 1 - attempt) });
    const probe = new Transaction().add(createIx).add(new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from(randomBytes(6).toString('hex')) }));
    probe.feePayer = owners[0].publicKey;
    probe.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    probe.sign(owners[0]);
    if ((await connection.simulateTransaction(probe)).value.err) continue;
    await send(new Transaction().add(createIx), [owners[0]]);
    for (let offset = 0; offset < lookupAddresses.length; offset += 12) {
      await send(new Transaction().add(AddressLookupTableProgram.extendLookupTable({ lookupTable: address,
        authority: owners[0].publicKey, payer: owners[0].publicKey, addresses: lookupAddresses.slice(offset, offset + 12) })), [owners[0]]);
    }
    for (let wait = 0; wait < 90 && !lookup; wait++) {
      const fetched = await connection.getAddressLookupTable(address);
      if (fetched.value && fetched.value.state.addresses.length === lookupAddresses.length &&
          (await connection.getSlot('finalized')) > fetched.value.state.lastExtendedSlot) lookup = fetched.value;
      else await new Promise(resolve => setTimeout(resolve, 400));
    }
  }
  if (!lookup) throw new Error('lookup table did not activate');
  await new Promise(resolve => setTimeout(resolve, 600));

  // Reproduce the program's own output arithmetic before sending, so a bounds violation is a clear
  // local message rather than a chain rejection.
  let explanationNote = '';
  {
    const funding = ordered.map(intent => [BigInt(intent.assets[0].funding), BigInt(intent.assets[1].funding), BigInt(intent.assets[2].funding)]);
    const debit = ordered.map(() => [0n, 0n, 0n]);
    const credit = ordered.map(() => [0n, 0n, 0n]);
    for (const cross of compiled.crosses) {
      const stock = Number(cross.stock_index);
      const sellerIndex = Number(cross.seller_index);
      const buyerIndex = Number(cross.buyer_index);
      debit[sellerIndex][stock] += BigInt(cross.stock_quantity);
      credit[buyerIndex][stock] += BigInt(cross.stock_quantity);
      debit[buyerIndex][0] += BigInt(cross.cash_amount);
      credit[sellerIndex][0] += BigInt(cross.cash_amount);
    }
    for (const residual of compiled.residuals) {
      const stock = Number(residual.stock_index);
      const inputAsset = residual.direction === '0' ? stock : 0;
      residual.input_allocations.forEach((amount, index) => { debit[index][inputAsset] += BigInt(amount); });
    }
    const violations: string[] = [];
    const projected = ordered.map((intent, index) => {
      const row: string[] = [];
      for (let asset = 0; asset < 3; asset++) {
        const output = funding[index][asset] - debit[index][asset] + credit[index][asset];
        const bounds = [intent.assets[0], intent.assets[1], intent.assets[2]][asset];
        const min = BigInt(bounds.minOutput);
        const max = BigInt(bounds.maxOutput);
        if (output < min || output > max) {
          violations.push(`owner ${index} asset ${asset}: output ${output} outside [${min}, ${max}]`);
        }
        row.push(output.toString());
      }
      return row;
    });
    if (violations.length > 0) {
      throw new Error(`the compiled settlement would breach a signed bound before it reaches the chain: ${violations.join('; ')}`);
    }
    // With a residual leg the credits depend on what the venue actually returns, so this check can
    // bound the debit side but not the final outputs. Saying so is the point: the on-chain check is
    // the authority on the rest.
    void projected;
    if (compiled.residuals.length > 0) {
      explanationNote = 'the pre-flight bound check covers the debit side only; residual credits are measured on chain';
    }
  }

  const message = new TransactionMessage({ payerKey: owners[0].publicKey,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction] })
    .compileToV0Message([lookup]);
  const transaction = new VersionedTransaction(message);
  transaction.sign([owners[0]]);
  const simulated = await connection.simulateTransaction(transaction, { commitment: 'confirmed' });
  if (simulated.value.err) throw new Error(`the compiled settlement does not simulate: ${JSON.stringify(simulated.value.err)}\n${(simulated.value.logs ?? []).join('\n')}`);

  // An owner's position is its recipient account *plus* the vault holding its slice. Measuring the
  // recipient alone reports a payout as a gain whenever the account did not exist before.
  const before = await Promise.all(ordered.map(async intent => {
    const accounts = deriveFundAccounts(PROGRAM, config, prices, new PublicKey(intent.owner), BigInt(intent.nonce), mints);
    return Promise.all([0, 1, 2].map(async asset =>
      await balance(accounts.sources[asset]) + await balance(accounts.vaults[asset])));
  }));
  const signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed', maxRetries: 5 });
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) throw new Error(`the settlement failed on chain: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Reconcile the delivery against the proposal.
  //
  // The comparison is against what settlement *paid out*, not against the owner's wallet balance:
  // the mandate bounds apply to the slice's output, and an owner holds tokens outside the slice.
  // What must hold is that the change the proposal promised is the change that arrived.
  const assetOrder = ['CASH', 'STOCK_A', 'STOCK_B'] as const;
  const reconciled = [];
  // The gap between what the engine modelled for the external leg and what the venue actually paid.
  const modelledVersusRealized: { owner: string; asset: string; modelled_change_raw: string;
    realized_change_raw: string; difference_raw: string }[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const row = rows.find(entry => entry.id === `slice-${index}`) as unknown as { initial_raw: Record<string, number>; final_raw: Record<string, number> };
    const accounts = deriveFundAccounts(PROGRAM, config, prices, new PublicKey(ordered[index].owner), BigInt(ordered[index].nonce), mints);
    // After settlement every vault is empty, so the position is the recipient balance alone.
    const realized = { CASH: await balance(accounts.sources[0]), STOCK_A: await balance(accounts.sources[1]), STOCK_B: await balance(accounts.sources[2]) };
    const delta = before[index];
    const delivered: Record<string, string> = {};
    const promised: Record<string, string> = {};
    let matches = true;
    for (let asset = 0; asset < assetOrder.length; asset++) {
      const key = assetOrder[asset];
      const gain = realized[key] - BigInt(delta[asset]);
      const intended = BigInt(row.final_raw[key]) - BigInt(row.initial_raw[key]);
      delivered[key] = gain.toString();
      promised[key] = intended.toString();
      // Every asset the route did not touch must move exactly as the proposal said. The asset the
      // venue paid out is different: there the engine's number is a *model* of the external cost and
      // the chain's is the measured fact, so the two are allowed to differ — and the difference is
      // recorded rather than smoothed away. The owner's realized outcome is still checked against the
      // bounds it signed, which is the guarantee the program actually enforces.
      const routedOutput = compiled.residuals.some(residual =>
        assetOrder.indexOf(residual.direction === '0' ? 'CASH' : 'STOCK_A') === asset);
      if (gain !== intended && !routedOutput) matches = false;
      if (gain !== intended && routedOutput) {
        const bounds = (portfolioAccounts[index].final_bounds_raw as Record<string, { min: number; max: number }>)[key];
        const realized = BigInt(row.initial_raw[key]) + gain;
        if (realized < BigInt(bounds.min) || realized > BigInt(bounds.max)) matches = false;
        modelledVersusRealized.push({ owner: ordered[index].owner, asset: key,
          modelled_change_raw: intended.toString(), realized_change_raw: gain.toString(),
          difference_raw: (gain - intended).toString() });
      }
    }
    reconciled.push({ owner: ordered[index].owner, proposed_change_raw: promised,
      delivered_change_raw: delivered, matches_proposal: matches,
      signed_bounds: portfolioAccounts[index].final_bounds_raw });
  }
  if (reconciled.some(entry => !entry.matches_proposal)) {
    throw new Error(`the settlement did not deliver the change the proposal promised: ${JSON.stringify(reconciled.map(entry => ({
      owner: entry.owner.slice(0, 8), promised: entry.proposed_change_raw, delivered: entry.delivered_change_raw })))}`);
  }

  return { label, preflight_note: explanationNote, modelled_versus_realized: modelledVersusRealized,
    portfolio_sha256: String(planned.body.portfolio_sha256 ?? ''), assumptions: planned.body.assumptions,
    proposal: { method: 'C', status: String(chosen.status), totals: chosen.totals,
      per_account: rows.map(row => ({ id: row.id, internal_raw: (row as never as { internal_raw: unknown }).internal_raw,
        external_raw: (row as never as { external_raw: unknown }).external_raw,
        recurring_micro_usd: (row as never as { recurring_micro_usd: unknown }).recurring_micro_usd })) },
    compiled: { crosses: compiled.crosses, residuals: compiled.residuals, explanation: compiled.explanation },
    settlement: { signature, compute_units: simulated.value.unitsConsumed, serialized_bytes: transaction.serialize().length,
      routed: routed, lookup_table_entries: lookupAddresses.length },
    reconciled };
}

// ---------------------------------------------------------------------------------------------
// Cycle one: the two slices genuinely want opposite sides, so the proposal is a matched cross.
// ---------------------------------------------------------------------------------------------
const fundedSignatures = await fundSlices();
const funded = await fundedIntentOwners();
// Identify the slices by what they hold, not by sort position: the owner-byte order the settlement
// uses is unrelated to the order the fixture funded them in.
const byHolding = [...funded].sort((a, b) => Number(BigInt(b.assets[1].funding) - BigInt(a.assets[1].funding)));
const seller = byHolding[0].owner; // the slice that funded stock, so it can sell
// The buyer is whichever other slice signed a bound that permits taking the stock it will receive.
const candidates = funded.filter(entry => entry.owner !== seller)
  .sort((a, b) => Number(BigInt(b.assets[1].maxOutput) - BigInt(a.assets[1].maxOutput)));
const buyer = candidates[0].owner;
const idle = funded.find(entry => entry.owner !== seller && entry.owner !== buyer)!.owner;
if (BigInt(candidates[0].assets[1].maxOutput) < 2_000_000n) {
  throw new Error('no slice signed a bound that permits taking two million stock');
}

const first = await runCycle('Cycle 1 — the two sides match exactly', {
  stock1: { [seller]: 3_000_000, [buyer]: 1_000_000, [idle]: 0 },
});

// The second cycle needs a fresh set of funded slices, because settlement consumed the first.
// Recovery is exercised here rather than assumed: withdraw and close, then fund again.
for (const owner of owners) {
  for (let nonce = 0n; nonce < 4n; nonce++) {
    const accounts = deriveFundAccounts(PROGRAM, config, prices, owner.publicKey, nonce, mints);
    if (!(await connection.getAccountInfo(accounts.intent, 'confirmed'))) continue;
    const statusInfo = await connection.getAccountInfo(accounts.intent, 'confirmed');
    if ((statusInfo!.data as Buffer)[520] === 0) {
      await send(new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
        { pubkey: accounts.intent, isSigner: false, isWritable: true },
      ], data: disc('cancel_intent') })), [owner]);
    }
    for (let asset = 0; asset < 3; asset++) {
      if (await balance(accounts.vaults[asset]) === 0n) continue;
      await send(new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
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
      ], data: Buffer.concat([disc('withdraw_asset'), Buffer.from([asset])]) })), [owner]);
    }
    await send(new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys: [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: accounts.owner_state, isSigner: false, isWritable: true },
      { pubkey: accounts.intent, isSigner: false, isWritable: true },
      ...accounts.mints.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
      ...accounts.vaults.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ], data: disc('close_intent') })), [owner]);
  }
}

// Re-fund with the next nonce, so the second cycle is a genuine repeat use of the same wallets. The
// slices are derived from what each owner actually holds now, because the first settlement
// redistributed the stock and the cash.
await publishPrices();
const holdings = await Promise.all(owners.map(owner => Promise.all([0, 1, 2].map(mint =>
  balance(canonicalAta(owner.publicKey, mints[mint]))))));
// Two million fifty thousand sells, two million crosses: a fifty-thousand residual, which is one per
// cent of the seeded pool and therefore inside the committed two-hundred basis point band.
const CYCLE_TWO_SELL = 2_050_000n;
const sliceFor: Record<number, { cash: { funding: bigint; min: bigint; max: bigint };
  stock1: { funding: bigint; min: bigint; max: bigint } }> = {};
for (let index = 0; index < owners.length; index++) {
  const owner = owners[index].publicKey.toBase58();
  const [cash, stock1] = holdings[index];
  if (owner === seller) {
    // The operator tightens this owner to a single outcome: it must end holding exactly this much.
    // That is the constraint that forces the sale, and because the buyer cannot absorb all of it the
    // proposal has to route the remainder externally. The amount is chosen so the residual is small
    // relative to the test pool, which is what keeps it inside the committed execution band.
    const mustEnd = stock1 > CYCLE_TWO_SELL ? stock1 - CYCLE_TWO_SELL : 0n;
    sliceFor[index] = { cash: { funding: 0n, min: 0n, max: cash + 50_000_000n },
      stock1: { funding: stock1, min: mustEnd, max: mustEnd } };
  } else if (owner === buyer) {
    sliceFor[index] = { cash: { funding: cash, min: 0n, max: cash },
      stock1: { funding: 0n, min: 0n, max: 2_000_000n } };
  } else {
    // The third owner funds what it holds and intends to keep it: it participates in the batch
    // without trading, which is the honest way to show that a non-trader is still protected.
    sliceFor[index] = { cash: { funding: cash, min: 0n, max: cash }, stock1: { funding: 0n, min: 0n, max: 0n } };
  }
}

const refundSignatures: string[] = [];
for (let index = 0; index < owners.length; index++) {
  const owner = owners[index];
  const stateInfo = await connection.getAccountInfo(PublicKey.findProgramAddressSync(
    [Buffer.from('owner'), config.toBuffer(), owner.publicKey.toBuffer()], PROGRAM)[0], 'confirmed');
  const nonce = stateInfo ? readU64(stateInfo.data as Buffer, 72) : 0n;
  const spec = sliceFor[index];
  const accounts = deriveFundAccounts(PROGRAM, config, prices, owner.publicKey, nonce, mints);
  refundSignatures.push(await send(fundingTransaction(buildCreateAndFundInstruction(PROGRAM, owner.publicKey, accounts, {
    expected_policy_hash: manifest.initial_policy_hash, nonce: nonce.toString(), expiry_unix_seconds: (now + 890n).toString(),
    optimization_commitment: createHash('sha256').update(`optimizer-demo-b-${index}`).digest('hex'),
    assets: [{ funding: spec.cash.funding.toString(), min_output: spec.cash.min.toString(), max_output: spec.cash.max.toString(), funding_reference_price: REFERENCE[0].toString() },
      { funding: spec.stock1.funding.toString(), min_output: spec.stock1.min.toString(), max_output: spec.stock1.max.toString(), funding_reference_price: REFERENCE[1].toString() },
      { funding: '0', min_output: '0', max_output: '0', funding_reference_price: REFERENCE[2].toString() }],
  })), [owner]));
}

// Cycle two: the seller now wants to give up more than the buyer wants, so the proposal must cross
// what matches and route the remainder externally. The settlement shape changes with the target.
const sellerIndex = owners.findIndex(owner => owner.publicKey.toBase58() === seller);
const sellerStock = holdings[sellerIndex][1];
const second = await runCycle('Cycle 2 — one owner tightened, so the remainder must route', {
  stock1: { [seller]: Number(sellerStock - CYCLE_TWO_SELL), [buyer]: 2_000_000, [idle]: 0 },
});

const record = {
  status: 'PASS', task: 'T33',
  scope: 'OPTIMIZER-DRIVEN EXECUTION ON A LOCAL VALIDATOR; synthetic test assets and TEST PRICES',
  cluster: 'localnet', genesis, program_id: PROGRAM.toBase58(), config: config.toBase58(),
  service_url: serviceUrl, owners: { seller, buyer, idle },
  fixture: { funded_signatures: fundedSignatures, refund_signatures: refundSignatures, slices: SLICES },
  cycles: [first, second],
  demonstration: {
    claim: 'the settlement is derived from the optimizer proposal, not invented',
    first_crosses: first.compiled.crosses.length, first_residuals: first.compiled.residuals.length,
    second_crosses: second.compiled.crosses.length, second_residuals: second.compiled.residuals.length,
    target_changed_the_settlement: JSON.stringify(first.compiled) !== JSON.stringify(second.compiled),
    proposal_changed_with_the_target: JSON.stringify(first.proposal) !== JSON.stringify(second.proposal),
  },
  limitations: [
    'Local validator, synthetic test assets and a labelled fixture oracle; no devnet and no market.',
    'The cost model and market convention come from the frozen template, not from the caller; the assumptions list records which defaults were applied.',
    'The residual leg executes against the controlled synthetic venue, not a real one.',
  ],
  hashes: {
    manifest: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    binary: createHash('sha256').update(readFileSync('target/deploy/crossflow.so')).digest('hex'),
    service_source: createHash('sha256').update(readFileSync('services/api/src/server.ts')).digest('hex'),
  },
};
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ status: 'PASS', first: { crosses: first.compiled.crosses.length, residuals: first.compiled.residuals.length },
  second: { crosses: second.compiled.crosses.length, residuals: second.compiled.residuals.length },
  changed: record.demonstration.target_changed_the_settlement }, null, 2));
