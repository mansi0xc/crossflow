import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { assertPreparedDeploymentManifest } from './deployment-manifest.js';
import { buildRecoverClosedVaultInstruction } from '../packages/client/src/recover.js';

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const [rpc, manifestPath, walletPath, nonceText, mintText] = process.argv.slice(2);
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc ?? '') || !manifestPath || !walletPath ||
    !/^(0|[1-9][0-9]*)$/.test(nonceText ?? '') || !mintText) {
  throw new Error('usage: tsx scripts/demo-t08-closed-vault.ts <local-rpc> <manifest> <wallet> <closed-nonce> <legacy-mint>');
}
const conn = new Connection(rpc, 'confirmed');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const genesis = await conn.getGenesisHash();
await assertPreparedDeploymentManifest(manifest, genesis);
if (manifest.cluster !== 'localnet' || manifest.program_id !== PROGRAM.toBase58()) throw new Error('isolated local manifest required');
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))));
if (owner.publicKey.toBase58() !== manifest.expected_initializer) throw new Error('local wallet identity mismatch');
const nonce = BigInt(nonceText);
const mint = new PublicKey(mintText);
const config = new PublicKey(manifest.config_address);
const configInfo = await conn.getAccountInfo(config, 'confirmed');
if (!configInfo || !configInfo.owner.equals(PROGRAM) || configInfo.data.length !== 831) throw new Error('live config missing');
const livePolicy = configInfo.data.subarray(136, 788);
const policyVersion = livePolicy.readUInt32LE(104);
const currentMints = [0, 1, 2].map(i => new PublicKey(livePolicy.subarray(111 + i * 97, 143 + i * 97)));
const recover = buildRecoverClosedVaultInstruction(PROGRAM, owner.publicKey, config, nonce, mint);
const oldIntent = recover.keys[3].pubkey;
const vault = recover.keys[5].pubkey;
const recipient = recover.keys[6].pubkey;
const amount = 1000n;
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const amountAt = async (key: PublicKey) => {
  const account = await conn.getAccountInfo(key, 'confirmed');
  return account && account.owner.equals(TOKEN) && account.data.length === 165 ? account.data.readBigUInt64LE(64) : 0n;
};
const send = async (ix: TransactionInstruction) => sendAndConfirmTransaction(conn, new Transaction().add(ix), [owner], { commitment: 'confirmed' });
const negativeResults: { label: string; log: string }[] = [];
const reject = async (label: string, ix: TransactionInstruction, expected: RegExp, extra: Keypair[] = []) => {
  const tx = new Transaction().add(ix, new TransactionInstruction({ programId: MEMO, keys: [], data: randomBytes(8) }));
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(owner, ...extra);
  const result = await conn.simulateTransaction(tx);
  const log = (result.value.logs ?? []).join('\n');
  if (!result.value.err || !log.includes(`Program ${PROGRAM.toBase58()} invoke [1]`) ||
      !log.includes(`Program ${PROGRAM.toBase58()} failed:`) || !expected.test(log)) {
    throw new Error(`${label}: expected ${expected}; got ${JSON.stringify(result.value.err)}\n${log}`);
  }
  negativeResults.push({ label, log });
};
if (await conn.getAccountInfo(oldIntent, 'confirmed')) throw new Error('selected intent is not closed');
const stateInfo = await conn.getAccountInfo(recover.keys[2].pubkey, 'confirmed');
if (!stateInfo || !stateInfo.owner.equals(PROGRAM)) throw new Error('persistent owner state absent');
const nextNonce = stateInfo.data.readBigUInt64LE(72);
if (nonce >= nextNonce || stateInfo.data[80] !== 0) throw new Error('selected nonce is not prior and closed');
const mintInfo = await conn.getAccountInfo(mint, 'confirmed');
if (!mintInfo || !mintInfo.owner.equals(TOKEN) || mintInfo.data.length !== 82 || mintInfo.data[45] !== 1) throw new Error('legacy mint missing');
const decimals = mintInfo.data[44];
const sourceBefore = await amountAt(recipient);
if (sourceBefore < amount) throw new Error('local owner source ATA lacks donation units');
const createVault = new TransactionInstruction({ programId: ATA, keys: [
  { pubkey: owner.publicKey, isSigner: true, isWritable: true },
  { pubkey: vault, isSigner: false, isWritable: true },
  { pubkey: oldIntent, isSigner: false, isWritable: false },
  { pubkey: mint, isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  { pubkey: TOKEN, isSigner: false, isWritable: false },
], data: Buffer.from([1]) });
const createSignature = await send(createVault);
const vaultBefore = await amountAt(vault);
const donation = new TransactionInstruction({ programId: TOKEN, keys: [
  { pubkey: recipient, isSigner: false, isWritable: true },
  { pubkey: mint, isSigner: false, isWritable: false },
  { pubkey: vault, isSigner: false, isWritable: true },
  { pubkey: owner.publicKey, isSigner: true, isWritable: false },
], data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]) });
const donateSignature = await send(donation);
if (await amountAt(vault) !== vaultBefore + amount || await amountAt(recipient) !== sourceBefore - amount) throw new Error('donation did not land exactly');
const wrongNonce = buildRecoverClosedVaultInstruction(PROGRAM, owner.publicKey, config, nextNonce, mint);
await reject('current-nonce-rejected', wrongNonce, /Error Code: RecoveryAuthority/);
const attacker = Keypair.generate();
const attackerIx = new TransactionInstruction({ programId: PROGRAM, data: recover.data, keys: recover.keys.map((key, i) =>
  i === 0 ? { pubkey: attacker.publicKey, isSigner: true, isWritable: true } : key) });
