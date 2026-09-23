import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AccountMeta, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { assertPreparedDeploymentManifest } from './deployment-manifest.js';
import { buildCreateAndFundInstruction, deriveFundAccounts, fundingTransaction } from '../packages/client/src/fund.js';
import { mandateBytes } from '../packages/contracts/src/index.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const args = process.argv.slice(2);
if (args.length !== 3) throw new Error('usage: tsx scripts/demo-local.ts <http://127.0.0.1:8899> <manifest.json> <local-keypair.json>');
const [rpc, manifestPath, keypairPath] = args;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('local validator RPC only');
const connection = new Connection(rpc, 'confirmed');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const genesis = await connection.getGenesisHash();
await assertPreparedDeploymentManifest(manifest, genesis);
if (manifest.cluster !== 'localnet' || manifest.program_id !== PROGRAM.toBase58()) throw new Error('local CrossFlow manifest required');
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))));
if (signer.publicKey.toBase58() !== manifest.expected_initializer || manifest.fixture_publisher !== signer.publicKey.toBase58()) throw new Error('local signer and manifest authority differ');
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(manifest.deployment_id, 'hex')], PROGRAM);
const [prices] = PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], PROGRAM);
const mints: PublicKey[] = manifest.policy.assets.map((a: { mint: string }) => new PublicKey(Buffer.from(a.mint, 'hex')));
const feeds: Buffer[] = manifest.policy.assets.map((a: { feed_id: string }) => Buffer.from(a.feed_id, 'hex'));
const fundAccounts = deriveFundAccounts(PROGRAM, config, prices, signer.publicKey, 0n, mints);
const sourceAccounts = fundAccounts.sources;
const now = BigInt(Math.floor(Date.now() / 1000));
const observation = (i: number, timestamp: bigint) => Buffer.concat([
  mints[i].toBuffer(), feeds[i], u64([1_000_000n, 10_000_000n, 20_000_000n][i]), u64(0n),
  i32(-6), Buffer.from([0]), u64(timestamp), u64(timestamp), Buffer.from([0]),
]);
const observations = Buffer.concat([0, 1, 2].map(i => observation(i, now)));
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const send = async (ix: TransactionInstruction, extraSigners: Keypair[] = [], funding = false) => sendAndConfirmTransaction(connection, funding ? fundingTransaction(ix) : new Transaction().add(ix), [signer, ...extraSigners], { commitment: 'confirmed' });
const negativeResults: { label: string; expected: string; log: string }[] = [];
const simulateExpectedReject = async (label: string, ix: TransactionInstruction, expected: RegExp, extraSigners: Keypair[] = [], funding = false) => {
  const tx = funding ? fundingTransaction(ix) : new Transaction().add(ix);
  // Salt simulations so repeated instruction bytes do not collide with a prior simulated transaction signature.
  tx.add(new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: randomBytes(8) }));
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(signer, ...extraSigners);
  const result = await connection.simulateTransaction(tx);
  const logs = result.value.logs ?? [];
  const programInvoked = logs.some(line => line === `Program ${PROGRAM.toBase58()} invoke [1]`);
  const programFailed = logs.some(line => line.startsWith(`Program ${PROGRAM.toBase58()} failed:`));
  const logText = logs.join('\n');
  if (!result.value.err || !programInvoked || !programFailed || !expected.test(logText)) {
    throw new Error(`${label}: expected CrossFlow rejection ${expected}, got err=${JSON.stringify(result.value.err)} logs=${logText}`);
  }
  negativeResults.push({ label, expected: String(expected), log: logText });
  return logText;
};
const ownerState = fundAccounts.owner_state;
const intent = fundAccounts.intent;
const vaultAccounts = fundAccounts.vaults;
const balance = async (key: PublicKey) => {
  const info = await connection.getAccountInfo(key, 'confirmed');
  if (!info) return 0n;
  if (!info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 165) throw new Error(`unexpected token account ${key.toBase58()}`);
  let amount = 0n;
  for (let i = 0; i < 8; i++) amount |= BigInt(info.data[64 + i]) << BigInt(8 * i);
  return amount;
};
const beforeSource = await Promise.all(sourceAccounts.map(balance));
const beforeVault = await Promise.all(vaultAccounts.map(balance));
const instruction = (keys: AccountMeta[], data: Buffer) => new TransactionInstruction({ programId: PROGRAM, keys, data });
const configIx = instruction([
  { pubkey: signer.publicKey, isSigner: true, isWritable: true },
  { pubkey: config, isSigner: false, isWritable: true },
  { pubkey: prices, isSigner: false, isWritable: true },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
], Buffer.concat([disc('initialize_config'), observations]));
const configRent = await connection.getMinimumBalanceForRentExemption(831);
const prefundSig = await send(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: config, lamports: configRent }));
const prefundedConfig = await connection.getAccountInfo(config, 'confirmed');
if (!prefundedConfig || !prefundedConfig.owner.equals(SystemProgram.programId) || prefundedConfig.data.length !== 0 || prefundedConfig.lamports !== configRent) throw new Error('config PDA pre-funding setup failed');
const attacker = Keypair.generate();
const attackerAirdrop = await connection.requestAirdrop(attacker.publicKey, 100_000_000);
await connection.confirmTransaction(attackerAirdrop, 'confirmed');
const attackerIx = instruction([
  { pubkey: attacker.publicKey, isSigner: true, isWritable: true },
  { pubkey: config, isSigner: false, isWritable: true },
  { pubkey: prices, isSigner: false, isWritable: true },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
], Buffer.concat([disc('initialize_config'), observations]));
await simulateExpectedReject('attacker-first-initializer', attackerIx, /Error Code: Initializer/, [attacker]);
const attackerRejected = true;
const afterAttackerConfig = await connection.getAccountInfo(config, 'confirmed');
if (!attackerRejected || !afterAttackerConfig || !afterAttackerConfig.owner.equals(SystemProgram.programId) || afterAttackerConfig.lamports !== configRent) throw new Error('unexpected signer initialized or altered the pre-funded config');
const configInfo = await connection.getAccountInfo(config, 'confirmed');
let configSig: string | null = null;
if (!configInfo || (configInfo.owner.equals(SystemProgram.programId) && configInfo.data.length === 0)) configSig = await send(configIx);
else if (!configInfo.owner.equals(PROGRAM) || configInfo.data.length !== 831 ||
    !configInfo.data.subarray(0, 8).equals(accountDiscriminator('Config')) ||
    !configInfo.data.subarray(8, 40).equals(Buffer.from(manifest.deployment_id, 'hex')) ||
    !configInfo.data.subarray(104, 136).equals(Buffer.from(manifest.initial_policy_hash, 'hex')) ||
    !configInfo.data.subarray(136, 788).equals(Buffer.from(manifest.policy_bytes_hex, 'hex')) ||
    !configInfo.data.subarray(788, 820).equals(signer.publicKey.toBuffer())) throw new Error('existing config differs from prepared manifest');
