import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { validateWriteDestination } from './network-guard.mjs';
import { DEVNET_GENESIS } from './deployment-manifest.js';

/**
 * Create the devnet test assets before the deployment identity is written, so the committed
 * policy names the real devnet mints rather than placeholders.
 *
 * Every mint is created with the approved wallet as authority, funded, and then made immutable
 * (mint and freeze authority revoked). These are labelled test assets, not issuer-backed shares.
 */
const RPC = process.env.CROSSFLOW_RPC_URL ?? 'https://api.devnet.solana.com';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const RENT_SYSVAR = new PublicKey('SysvarRent111111111111111111111111111111111');
const DECIMALS = 6;
const CASH_SUPPLY = 100_000_000n;
const STOCK_SUPPLY = 10_000_000n;
const OWNER_FUNDING_LAMPORTS = 400_000_000;
const args = process.argv.slice(2);
if (args.length !== 1) throw new Error('usage: tsx scripts/devnet-assets.ts <env.json>');
const envPath = args[0];

validateWriteDestination(RPC, DEVNET_GENESIS, 'devnet');
const connection = new Connection(RPC, 'confirmed');
const genesis = await connection.getGenesisHash();
if (genesis !== DEVNET_GENESIS) throw new Error(`GENESIS_MISMATCH: ${genesis}`);
const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));

const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const send = async (transaction: Transaction, signers: Keypair[], label: string) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const signature = await connection.sendTransaction(transaction, signers, { preflightCommitment: 'confirmed', maxRetries: 3 });
      const latest = await connection.getLatestBlockhash('confirmed');
      const result = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
      if (result.value.err) throw new Error(`${label} failed on chain: ${JSON.stringify(result.value.err)}`);
      return signature;
    } catch (error) {
      if (attempt === 3) throw new Error(`${label}: ${String(error)}`);
      await sleep(1_500);
    }
  }
  throw new Error(`${label}: unreachable`);
};

const env = existsSync(envPath) ? JSON.parse(readFileSync(envPath, 'utf8')) : { owners: [], mints: [] };
const extraOwners: Keypair[] = (env.owners ?? []).map((secret: number[]) => Keypair.fromSecretKey(Uint8Array.from(secret)));
while (extraOwners.length < 2) extraOwners.push(Keypair.generate());
const owners = [operator, ...extraOwners];

for (const owner of extraOwners) {
  const balance = await connection.getBalance(owner.publicKey, 'confirmed');
  if (balance < OWNER_FUNDING_LAMPORTS / 2) {
    await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: owner.publicKey,
      lamports: OWNER_FUNDING_LAMPORTS - balance })), [operator], 'fund devnet owner');
  }
}

let mintKeys: Keypair[] = (env.mints ?? []).map((entry: number[]) => Keypair.fromSecretKey(Uint8Array.from(entry)));
if (mintKeys.length !== 3) {
  for (let attempt = 0; attempt < 20000; attempt++) {
    const candidate = Array.from({ length: 3 }, () => Keypair.generate());
    if (candidate.every((entry, i) => i === 0 || Buffer.compare(candidate[i - 1].publicKey.toBuffer(), entry.publicKey.toBuffer()) < 0)) {
      mintKeys = candidate;
      break;
    }
  }
  if (mintKeys.length !== 3) throw new Error('could not draw a sorted devnet mint set');
  for (const mint of mintKeys) {
    await send(new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: operator.publicKey, newAccountPubkey: mint.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(82), space: 82, programId: TOKEN_PROGRAM }),
      new TransactionInstruction({ programId: TOKEN_PROGRAM,
        data: Buffer.concat([Buffer.from([20, DECIMALS]), operator.publicKey.toBuffer(), Buffer.from([1]), operator.publicKey.toBuffer()]),
        keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true },
               { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false }] })), [operator, mint], 'create devnet mint');
  }
}
const mints = mintKeys.map(entry => entry.publicKey);
for (const mint of mints) {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info || info.data.length !== 82 || info.data[44] !== DECIMALS) throw new Error(`devnet mint ${mint.toBase58()} is missing or has the wrong shape`);
}

const atas: PublicKey[][] = [];
for (const owner of owners) {
  const row: PublicKey[] = [];
  for (const mint of mints) {
    const ata = PublicKey.findProgramAddressSync([owner.publicKey.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
    if (!(await connection.getAccountInfo(ata, 'confirmed'))) {
      await send(new Transaction().add(new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [
        { pubkey: operator.publicKey, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ] })), [operator], 'create devnet ata');
    }
    row.push(ata);
  }
  atas.push(row);
}

const mintTo = (mint: PublicKey, destination: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: TOKEN_PROGRAM, data: Buffer.concat([Buffer.from([7]), u64(amount)]), keys: [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: operator.publicKey, isSigner: true, isWritable: false },
  ] });
const revoke = (mint: PublicKey, authorityType: number) => new TransactionInstruction({
  programId: TOKEN_PROGRAM, data: Buffer.from([6, authorityType, 0]), keys: [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: operator.publicKey, isSigner: true, isWritable: false },
  ] });
const amountAt = async (key: PublicKey) => {
  const info = await connection.getAccountInfo(key, 'confirmed');
  return info && info.owner.equals(TOKEN_PROGRAM) && info.data.length === 165 ? info.data.readBigUInt64LE(64) : 0n;
};
// Idempotent: supply can only be minted while the authority is still present, and revoking it
// is permanent, so a repeat run verifies instead of failing on a fixed-supply mint.
const firstMint = await connection.getAccountInfo(mints[0], 'confirmed');
if (!firstMint) throw new Error('devnet mint disappeared');
if (firstMint.data.readUInt32LE(0) !== 0) {
  await send(new Transaction().add(
    ...atas.flatMap(row => [mintTo(mints[0], row[0], CASH_SUPPLY), mintTo(mints[1], row[1], STOCK_SUPPLY), mintTo(mints[2], row[2], STOCK_SUPPLY)]),
  ), [operator], 'mint devnet test supply');
  await send(new Transaction().add(...mints.flatMap(mint => [revoke(mint, 0), revoke(mint, 1)])), [operator], 'revoke devnet mint authorities');
} else {
  const held = await Promise.all(atas.map(async row => [await amountAt(row[0]), await amountAt(row[1])]));
  // The probe's slices need 80m cash and 4m stock across the three owners in total.
  const cashTotal = held.reduce((sum, row) => sum + row[0], 0n);
  const stockTotal = held.reduce((sum, row) => sum + row[1], 0n);
  if (cashTotal < 80_000_000n || stockTotal < 5_000_000n) {
    throw new Error(`immutable devnet test assets are under-funded (cash ${cashTotal}, stock1 ${stockTotal}); create a fresh asset set`);
  }
}
for (const mint of mints) {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info || info.data.readUInt32LE(0) !== 0 || info.data.readUInt32LE(46) !== 0) throw new Error(`devnet mint ${mint.toBase58()} is not immutable`);
}

const record = {
  cluster: 'devnet', genesis,
  owners: extraOwners.map(owner => [...owner.secretKey]),
  owner_public_keys: owners.map(owner => owner.publicKey.toBase58()),
  mints: mintKeys.map(entry => [...entry.secretKey]),
  mint_public_keys: mints.map(mint => mint.toBase58()),
  atas: atas.map(row => row.map(key => key.toBase58())),
  label: 'DEVNET TEST ASSETS; immutable legacy SPL mints; not issuer-backed shares',
};
writeFileSync(envPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status: 'OK', genesis, operator: operator.publicKey.toBase58(),
  owners: record.owner_public_keys, mints: record.mint_public_keys, env: envPath }, null, 2));
