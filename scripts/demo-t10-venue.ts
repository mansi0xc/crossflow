import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { ControlledVenue, deriveControlledPool, venueTransaction } from '../packages/adapters/src/controlled.js';
import { canonicalAta } from '../packages/adapters/src/types.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const VENUE_PROGRAM = new PublicKey('Bq1FxNWHnmnZgJRi6fsRKrvLTbBf6uDTXjaawzdnkw1Q');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const FEE_BPS = 30;
const SEED = { cash: 50_000_000n, stock1: 5_000_000n };
const args = process.argv.slice(2);
if (args.length !== 3) throw new Error('usage: tsx scripts/demo-t10-venue.ts <local-rpc> <env.json> <out.json>');
const [rpc, envPath, outPath] = args;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('local validator RPC only');
const connection = new Connection(rpc, 'confirmed');
const env = JSON.parse(readFileSync(envPath, 'utf8'));
const genesis = await connection.getGenesisHash();
if (env.genesis !== genesis) throw new Error('local environment does not match this validator genesis');
const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.owner_paths[0], 'utf8'))));
if (operator.publicKey.toBase58() !== env.owners[0]) throw new Error('operator keypair does not match the environment record');
const mints: PublicKey[] = ['cash', 'stock1', 'stock2'].map(name => new PublicKey(env.mints[name]));
const readU64 = (data: Buffer, offset: number) => { let value = 0n; for (let i = 0; i < 8; i++) value |= BigInt(data[offset + i]) << BigInt(8 * i); return value; };
const pool = deriveControlledPool(VENUE_PROGRAM, mints);
const venue = new ControlledVenue({ programId: VENUE_PROGRAM, pool, poolAuthority: operator.publicKey, mints, feeBps: FEE_BPS, label: 'CONTROLLED SYNTHETIC VENUE; test liquidity only' });
const vaults = venue.vaults();
const send = async (ix: TransactionInstruction, signers: Keypair[], withBudget = false) =>
  sendAndConfirmTransaction(connection, withBudget ? venueTransaction(ix) : new Transaction().add(ix), signers, { commitment: 'confirmed' });
const balance = async (key: PublicKey) => {
  const info = await connection.getAccountInfo(key, 'confirmed');
  if (!info) return 0n;
  if (!info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 165) throw new Error(`unexpected token account ${key.toBase58()}`);
  let amount = 0n; for (let i = 0; i < 8; i++) amount |= BigInt(info.data[64 + i]) << BigInt(8 * i);
  return amount;
};
const reserves = async () => Promise.all(vaults.map(vault => balance(vault)));
const negativeResults: { label: string; expected: string; log: string }[] = [];
const expectReject = async (label: string, ix: TransactionInstruction, expected: RegExp) => {
  const tx = venueTransaction(ix).add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(randomBytes(6).toString('hex')) }));
  tx.feePayer = operator.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(operator);
  const result = await connection.simulateTransaction(tx);
  const log = (result.value.logs ?? []).join('\n');
  if (!result.value.err || !log.includes(`Program ${VENUE_PROGRAM.toBase58()} invoke [1]`) ||
      !log.includes(`Program ${VENUE_PROGRAM.toBase58()} failed:`) || !expected.test(log)) {
    throw new Error(`${label}: expected ${expected}; got err=${JSON.stringify(result.value.err)}\n${log}`);
  }
  negativeResults.push({ label, expected: String(expected), log });
};

// 1. One-time pool creation under the operator, then synthetic test liquidity.
let initializeSignature: string | null = null;
if (!(await connection.getAccountInfo(pool, 'confirmed'))) initializeSignature = await send(venue.buildInitializePool(), [operator]);
const createVault = (mint: PublicKey) => new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [
  { pubkey: operator.publicKey, isSigner: true, isWritable: true },
  { pubkey: canonicalAta(pool, mint), isSigner: false, isWritable: true },
  { pubkey: pool, isSigner: false, isWritable: false },
  { pubkey: mint, isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
] });
const transfer = (mint: PublicKey, from: PublicKey, to: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: TOKEN_PROGRAM, data: Buffer.concat([Buffer.from([12]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(amount); return b; })(), Buffer.from([6])]),
  keys: [
    { pubkey: from, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: to, isSigner: false, isWritable: true },
    { pubkey: operator.publicKey, isSigner: true, isWritable: false },
  ] });
const seedSignatures: string[] = [];
for (const index of [0, 1, 2]) {
  const vault = vaults[index];
  if (!(await connection.getAccountInfo(vault, 'confirmed'))) seedSignatures.push(await send(createVault(mints[index]), [operator]));
}
for (const [index, amount] of [[0, SEED.cash], [1, SEED.stock1]] as [number, bigint][]) {
  if (await balance(vaults[index]) < amount) seedSignatures.push(await send(transfer(mints[index], canonicalAta(operator.publicKey, mints[index]), vaults[index], amount), [operator]));
}
const reservesBefore = await reserves();
if (reservesBefore[0] <= 0n || reservesBefore[1] <= 0n) throw new Error('seeded reserves are empty');