await simulateExpectedReject('duplicate-initialization', configIx, /already in use|Error Code: ConstraintInit/);
const duplicateInitRejected = true;
const pricesInfo = await connection.getAccountInfo(prices, 'confirmed');
if (!pricesInfo || !pricesInfo.owner.equals(PROGRAM) || pricesInfo.data.length !== 419 ||
    !pricesInfo.data.subarray(0, 8).equals(accountDiscriminator('FixtureSnapshot')) ||
    !pricesInfo.data.subarray(8, 40).equals(config.toBuffer()) ||
    !pricesInfo.data.subarray(40, 72).equals(Buffer.from(manifest.initial_policy_hash, 'hex'))) throw new Error('fixture snapshot missing or has wrong owner/domain');
const nextSequence = readU64(pricesInfo.data, 105) + 1n;
const one = u64(nextSequence);
const publishData = Buffer.concat([disc('publish_prices'), one, observations]);
const publishIx = instruction([
  { pubkey: signer.publicKey, isSigner: true, isWritable: false },
  { pubkey: config, isSigner: false, isWritable: false },
  { pubkey: prices, isSigner: false, isWritable: true },
], publishData);
const publishSig = await send(publishIx);
const fundingRequest = {
  expected_policy_hash: manifest.initial_policy_hash,
  nonce: '0',
  expiry_unix_seconds: (now + 600n).toString(),
  optimization_commitment: randomBytes(32).toString('hex'),
  assets: [
    { funding: '100000000', min_output: '50000000', max_output: '200000000', funding_reference_price: '1000000' },
    { funding: '1000000', min_output: '0', max_output: '2000000', funding_reference_price: '10000000' },
    { funding: '1000000', min_output: '0', max_output: '2000000', funding_reference_price: '20000000' },
  ],
};
const fundIx = buildCreateAndFundInstruction(PROGRAM, signer.publicKey, fundAccounts, fundingRequest);
const request = Buffer.from(fundIx.data.subarray(8));
if (request.length !== 177) throw new Error('funding body must be exactly 177 bytes');
const fundingKeys: AccountMeta[] = fundIx.keys;
const invalidRequest = Buffer.from(request);
const badReference = invalidRequest.readBigUInt64LE(invalidRequest.length - 8);
invalidRequest.writeBigUInt64LE(badReference + 1n, invalidRequest.length - 8); // One raw unit outside the funding reference.
const rejectedCases: string[] = [];
const rejectWithoutMovement = async (label: string, ix: TransactionInstruction, expected: RegExp, extraSigners: Keypair[] = []) => {
  await simulateExpectedReject(label, ix, expected, extraSigners, true);
  const sourceAfter = await Promise.all(sourceAccounts.map(balance));
  const vaultAfter = await Promise.all(vaultAccounts.map(balance));
  if (String(beforeSource) !== String(sourceAfter) || String(beforeVault) !== String(vaultAfter)) throw new Error(`${label}: simulation altered token balances`);
  rejectedCases.push(label);
};
await rejectWithoutMovement('one-raw-unit-reference-mismatch', instruction(fundingKeys, Buffer.concat([disc('create_and_fund'), invalidRequest])), /Error Code: ReferenceMove/);
const insufficientRequest = Buffer.from(request);
insufficientRequest.writeBigUInt64LE(2_000_000_000n, 81);
await rejectWithoutMovement('insufficient-source-balance', instruction(fundingKeys, Buffer.concat([disc('create_and_fund'), insufficientRequest])), /Error Code: InsufficientFunds/);
const wrongRecipientKeys = fundingKeys.map(meta => ({ ...meta }));
wrongRecipientKeys[9].pubkey = SystemProgram.programId;
await rejectWithoutMovement('substituted-source-ata', instruction(wrongRecipientKeys, Buffer.concat([disc('create_and_fund'), request])), /Error Code: (?:AccountOwnedByWrongProgram|ConstraintAssociated)/);
const wrongMintKeys = fundingKeys.map(meta => ({ ...meta }));
wrongMintKeys[6].pubkey = mints[2];
await rejectWithoutMovement('substituted-configured-mint', instruction(wrongMintKeys, Buffer.concat([disc('create_and_fund'), request])), /Error Code: (?:ConstraintAssociated|Mint)/);
const attackerFunder = Keypair.generate();
const wrongFunderKeys = fundingKeys.map(meta => ({ ...meta }));
wrongFunderKeys[0].pubkey = attackerFunder.publicKey;
await rejectWithoutMovement('wrong-funder-signer', instruction(wrongFunderKeys, Buffer.concat([disc('create_and_fund'), request])), /Error Code: (?:ConstraintSeeds|Nonce)/, [attackerFunder]);
const fundingSig = await send(fundIx, [], true);
const afterSource = await Promise.all(sourceAccounts.map(balance));
const afterVault = await Promise.all(vaultAccounts.map(balance));
const expectedFunding = [100_000_000n, 1_000_000n, 1_000_000n];
for (let i = 0; i < 3; i++) if (beforeSource[i] - afterSource[i] !== expectedFunding[i] || afterVault[i] - beforeVault[i] !== expectedFunding[i]) throw new Error(`funding delta mismatch for asset ${i}`);
const postFundingSource = await Promise.all(sourceAccounts.map(balance));
const postFundingVault = await Promise.all(vaultAccounts.map(balance));
const nextNonceAccounts = deriveFundAccounts(PROGRAM, config, prices, signer.publicKey, 1n, mints);
const activeIntentIx = buildCreateAndFundInstruction(PROGRAM, signer.publicKey, nextNonceAccounts, { ...fundingRequest, nonce: '1' });
await simulateExpectedReject('duplicate-active-intent-new-nonce', activeIntentIx, /Error Code: Nonce/, [], true);
if (String(postFundingSource) !== String(await Promise.all(sourceAccounts.map(balance))) ||
    String(postFundingVault) !== String(await Promise.all(vaultAccounts.map(balance)))) throw new Error('second active intent changed token balances');