await reject('non-owner-rejected', attackerIx, /Error Code: ConstraintSeeds/, [attacker]);
const wrongVault = new TransactionInstruction({ programId: PROGRAM, data: recover.data, keys: recover.keys.map((key, i) =>
  i === 5 ? { ...key, pubkey: recipient } : key) });
await reject('substituted-vault-rejected', wrongVault, /Error Code: TokenIdentity/);
const wrongRecipient = new TransactionInstruction({ programId: PROGRAM, data: recover.data, keys: recover.keys.map((key, i) =>
  i === 6 ? { ...key, pubkey: vault } : key) });
await reject('substituted-recipient-rejected', wrongRecipient, /Error Code: TokenIdentity/);
const wrongTokenProgram = new TransactionInstruction({ programId: PROGRAM, data: recover.data, keys: recover.keys.map((key, i) =>
  i === 7 ? { ...key, pubkey: SystemProgram.programId } : key) });
await reject('wrong-token-program-rejected', wrongTokenProgram, /Error Code: InvalidProgramId/);
const vaultInfoBefore = await conn.getAccountInfo(vault, 'confirmed');
if (!vaultInfoBefore) throw new Error('donation vault absent');
const recoverSignature = await send(recover);
if (await conn.getAccountInfo(vault, 'confirmed') || await amountAt(recipient) !== sourceBefore + vaultBefore ||
    (await conn.getAccountInfo(oldIntent, 'confirmed')) || (await conn.getAccountInfo(recover.keys[2].pubkey, 'confirmed'))?.data.readBigUInt64LE(72) !== nextNonce) {
  throw new Error('closed-vault recovery did not return all tokens/rent while preserving nonce');
}
await reject('empty-vault-replay-rejected', recover, /Error Code: TokenIdentity/);
console.log(JSON.stringify({ status: 'LOCAL_CLOSED_VAULT_PASS', cluster: 'localnet', genesis,
  program_id: PROGRAM.toBase58(), config: config.toBase58(), owner: owner.publicKey.toBase58(),
  old_intent: oldIntent.toBase58(), mint: mint.toBase58(), nonce: nonce.toString(), next_nonce: nextNonce.toString(),
  policy_version_at_recovery: policyVersion,
  configured_mint_at_recovery: currentMints.some(current => current.equals(mint)),
  donated_raw: amount.toString(), recovered_raw: (vaultBefore + amount).toString(), recovered_vault_rent_lamports: vaultInfoBefore.lamports,
  final_vault_closed: true, old_intent_remains_closed: true, owner_nonce_unchanged: true,
  signatures: { createVault: createSignature, donate: donateSignature, recover: recoverSignature }, negativeResults }, null, 2));
