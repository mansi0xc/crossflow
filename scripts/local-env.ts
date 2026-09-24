import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM = SystemProgram.programId;
const RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
const DECIMALS = 6;
const SUPPLY = { cash: 500_000_000n, stock: 10_000_000n };

const args = process.argv.slice(2);
if (args.length !== 3) throw new Error('usage: tsx scripts/local-env.ts <local-rpc> <wallet.json> <out.json>');
const [rpc, walletPath, outPath] = args;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('local validator RPC only');
if (existsSync(outPath)) throw new Error('refusing to overwrite an existing local environment record');

const conn = new Connection(rpc, 'confirmed');
const genesis = await conn.getGenesisHash();
if (genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('devnet genesis: local validator required');

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))));
const balance = BigInt(await conn.getBalance(wallet.publicKey, 'confirmed'));
if (balance < 5_000_000_000n) throw new Error('fund the harness wallet with local airdrop before setup');

const u64 = (value: bigint) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(value); return buffer; };
const send = async (instructions: TransactionInstruction[], signers: Keypair[]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...instructions), signers, { commitment: 'confirmed' });

const rentMint = await conn.getMinimumBalanceForRentExemption(82);

async function createMint(mint: Keypair): Promise<void> {
  await send([
    SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey, lamports: rentMint, space: 82, programId: TOKEN }),
    // InitializeMint2: [opcode, decimals, mint_authority, freeze_authority_option=1, freeze_authority]
    new TransactionInstruction({ programId: TOKEN, data: Buffer.concat([Buffer.from([20, DECIMALS]), wallet.publicKey.toBuffer(), Buffer.from([1]), wallet.publicKey.toBuffer()]),
      keys: [
        { pubkey: mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: RENT, isSigner: false, isWritable: false },
      ] }),
  ], [wallet, mint]);
}

const ataFor = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];

async function createAta(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
  const ata = ataFor(owner, mint);
  await send([new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
    { pubkey: TOKEN, isSigner: false, isWritable: false },
  ] })], [wallet]);
  return ata;
}

const mintTo = (mint: PublicKey, destination: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: TOKEN, data: Buffer.concat([Buffer.from([7]), u64(amount)]), keys: [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
  ] });

// authority_type 0 = MintTokens, 1 = FreezeAccount; option 0 disables the authority.
const revoke = (mint: PublicKey, authorityType: number) => new TransactionInstruction({
  programId: TOKEN, data: Buffer.from([6, authorityType, 0]), keys: [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
  ] });

const ascending = (keys: PublicKey[]) => keys.every((key, i) => i === 0 || Buffer.compare(keys[i - 1].toBuffer(), key.toBuffer()) < 0);

function drawSortedKeys(count: number): Keypair[] {
  for (let attempt = 0; attempt < 20000; attempt++) {
    const candidate = Array.from({ length: count }, () => Keypair.generate());
    if (ascending(candidate.map(entry => entry.publicKey))) return candidate;
  }
  throw new Error('could not draw an ascending mint set');
}

// Cash mint first, then the two stocks, all in ascending raw-byte order.
const sortedKeys = drawSortedKeys(3);
for (const key of sortedKeys) await createMint(key);
const [cashKey, stock1Key, stock2Key] = sortedKeys;
const mints = sortedKeys.map(entry => entry.publicKey);
if (!ascending(mints)) throw new Error('funded mints are not in ascending order');

// A replacement cash mint strictly below the first stock, for the zero-claims policy rotation.
let replacementKey: Keypair | null = null;
for (let attempt = 0; attempt < 20000; attempt++) {
  const candidate = Keypair.generate();
  if (Buffer.compare(candidate.publicKey.toBuffer(), stock1Key.publicKey.toBuffer()) < 0 &&
      !mints.some(mint => mint.equals(candidate.publicKey))) { replacementKey = candidate; break; }
}
if (!replacementKey) throw new Error('could not draw a replacement cash mint below the first stock');
await createMint(replacementKey);

const atas = [await createAta(wallet.publicKey, cashKey.publicKey), await createAta(wallet.publicKey, stock1Key.publicKey), await createAta(wallet.publicKey, stock2Key.publicKey)];
await send([
  mintTo(cashKey.publicKey, atas[0], SUPPLY.cash),
  mintTo(stock1Key.publicKey, atas[1], SUPPLY.stock),
  mintTo(stock2Key.publicKey, atas[2], SUPPLY.stock),
  revoke(cashKey.publicKey, 0), revoke(cashKey.publicKey, 1),
  revoke(stock1Key.publicKey, 0), revoke(stock1Key.publicKey, 1),
  revoke(stock2Key.publicKey, 0), revoke(stock2Key.publicKey, 1),
  revoke(replacementKey.publicKey, 0), revoke(replacementKey.publicKey, 1),
], [wallet]);

for (const mint of [...mints, replacementKey.publicKey]) {
  const info = await conn.getAccountInfo(mint, 'confirmed');
  if (!info || !info.owner.equals(TOKEN) || info.data.length !== 82 || info.data.readUInt32LE(0) !== 0 ||
      info.data.readUInt32LE(46) !== 0 || info.data[44] !== DECIMALS || info.data[45] !== 1) {
    throw new Error(`mint ${mint.toBase58()} is not an immutable legacy SPL mint`);
  }
}

const record = {
  genesis, wallet: wallet.publicKey.toBase58(),
  mints: { cash: cashKey.publicKey.toBase58(), stock1: stock1Key.publicKey.toBase58(),
    stock2: stock2Key.publicKey.toBase58(), replacement_cash: replacementKey.publicKey.toBase58() },
  atas: { cash: atas[0].toBase58(), stock1: atas[1].toBase58(), stock2: atas[2].toBase58() },
  supply: { cash: SUPPLY.cash.toString(), stock: SUPPLY.stock.toString() },
  label: 'LOCAL SYNTHETIC ENVIRONMENT',
  nonce: randomBytes(4).toString('hex'),
};
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