rejectedCases.push('duplicate-active-intent-new-nonce');
await simulateExpectedReject('duplicate-intent-replay', fundIx, /already in use|Error Code: ConstraintInit/, [], true);
if (String(postFundingSource) !== String(await Promise.all(sourceAccounts.map(balance))) ||
    String(postFundingVault) !== String(await Promise.all(vaultAccounts.map(balance)))) throw new Error('replayed funding changed state');
rejectedCases.push('duplicate-intent-replay');
const intentInfo = await connection.getAccountInfo(intent, 'confirmed');
const ownerStateInfo = await connection.getAccountInfo(ownerState, 'confirmed');
if (!intentInfo || !intentInfo.owner.equals(PROGRAM) || intentInfo.data.length !== 522 ||
    !intentInfo.data.subarray(0, 8).equals(accountDiscriminator('Intent')) ||
    !intentInfo.data.subarray(8, 40).equals(config.toBuffer()) || !intentInfo.data.subarray(40, 72).equals(signer.publicKey.toBuffer()) ||
    intentInfo.data.readBigUInt64LE(72) !== 0n || !intentInfo.data.subarray(88, 120).equals(Buffer.from(manifest.initial_policy_hash, 'hex')) || intentInfo.data[520] !== 0) {
  throw new Error('funded intent missing or has unexpected owner/domain/status');
}
const expectedMandate = {
  schema_version: '1', genesis: manifest.policy.genesis, program_id: manifest.policy.program_id,
  config_address: manifest.policy.config_address, policy_hash: manifest.initial_policy_hash,
  owner: signer.publicKey.toBuffer().toString('hex'), nonce: fundingRequest.nonce,
  expiry_unix_seconds: fundingRequest.expiry_unix_seconds, optimization_commitment: fundingRequest.optimization_commitment,
  assets: fundingRequest.assets.map((asset, i) => ({ ...asset, mint: manifest.policy.assets[i].mint,
    token_program: manifest.policy.assets[i].token_program, decimals: String(manifest.policy.assets[i].decimals),
    recipient_ata: sourceAccounts[i].toBuffer().toString('hex') })),
};
const expectedMandateHash = createHash('sha256').update(mandateBytes(expectedMandate)).digest();
if (!intentInfo!.data.subarray(120, 152).equals(expectedMandateHash) ||
    !intentInfo!.data.subarray(152, 184).equals(Buffer.from(fundingRequest.optimization_commitment, 'hex'))) throw new Error('stored mandate or optimization commitment differs from the reviewed request');