// 2. One real exact-in residual leg with measured deltas.
const amountIn = 1_000_000n;
const quoted = venue.quoteFromReserves(reservesBefore, 1, 0, amountIn);
const minOut = (quoted * 995n) / 1000n;
const source = canonicalAta(operator.publicKey, mints[1]);
const destination = canonicalAta(operator.publicKey, mints[0]);
const sourceBefore = await balance(source);
const destinationBefore = await balance(destination);
const swap = venue.buildSwap(1, 0, amountIn, minOut);
const probe = venueTransaction(swap).add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(randomBytes(6).toString('hex')) }));
probe.feePayer = operator.publicKey;
probe.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
probe.sign(operator);
const simulation = await connection.simulateTransaction(probe);
if (simulation.value.err) throw new Error(`valid swap simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs ?? []).join('\n')}`);
const computeUnits = simulation.value.unitsConsumed ?? 0;
const swapSignature = await send(swap, [operator], true);
const measuredOut = await balance(destination) - destinationBefore;
if (await balance(source) !== sourceBefore - amountIn) throw new Error('venue input delta mismatch');
if (measuredOut !== quoted) throw new Error(`measured output ${measuredOut} differs from the quoted ${quoted}`);
const reservesAfter = await reserves();
if (reservesAfter[1] !== reservesBefore[1] + amountIn || reservesAfter[0] !== reservesBefore[0] - measuredOut) throw new Error('pool reserves did not follow the measured transfers');
const vaultCash = await balance(vaults[0]);
const vaultStock = await balance(vaults[1]);
if (vaultCash !== reservesAfter[0] || vaultStock !== reservesAfter[1]) throw new Error('recorded reserves disagree with the pool vaults');

// 3. Price impact: the same input quotes less against the moved reserve.
const requoted = venue.quoteFromReserves(reservesAfter, 1, 0, amountIn);
if (requoted >= quoted) throw new Error('a moved reserve did not change the quote');

await expectReject('empty-reserve-swap', venue.buildSwap(2, 0, 1_000n, 1n), /Error Code: Reserves/);
{
  const wrong = venue.buildSwap(1, 0, amountIn, minOut);
  const keys = wrong.keys.map(meta => ({ ...meta }));
  keys[6] = { ...keys[7] };
  await expectReject('substituted-pool-vault', new TransactionInstruction({ programId: VENUE_PROGRAM, data: wrong.data, keys }), /Error Code: (?:Vault|ConstraintDuplicateMutableAccount)/);
}
{
  const wrong = venue.buildSwap(1, 0, amountIn, minOut);
  const keys = wrong.keys.map(meta => ({ ...meta }));
  keys[5] = { pubkey: canonicalAta(new PublicKey(env.owners[1]), mints[0]), isSigner: false, isWritable: true };
  await expectReject('redirected-destination', new TransactionInstruction({ programId: VENUE_PROGRAM, data: wrong.data, keys }), /Error Code: Vault/);
}
await expectReject('min-out-above-the-quote', venue.buildSwap(1, 0, amountIn, quoted + 1n), /Error Code: MinOut/);
{
  const wrong = venue.buildSwap(1, 0, amountIn, minOut);
  const keys = wrong.keys.map(meta => ({ ...meta }));
  keys[2] = { ...keys[3] };
  await expectReject('relabelled-mint', new TransactionInstruction({ programId: VENUE_PROGRAM, data: wrong.data, keys }), /Error Code: Mints/);
}
// Encode these two directly: the client builder already refuses them, so only a raw
// instruction can prove the on-chain guard is what rejects.
const rawSwap = (inputIndex: number, outputIndex: number, amountInRaw: bigint, minOutRaw: bigint) => {
  const data = Buffer.alloc(26);
  swap.data.subarray(0, 8).copy(data, 0);
  data.writeUInt8(inputIndex, 8);
  data.writeUInt8(outputIndex, 9);
  data.writeBigUInt64LE(amountInRaw, 10);
  data.writeBigUInt64LE(minOutRaw, 18);
  return new TransactionInstruction({ programId: VENUE_PROGRAM, data, keys: swap.keys.map(meta => ({ ...meta })) });
};
await expectReject('same-direction', rawSwap(1, 1, amountIn, 1n), /Error Code: Direction/);
await expectReject('zero-amount', rawSwap(1, 0, 0n, 1n), /Error Code: Amount/);

const record = {
  status: 'PASS', task: 'T10', cluster: 'localnet', genesis,
  program_id: VENUE_PROGRAM.toBase58(), pool: pool.toBase58(), fee_bps: FEE_BPS,
  label: 'CONTROLLED SYNTHETIC VENUE; seeded with test tokens only; not an AMM or a real market',
  mints: mints.map(mint => mint.toBase58()), vaults: vaults.map(vault => vault.toBase58()),
  reserves_before: reservesBefore.map(value => value.toString()),
  reserves_after: reservesAfter.map(value => value.toString()),
  amount_in: amountIn.toString(), quoted_out: quoted.toString(), measured_out: measuredOut.toString(),
  requoted_after_move: requoted.toString(), min_out: minOut.toString(),
  compute_units: computeUnits, requested_compute_units: 200_000,
  mandatory_negative_cases: negativeResults.length, negativeResults,
  signatures: { initialize: initializeSignature, seed: seedSignatures, swap: swapSignature },
  hashes: {
    env: createHash('sha256').update(readFileSync(envPath)).digest('hex'),
    binary: createHash('sha256').update(readFileSync('target/deploy/test_venue.so')).digest('hex'),
    instruction: createHash('sha256').update(swap.data).digest('hex'),
  },
  limitations: [
    'Synthetic test-token liquidity on an isolated local validator; no market, no real price impact, no devnet claim.',
    'T10 proves the venue stays real execution; composing it with CrossFlow settlement is T16 and is not exercised here.',
    'Captured signatures are historical local evidence and require the running ledger for later RPC re-query.',
  ],
};
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
