import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { assertPreparedDeploymentManifest } from './deployment-manifest.js';
import { buildUpdatePolicyInstruction } from '../packages/client/src/config.js';
import { buildCancelIntentInstruction, buildCloseIntentInstruction, buildWithdrawAssetInstruction, deriveRecoveryAccounts } from '../packages/client/src/recover.js';

const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const [rpc, manifestPath, walletPath, newMintText] = process.argv.slice(2);
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc ?? '') || !manifestPath || !walletPath || !newMintText) {
  throw new Error('usage: tsx scripts/setup-t08-rotated-policy.ts <local-rpc> <manifest> <wallet> <new-cash-mint>');
}
const conn = new Connection(rpc, 'confirmed');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const genesis = await conn.getGenesisHash();
await assertPreparedDeploymentManifest(manifest, genesis);
if (manifest.cluster !== 'localnet' || manifest.program_id !== PROGRAM.toBase58()) throw new Error('local manifest required');
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))));
if (owner.publicKey.toBase58() !== manifest.expected_initializer || owner.publicKey.toBase58() !== manifest.expected_initial_admin) throw new Error('local authority mismatch');
const config = new PublicKey(manifest.config_address);
const prices = PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], PROGRAM)[0];
const oldMints: PublicKey[] = manifest.policy.assets.map((a: {mint:string}) => new PublicKey(Buffer.from(a.mint, 'hex')));
const newCash = new PublicKey(newMintText);
if (Buffer.compare(newCash.toBuffer(), oldMints[1].toBuffer()) >= 0 || oldMints.some(mint => mint.equals(newCash))) throw new Error('replacement cash mint would violate sorted unique policy');
const newMintInfo = await conn.getAccountInfo(newCash, 'confirmed');
if (!newMintInfo || newMintInfo.data.length !== 82 || newMintInfo.data[45] !== 1 || newMintInfo.data[44] !== 6 ||
    newMintInfo.data.readUInt32LE(0) !== 0 || newMintInfo.data.readUInt32LE(46) !== 0) throw new Error('new cash mint is not immutable legacy SPL');
const accounts = deriveRecoveryAccounts(PROGRAM, config, prices, owner.publicKey, 0n, oldMints);
const send = async (ix: ReturnType<typeof buildCancelIntentInstruction>) => sendAndConfirmTransaction(conn, new Transaction().add(ix), [owner], { commitment: 'confirmed' });
const balance = async (key: PublicKey) => {
  const info = await conn.getAccountInfo(key, 'confirmed');
  if (!info || info.data.length !== 165) throw new Error('token account missing');
  return info.data.readBigUInt64LE(64);
};
const before = await Promise.all(accounts.recipients.map(balance));
const vaultBefore = await Promise.all(accounts.vaults.map(balance));
const cancel = await send(buildCancelIntentInstruction(PROGRAM, owner.publicKey, accounts));
const withdrawals: string[] = [];
for (let i = 0; i < 3; i++) {
  withdrawals.push(await send(buildWithdrawAssetInstruction(PROGRAM, owner.publicKey, accounts, i)));
  if (await balance(accounts.vaults[i]) !== 0n || await balance(accounts.recipients[i]) !== before[i] + vaultBefore[i]) throw new Error(`asset ${i} not fully returned`);
}
const close = await send(buildCloseIntentInstruction(PROGRAM, owner.publicKey, accounts));
if (await conn.getAccountInfo(accounts.intent, 'confirmed') ||
    (await conn.getAccountInfo(accounts.owner_state, 'confirmed'))?.data.readBigUInt64LE(72) !== 1n) throw new Error('intent was not closed or nonce failed to persist');
const policy = Buffer.from(manifest.policy_bytes_hex, 'hex');
policy.writeUInt32LE(2, 104);
newCash.toBuffer().copy(policy, 111);
const nowSlot = await conn.getSlot('confirmed');
const now = await conn.getBlockTime(nowSlot);
if (now === null) throw new Error('local clock unavailable');
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const observation = (i: number) => {
  const mint = i === 0 ? newCash : oldMints[i];
  return Buffer.concat([mint.toBuffer(), Buffer.from(manifest.policy.assets[i].feed_id, 'hex'),
    u64([1_000_000n, 10_000_000n, 20_000_000n][i]), u64(0n), Buffer.from([0xfa, 0xff, 0xff, 0xff]),
    Buffer.from([0]), u64(BigInt(now)), u64(BigInt(now)), Buffer.from([0])]);
};
const observations = Buffer.concat([0, 1, 2].map(observation));
const rotation = await send(buildUpdatePolicyInstruction(PROGRAM, owner.publicKey, config, owner.publicKey,
  prices, 1, policy, observations));
const cfgAfter = await conn.getAccountInfo(config, 'confirmed');
const expectedHash = createHash('sha256').update(policy).digest();
if (!cfgAfter || !cfgAfter.data.subarray(104, 136).equals(expectedHash) ||
    !cfgAfter.data.subarray(136, 788).equals(policy) ||
    cfgAfter.data.readBigUInt64LE(822) !== 0n ||
    (await conn.getAccountInfo(prices, 'confirmed'))?.data.readBigUInt64LE(105) !== 1n) {
  throw new Error('zero-claim policy rotation failed');
}
console.log(JSON.stringify({ status: 'LOCAL_POLICY_REMOVAL_SETUP_PASS', cluster: 'localnet', genesis,
  config: config.toBase58(), old_mint: oldMints[0].toBase58(), replacement_mint: newCash.toBase58(),
  policy_version: 2, old_mint_removed: !policy.subarray(111, 143).equals(oldMints[0].toBuffer()),
  old_intent_closed: true, next_nonce: '1', outstanding_claim_intents: '0',
  signatures: { cancel, withdrawals, close, rotation } }, null, 2));