for (let i = 0; i < 3; i++) {
  const row = 184 + i * 32;
  const asset = fundingRequest.assets[i];
  const expectedRow = Buffer.concat([u64(BigInt(asset.funding)), u64(BigInt(asset.min_output)), u64(BigInt(asset.max_output)), u64(BigInt(asset.funding_reference_price))]);
  if (!intentInfo!.data.subarray(row, row + 32).equals(expectedRow) ||
      !intentInfo!.data.subarray(280 + i * 32, 312 + i * 32).equals(sourceAccounts[i].toBuffer()) ||
      !intentInfo!.data.subarray(376 + i * 32, 408 + i * 32).equals(vaultAccounts[i].toBuffer()) ||
      intentInfo!.data.readBigUInt64LE(472 + i * 8) !== BigInt(asset.funding) ||
      intentInfo!.data.readBigUInt64LE(496 + i * 8) !== beforeVault[i]) throw new Error(`stored mandate asset ${i} or accounting baseline differs`);
}
if (!ownerStateInfo || !ownerStateInfo.owner.equals(PROGRAM) || ownerStateInfo.data.length !== 114 ||
    !ownerStateInfo.data.subarray(0, 8).equals(accountDiscriminator('OwnerState')) ||
    !ownerStateInfo.data.subarray(8, 40).equals(config.toBuffer()) || !ownerStateInfo.data.subarray(40, 72).equals(signer.publicKey.toBuffer()) ||
    ownerStateInfo.data.readBigUInt64LE(72) !== 1n || ownerStateInfo.data[80] !== 1 ||
    !ownerStateInfo.data.subarray(81, 113).equals(intent.toBuffer())) throw new Error('owner nonce/active intent state mismatch');
console.log(JSON.stringify({ status: 'LOCAL_FUNDING_PASS', genesis, config: config.toBase58(), prices: prices.toBase58(), intent: intent.toBase58(),
  prefundSignature: prefundSig, configSignature: configSig, publishSignature: publishSig, attackerFirstInitializerRejected: attackerRejected, duplicateInitializationRejected: duplicateInitRejected,
  rollbackCases: rejectedCases, fundingSignature: fundingSig,
  negativeResults,
  stored_mandate_hash: expectedMandateHash.toString('hex'),
  stored_intent_verified: true,
  sourceBefore: beforeSource.map(String), sourceAfter: afterSource.map(String), vaultBefore: beforeVault.map(String), vaultAfter: afterVault.map(String), intentDataLength: intentInfo.data.length,
  priceLabel: 'TEST PRICES; synthetic fixture oracle; no equity price claim' }, null, 2));

function accountDiscriminator(name: string) { return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8); }
function readU64(data: Buffer, offset: number) { let value = 0n; for (let i = 0; i < 8; i++) value |= BigInt(data[offset + i]) << BigInt(8 * i); return value; }
function u64(value: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b; }
function i32(value: number) { const b = Buffer.alloc(4); b.writeInt32LE(value); return b; }
