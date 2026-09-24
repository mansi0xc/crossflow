import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AccountMeta, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { assertPreparedDeploymentManifest } from './deployment-manifest.js';
import { buildCreateAndFundInstruction, deriveFundAccounts, fundingTransaction } from '../packages/client/src/fund.js';
import { buildCancelIntentInstruction, buildCloseIntentInstruction, buildThinSettleInstruction, buildWithdrawAssetInstruction, deriveRecoveryAccounts } from '../packages/client/src/recover.js';
import { mandateBytes } from '../packages/contracts/src/index.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const args = process.argv.slice(2);
const completeLifecycle = args.length === 5 && args[3] === '--step' && args[4] === 'complete';
if (args.length !== 3 && !completeLifecycle) throw new Error('usage: tsx scripts/demo-local.ts <http://127.0.0.1:8899> <manifest.json> <local-keypair.json> [--step complete]');
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
const observedSlot = await connection.getSlot('confirmed');
const observedBlockTime = await connection.getBlockTime(observedSlot);
if (observedBlockTime === null) throw new Error('local validator has no confirmed block time');
// The validator may run with a simulated clock that differs from the workstation clock.
const now = BigInt(observedBlockTime);
const observation = (i: number, timestamp: bigint) => Buffer.concat([
  mints[i].toBuffer(), feeds[i], u64([1_000_000n, 10_000_000n, 20_000_000n][i]), u64(0n),
  i32(-6), Buffer.from([0]), u64(timestamp), u64(timestamp), Buffer.from([0]),
]);
const observations = Buffer.concat([0, 1, 2].map(i => observation(i, now)));
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const send = async (ix: TransactionInstruction, extraSigners: Keypair[] = [], funding = false) => sendAndConfirmTransaction(connection, funding ? fundingTransaction(ix) : new Transaction().add(ix), [signer, ...extraSigners], { commitment: 'confirmed' });
const negativeResults: { label: string; expected: string; log: string }[] = [];
const simulateExpectedReject = async (label: string, ix: TransactionInstruction, expected: RegExp,
  extraSigners: Keypair[] = [], funding = false, addSalt = true) => {
  const tx = funding ? fundingTransaction(ix) : new Transaction().add(ix);
  // Salt simulations so repeated instruction bytes do not collide with a prior simulated transaction signature.
  // Large policy updates use every available byte of the legacy transaction envelope.
  if (addSalt) tx.add(new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: randomBytes(8) }));
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(signer, ...extraSigners);
  let result = await connection.simulateTransaction(tx);
  if (!addSalt && result.value.err === 'AlreadyProcessed') {
    const usedBlockhash = tx.recentBlockhash;
    for (let attempt = 0; attempt < 20 && result.value.err === 'AlreadyProcessed'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 400));
      const fresh = (await connection.getLatestBlockhash('confirmed')).blockhash;
      if (fresh === usedBlockhash) continue;
      tx.recentBlockhash = fresh;
      tx.sign(signer, ...extraSigners);
      result = await connection.simulateTransaction(tx);
    }
  }
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
const sendInstructions = async (instructions: TransactionInstruction[], extraSigners: Keypair[] = []) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...instructions), [signer, ...extraSigners], { commitment: 'confirmed' });
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
const adminConfigIx = (name: string, data: Buffer, admin = signer.publicKey) => instruction([
  { pubkey: admin, isSigner: true, isWritable: false },
  { pubkey: config, isSigner: false, isWritable: true },
], Buffer.concat([disc(name), data]));
const policyUpdateIx = (expectedVersion: number, policyBytes: Buffer, nextObservations: Buffer) => instruction([
  { pubkey: signer.publicKey, isSigner: true, isWritable: false },
  { pubkey: config, isSigner: false, isWritable: true },
  { pubkey: signer.publicKey, isSigner: true, isWritable: false },
  { pubkey: prices, isSigner: false, isWritable: true },
], Buffer.concat([disc('update_policy'), u32(expectedVersion), policyBytes, nextObservations]));
const configIx = instruction([
  { pubkey: signer.publicKey, isSigner: true, isWritable: true },
  { pubkey: config, isSigner: false, isWritable: true },
  { pubkey: prices, isSigner: false, isWritable: true },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
], Buffer.concat([disc('initialize_config'), observations]));
const configRent = await connection.getMinimumBalanceForRentExemption(831);
let prefundedConfig = await connection.getAccountInfo(config, 'confirmed');
let prefundSig: string | null = null;
if (!prefundedConfig) {
  prefundSig = await send(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: config, lamports: configRent }));
  prefundedConfig = await connection.getAccountInfo(config, 'confirmed');
}
if (!prefundedConfig || (prefundedConfig.owner.equals(SystemProgram.programId)
    ? prefundedConfig.data.length !== 0 || prefundedConfig.lamports < configRent
    : !prefundedConfig.owner.equals(PROGRAM) || prefundedConfig.data.length !== 831)) throw new Error('config PDA setup failed');
const attacker = Keypair.generate();
const attackerAirdrop = await connection.requestAirdrop(attacker.publicKey, 100_000_000);
await connection.confirmTransaction(attackerAirdrop, 'confirmed');
const attackerIx = instruction([
  { pubkey: attacker.publicKey, isSigner: true, isWritable: true },
  { pubkey: config, isSigner: false, isWritable: true },
  { pubkey: prices, isSigner: false, isWritable: true },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
], Buffer.concat([disc('initialize_config'), observations]));
await simulateExpectedReject('attacker-first-initializer', attackerIx, /Error Code: (?:Initializer|ConstraintInit)|already in use/, [attacker]);
const attackerRejected = true;
const afterAttackerConfig = await connection.getAccountInfo(config, 'confirmed');
if (!attackerRejected || !afterAttackerConfig || !afterAttackerConfig.owner.equals(prefundedConfig.owner) ||
    afterAttackerConfig.lamports !== prefundedConfig.lamports || !afterAttackerConfig.data.equals(prefundedConfig.data)) throw new Error('unexpected signer initialized or altered the config');
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
    { funding: '1000000', min_output: '500000', max_output: '2000000', funding_reference_price: '20000000' },
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
const lifecycleSignatures: Record<string, string> = {};
let lifecycleEvidence: Record<string, unknown> | undefined;
if (completeLifecycle) {
  const attackerOwner = Keypair.generate();
  const recovery0 = deriveRecoveryAccounts(PROGRAM, config, prices, signer.publicKey, 0n, mints);
  const currentPricesInfo = await connection.getAccountInfo(prices, 'confirmed');
  if (!currentPricesInfo) throw new Error('current fixture snapshot disappeared');
  const snapshotSequence = readU64(currentPricesInfo.data, 105).toString();
  const outputs = expectedFunding.map(String);
  const badOutputs = ['100000000', '1000000', '2000001'];
  const settleIx = buildThinSettleInstruction(PROGRAM, signer.publicKey, recovery0, snapshotSequence, outputs);
  const beforeBadSettleSource = await Promise.all(sourceAccounts.map(balance));
  const beforeBadSettleVault = await Promise.all(vaultAccounts.map(balance));
  const badSettleLogs = await simulateExpectedReject('third-leg-output-bound-rollback',
    buildThinSettleInstruction(PROGRAM, signer.publicKey, recovery0, snapshotSequence, badOutputs), /Error Code: Output/);
  const badSettleTransfers = (badSettleLogs.match(/Instruction: TransferChecked/g) ?? []).length;
  if (badSettleTransfers !== 2 || String(beforeBadSettleSource) !== String(await Promise.all(sourceAccounts.map(balance))) ||
      String(beforeBadSettleVault) !== String(await Promise.all(vaultAccounts.map(balance)))) {
    throw new Error('third-leg settle rejection did not prove two successful simulated CPIs rolled back');
  }
  rejectedCases.push('third-leg-output-bound-rollback');
  const belowMinimumLogs = await simulateExpectedReject('third-leg-output-below-minimum',
    buildThinSettleInstruction(PROGRAM, signer.publicKey, recovery0, snapshotSequence, ['100000000', '1000000', '499999']), /Error Code: Output/);
  const belowMinimumTransfers = (belowMinimumLogs.match(/Instruction: TransferChecked/g) ?? []).length;
  if (belowMinimumTransfers !== 2 || String(beforeBadSettleSource) !== String(await Promise.all(sourceAccounts.map(balance))) ||
      String(beforeBadSettleVault) !== String(await Promise.all(vaultAccounts.map(balance)))) {
    throw new Error('below-minimum settle rejection did not prove two successful simulated CPIs rolled back');
  }
  rejectedCases.push('third-leg-output-below-minimum');
  lifecycleSignatures.settle = await send(settleIx);
  const settledSource = await Promise.all(sourceAccounts.map(balance));
  const settledVault = await Promise.all(vaultAccounts.map(balance));
  if (String(settledSource.map((n, i) => n - beforeBadSettleSource[i])) !== String(expectedFunding) ||
      String(settledVault) !== String(beforeBadSettleVault.map(n => 0n))) throw new Error('settlement token deltas mismatch');
  const settledInfo = await connection.getAccountInfo(intent, 'confirmed');
  if (!settledInfo || settledInfo.data[520] !== 1 || [0, 1, 2].some(i => readU64(settledInfo.data, 472 + i * 8) !== 0n)) {
    throw new Error('settled intent status or booked claims mismatch');
  }
  await simulateExpectedReject('double-settle', settleIx, /Error Code: Settle/);
  rejectedCases.push('double-settle');
  await simulateExpectedReject('cancel-after-settle', buildCancelIntentInstruction(PROGRAM, signer.publicKey, recovery0), /Error Code: RecoveryStatus/);
  rejectedCases.push('cancel-after-settle');
  const wrongClose = buildCloseIntentInstruction(PROGRAM, signer.publicKey, recovery0);
  const wrongCloseKeys = wrongClose.keys.map(meta => ({ ...meta }));
  wrongCloseKeys[0] = { pubkey: attackerOwner.publicKey, isSigner: true, isWritable: true };
  await simulateExpectedReject('wrong-rent-recipient-close', instruction(wrongCloseKeys, wrongClose.data),
    /Error Code: ConstraintSeeds/, [attackerOwner]);
  rejectedCases.push('wrong-rent-recipient-close');
  const rent0 = (await Promise.all(recovery0.vaults.map(key => connection.getAccountInfo(key, 'confirmed'))))
    .reduce((sum, info) => sum + BigInt(info?.lamports ?? 0), 0n) + BigInt((await connection.getAccountInfo(recovery0.intent, 'confirmed'))?.lamports ?? 0);
  lifecycleSignatures.closeSettled = await send(buildCloseIntentInstruction(PROGRAM, signer.publicKey, recovery0));
  if (await connection.getAccountInfo(recovery0.intent, 'confirmed')) throw new Error('settled intent account was not closed');
  for (const vault of recovery0.vaults) if (await connection.getAccountInfo(vault, 'confirmed')) throw new Error('settled vault account was not closed');

  const nextAccounts = deriveFundAccounts(PROGRAM, config, prices, signer.publicKey, 1n, mints);
  const beforeSecondFundSlot = await connection.getSlot('confirmed');
  const beforeSecondFundTime = await connection.getBlockTime(beforeSecondFundSlot);
  if (beforeSecondFundTime === null) throw new Error('local validator has no confirmed block time before cancellation case');
  const cancelExpiry = BigInt(beforeSecondFundTime) + 2n;
  const cancelRequest = { ...fundingRequest, nonce: '1', expiry_unix_seconds: cancelExpiry.toString() };
  const fundNextIx = buildCreateAndFundInstruction(PROGRAM, signer.publicKey, nextAccounts, cancelRequest);
  lifecycleSignatures.fundForCancel = await send(fundNextIx, [], true);
  const recovery1 = deriveRecoveryAccounts(PROGRAM, config, prices, signer.publicKey, 1n, mints);
  lifecycleSignatures.pause = await send(adminConfigIx('set_pause', Buffer.from([1, 1])));
  const pausedPrices = await connection.getAccountInfo(prices, 'confirmed');
  if (!pausedPrices) throw new Error('fixture snapshot disappeared during pause test');
  await simulateExpectedReject('settlement-paused', buildThinSettleInstruction(PROGRAM, signer.publicKey, recovery1,
    readU64(pausedPrices.data, 105).toString(), expectedFunding.map(String)), /Error Code: Paused/);
  rejectedCases.push('settlement-paused');
  const rotatedPolicyBytes = Buffer.from(manifest.policy_bytes_hex, 'hex');
  rotatedPolicyBytes.writeUInt32LE(2, 104);
  await simulateExpectedReject('policy-update-with-outstanding-claim',
    policyUpdateIx(1, rotatedPolicyBytes, observations), /Error Code: ClaimsOutstanding/, [], false, false);
  rejectedCases.push('policy-update-with-outstanding-claim');
  const changedFeedPolicy = Buffer.from(rotatedPolicyBytes);
  changedFeedPolicy[176] ^= 1;
  await simulateExpectedReject('changed-feed-with-outstanding-claim',
    policyUpdateIx(1, changedFeedPolicy, observations), /Error Code: ClaimsOutstanding/, [], false, false);
  rejectedCases.push('changed-feed-with-outstanding-claim');
  const changedRoutePolicy = Buffer.from(rotatedPolicyBytes);
  changedRoutePolicy[402] = 1;
  await simulateExpectedReject('changed-route-with-outstanding-claim',
    policyUpdateIx(1, changedRoutePolicy, observations), /Error Code: ClaimsOutstanding/, [], false, false);
  rejectedCases.push('changed-route-with-outstanding-claim');
  const preCancelSource = await Promise.all(nextAccounts.sources.map(balance));
  const preCancelVault = await Promise.all(nextAccounts.vaults.map(balance));
  const expiryDeadline = Date.now() + 12_000;
  let chainTime = beforeSecondFundTime;
  while (BigInt(chainTime) <= cancelExpiry && Date.now() < expiryDeadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const slot = await connection.getSlot('confirmed');
    chainTime = await connection.getBlockTime(slot) ?? chainTime;
  }
  if (BigInt(chainTime) <= cancelExpiry) throw new Error('local validator did not advance beyond cancellation expiry');
  lifecycleSignatures.unpauseForExpiryCheck = await send(adminConfigIx('set_pause', Buffer.from([0, 0])));
  await simulateExpectedReject('settlement-after-expiry', buildThinSettleInstruction(PROGRAM, signer.publicKey,
    recovery1, readU64(pausedPrices.data, 105).toString(), expectedFunding.map(String)), /Error Code: Settle/);
  rejectedCases.push('settlement-after-expiry');
  lifecycleSignatures.repauseForRecovery = await send(adminConfigIx('set_pause', Buffer.from([1, 1])));
  const cancelIx = buildCancelIntentInstruction(PROGRAM, signer.publicKey, recovery1);
  lifecycleSignatures.cancel = await send(cancelIx);
  if (String(preCancelSource) !== String(await Promise.all(nextAccounts.sources.map(balance))) ||
      String(preCancelVault) !== String(await Promise.all(nextAccounts.vaults.map(balance)))) throw new Error('cancel moved tokens');
  const cancelledInfo = await connection.getAccountInfo(recovery1.intent, 'confirmed');
  if (!cancelledInfo || cancelledInfo.data[520] !== 2 || cancelledInfo.data.readBigUInt64LE(80) >= BigInt(chainTime)) throw new Error('expired intent did not cancel to Cancelled status');
  await simulateExpectedReject('double-cancel', cancelIx, /Error Code: RecoveryStatus/);
  rejectedCases.push('double-cancel');
  lifecycleSignatures.unpauseForRaceCheck = await send(adminConfigIx('set_pause', Buffer.from([0, 0])));
  await simulateExpectedReject('settlement-after-cancel', buildThinSettleInstruction(PROGRAM, signer.publicKey,
    recovery1, readU64(pausedPrices.data, 105).toString(), expectedFunding.map(String)), /Error Code: Settle/);
  rejectedCases.push('settlement-after-cancel');
  lifecycleSignatures.repauseForWithdrawals = await send(adminConfigIx('set_pause', Buffer.from([1, 1])));
  const attackerCancelKeys = cancelIx.keys.map(meta => ({ ...meta }));
  attackerCancelKeys[0] = { pubkey: attackerOwner.publicKey, isSigner: true, isWritable: false };
  const attackerCancelIx = instruction(attackerCancelKeys, cancelIx.data);
  await simulateExpectedReject('unauthorized-cancel', attackerCancelIx, /Error Code: ConstraintSeeds/, [attackerOwner]);
  rejectedCases.push('unauthorized-cancel');
  const attackerWithdrawKeys = buildWithdrawAssetInstruction(PROGRAM, signer.publicKey, recovery1, 0).keys.map(meta => ({ ...meta }));
  attackerWithdrawKeys[0] = { pubkey: attackerOwner.publicKey, isSigner: true, isWritable: true };
  await simulateExpectedReject('unauthorized-withdraw', instruction(attackerWithdrawKeys,
    buildWithdrawAssetInstruction(PROGRAM, signer.publicKey, recovery1, 0).data), /Error Code: ConstraintSeeds/, [attackerOwner]);
  rejectedCases.push('unauthorized-withdraw');
  const substitutedWithdraw = buildWithdrawAssetInstruction(PROGRAM, signer.publicKey, recovery1, 0);
  const substitutedWithdrawKeys = substitutedWithdraw.keys.map(meta => ({ ...meta }));
  substitutedWithdrawKeys[10].pubkey = recovery1.recipients[1];
  await simulateExpectedReject('substituted-withdraw-recipient', instruction(substitutedWithdrawKeys, substitutedWithdraw.data), /Error Code: TokenIdentity/);
  rejectedCases.push('substituted-withdraw-recipient');
  const recovered: string[] = [];
  const auxiliaryOwner = Keypair.generate();
  const [auxiliaryAta] = PublicKey.findProgramAddressSync(
    [auxiliaryOwner.publicKey.toBuffer(), TOKEN_PROGRAM.toBuffer(), mints[0].toBuffer()], ATA_PROGRAM);
  const drainedAmount = await balance(nextAccounts.sources[0]);
  const closeCanonicalAta = new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [
    { pubkey: nextAccounts.sources[0], isSigner: false, isWritable: true },
    { pubkey: signer.publicKey, isSigner: false, isWritable: true },
    { pubkey: signer.publicKey, isSigner: true, isWritable: false },
  ], data: Buffer.from([9]) });
  if (drainedAmount > 0n) {
    lifecycleSignatures.temporaryAta = await sendInstructions([
      new TransactionInstruction({ programId: ATA_PROGRAM, keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: auxiliaryAta, isSigner: false, isWritable: true },
        { pubkey: auxiliaryOwner.publicKey, isSigner: false, isWritable: false },
        { pubkey: mints[0], isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ], data: Buffer.from([1]) }),
      new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [
        { pubkey: nextAccounts.sources[0], isSigner: false, isWritable: true },
        { pubkey: mints[0], isSigner: false, isWritable: false },
        { pubkey: auxiliaryAta, isSigner: false, isWritable: true },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      ], data: Buffer.concat([Buffer.from([12]), u64(drainedAmount), Buffer.from([manifest.policy.assets[0].decimals])]) }),
      closeCanonicalAta,
    ]);
  } else {
    lifecycleSignatures.temporaryAta = await send(closeCanonicalAta);
  }
  if (await connection.getAccountInfo(nextAccounts.sources[0], 'confirmed')) throw new Error('recipient ATA closure setup failed');
  const secondSourceBefore = await balance(nextAccounts.sources[1]);
  lifecycleSignatures.withdraw1WhileOtherAtaMissing = await send(buildWithdrawAssetInstruction(PROGRAM, signer.publicKey, recovery1, 1));
  if (await connection.getAccountInfo(nextAccounts.sources[0], 'confirmed') ||
      await balance(nextAccounts.sources[1]) - secondSourceBefore !== expectedFunding[1] ||
      await balance(nextAccounts.vaults[1]) !== 0n) throw new Error('another asset could not recover while asset 0 recipient ATA was absent');
  recovered[1] = expectedFunding[1].toString();
  const recreationRent = await connection.getMinimumBalanceForRentExemption(165);
  lifecycleSignatures.withdraw0WithAtaRecreation = await send(buildWithdrawAssetInstruction(PROGRAM, signer.publicKey, recovery1, 0));
  if (!await connection.getAccountInfo(nextAccounts.sources[0], 'confirmed')) throw new Error('withdrawal did not recreate canonical owner ATA');
  const firstRecoveredAmount = await balance(nextAccounts.sources[0]);
  if (firstRecoveredAmount !== expectedFunding[0] || await balance(nextAccounts.vaults[0]) !== 0n) throw new Error('ATA-recreated recovery delta mismatch');
  recovered[0] = firstRecoveredAmount.toString();
  await simulateExpectedReject('completed-withdrawal-replay',
    buildWithdrawAssetInstruction(PROGRAM, signer.publicKey, recovery1, 0), /Error Code: NothingToWithdraw/);
  rejectedCases.push('completed-withdrawal-replay');
  for (let i = 0; i < 3; i++) {
    if (i < 2) continue;
    const sourceBefore = await balance(nextAccounts.sources[i]);
    const amount = await balance(nextAccounts.vaults[i]);
    lifecycleSignatures[`withdraw${i}`] = await send(buildWithdrawAssetInstruction(PROGRAM, signer.publicKey, recovery1, i));
    const sourceAfter = await balance(nextAccounts.sources[i]);
    const vaultAfter = await balance(nextAccounts.vaults[i]);
    if (sourceAfter - sourceBefore !== amount || vaultAfter !== 0n || amount !== expectedFunding[i]) throw new Error(`recovery delta mismatch for asset ${i}`);
    recovered[i] = amount.toString();
  }
  const rent1 = (await Promise.all(recovery1.vaults.map(key => connection.getAccountInfo(key, 'confirmed'))))
    .reduce((sum, info) => sum + BigInt(info?.lamports ?? 0n), 0n) + BigInt((await connection.getAccountInfo(recovery1.intent, 'confirmed'))?.lamports ?? 0n);
  lifecycleSignatures.closeCancelled = await send(buildCloseIntentInstruction(PROGRAM, signer.publicKey, recovery1));
  if (await connection.getAccountInfo(recovery1.intent, 'confirmed')) throw new Error('cancelled intent account was not closed');
  for (const vault of recovery1.vaults) if (await connection.getAccountInfo(vault, 'confirmed')) throw new Error('recovered vault account was not closed');
  const finalOwnerState = await connection.getAccountInfo(ownerState, 'confirmed');
  const finalConfig = await connection.getAccountInfo(config, 'confirmed');
  if (!finalOwnerState || finalOwnerState.data.readBigUInt64LE(72) !== 2n || finalOwnerState.data[80] !== 0 ||
      !finalConfig || finalConfig.data.readBigUInt64LE(822) !== 0n) throw new Error('final nonce, active intent, or outstanding claim counter mismatch');
  lifecycleSignatures.unpause = await send(adminConfigIx('set_pause', Buffer.from([0, 0])));
  await simulateExpectedReject('closed-intent-replay', fundIx, /Error Code: Nonce/, [], true);
  rejectedCases.push('closed-intent-replay');
  const rotationSlot = await connection.getSlot('confirmed');
  const rotationTime = await connection.getBlockTime(rotationSlot);
  if (rotationTime === null) throw new Error('local validator has no block time for policy rotation');
  const rotationObservations = Buffer.concat([0, 1, 2].map(i => observation(i, BigInt(rotationTime))));
  lifecycleSignatures.policyRotation = await send(policyUpdateIx(1, rotatedPolicyBytes, rotationObservations));
  const rotatedHash = createHash('sha256').update(rotatedPolicyBytes).digest();
  const rotatedPrices = await connection.getAccountInfo(prices, 'confirmed');
  if (!rotatedPrices || !rotatedPrices.data.subarray(40, 72).equals(rotatedHash) ||
      readU64(rotatedPrices.data, 105) !== 1n) throw new Error('policy rotation did not initialize the new authenticated fixture snapshot');
  const afterRotationSlot = await connection.getSlot('confirmed');
  const afterRotationTime = await connection.getBlockTime(afterRotationSlot);
  if (afterRotationTime === null) throw new Error('local validator has no block time after policy rotation');
  const postRotationRequest = { ...fundingRequest, expected_policy_hash: rotatedHash.toString('hex'),
    nonce: '2', expiry_unix_seconds: (BigInt(afterRotationTime) + 600n).toString() };
  const postRotationAccounts = deriveFundAccounts(PROGRAM, config, prices, signer.publicKey, 2n, mints);
  lifecycleSignatures.fundAfterRotation = await send(buildCreateAndFundInstruction(PROGRAM, signer.publicKey,
    postRotationAccounts, postRotationRequest), [], true);
  const recovery2 = deriveRecoveryAccounts(PROGRAM, config, prices, signer.publicKey, 2n, mints);
  lifecycleSignatures.cancelAfterRotation = await send(buildCancelIntentInstruction(PROGRAM, signer.publicKey, recovery2));
  for (let i = 0; i < 3; i++) lifecycleSignatures[`withdrawAfterRotation${i}`] =
    await send(buildWithdrawAssetInstruction(PROGRAM, signer.publicKey, recovery2, i));
  lifecycleSignatures.closeAfterRotation = await send(buildCloseIntentInstruction(PROGRAM, signer.publicKey, recovery2));
  const postRotationOwnerState = await connection.getAccountInfo(ownerState, 'confirmed');
  const postRotationConfig = await connection.getAccountInfo(config, 'confirmed');
  if (!postRotationOwnerState || postRotationOwnerState.data.readBigUInt64LE(72) !== 3n || postRotationOwnerState.data[80] !== 0 ||
      !postRotationConfig || postRotationConfig.data.readBigUInt64LE(822) !== 0n) throw new Error('post-rotation funding/recovery did not finish cleanly');
  const staleVersionObservations = Buffer.from(rotationObservations);
  staleVersionObservations[305] ^= 1;
  await simulateExpectedReject('stale-policy-version',
    policyUpdateIx(1, rotatedPolicyBytes, staleVersionObservations), /Error Code: StaleVersion/, [], false, false);
  rejectedCases.push('stale-policy-version');
  const weakenedPolicy = Buffer.from(rotatedPolicyBytes);
  weakenedPolicy.writeUInt32LE(3, 104);
  weakenedPolicy.writeUInt32LE(61, 596);
  await simulateExpectedReject('weakened-oracle-policy',
    policyUpdateIx(2, weakenedPolicy, rotationObservations), /Error Code: Policy/, [], false, false);
  rejectedCases.push('weakened-oracle-policy');
  await simulateExpectedReject('unauthorized-config-update',
    adminConfigIx('set_pause', Buffer.from([1, 1]), attackerOwner.publicKey), /Error Code: Admin/, [attackerOwner]);
  rejectedCases.push('unauthorized-config-update');
  const newAdmin = Keypair.generate();
  await simulateExpectedReject('stale-admin-version',
    adminConfigIx('update_admin', Buffer.concat([u32(1), newAdmin.publicKey.toBuffer()])), /Error Code: StaleVersion/);
  rejectedCases.push('stale-admin-version');
  lifecycleSignatures.adminRotation = await send(adminConfigIx('update_admin', Buffer.concat([u32(2), newAdmin.publicKey.toBuffer()])));
  await simulateExpectedReject('previous-admin-rejected-after-rotation',
    adminConfigIx('set_pause', Buffer.from([1, 1])), /Error Code: Admin/);
  rejectedCases.push('previous-admin-rejected-after-rotation');
  const rotatedConfig = await connection.getAccountInfo(config, 'confirmed');
  if (!rotatedConfig || !rotatedConfig.data.subarray(788, 820).equals(newAdmin.publicKey.toBuffer()) ||
      !rotatedConfig.data.subarray(136, 788).equals(rotatedPolicyBytes)) throw new Error('versioned policy/admin rotation did not persist');
  lifecycleEvidence = {
    lifecycle: 'settle-close; fund-cancel-withdraw-close',
    snapshotSequence,
    settleOutputs: outputs,
    rejectedSettlements: [
      { label: 'third-leg-output-above-maximum', successfulSimulatedTransferCpisBeforeReject: badSettleTransfers },
      { label: 'third-leg-output-below-minimum', successfulSimulatedTransferCpisBeforeReject: belowMinimumTransfers },
    ],
    sourceAfterSettledReturn: settledSource.map(String),
    vaultsAfterSettledReturn: settledVault.map(String),
    cancelledWithdrawals: recovered,
    cancellationAfterExpiry: true,
    expiredAtUnixSeconds: cancelledInfo.data.readBigUInt64LE(80).toString(),
    rentLamportsReclaimedFromSettledIntentAndVaults: rent0.toString(),
    rentLamportsReclaimedFromCancelledIntentAndVaults: rent1.toString(),
    finalNonce: postRotationOwnerState.data.readBigUInt64LE(72).toString(),
    activeIntentCleared: postRotationOwnerState.data[80] === 0,
    outstandingClaimIntents: postRotationConfig.data.readBigUInt64LE(822).toString(),
    recipientAtaRecreatedByOwner: true,
    otherAssetRecoveredWhileRecipientMissing: true,
    canonicalAtaRentLamports: recreationRent.toString(),
    devnetWalletRentPrerequisiteLamports: recreationRent.toString(),
    settlementAndFundingPausedDuringOwnerRecovery: true,
    policyVersionAfterRotation: rotatedConfig.data.readUInt32LE(136 + 104),
    postRotationFundingAndOwnerRecovery: true,
    lifecycleSignatures,
  };
}
console.log(JSON.stringify({ status: completeLifecycle ? 'LOCAL_LIFECYCLE_PASS' : 'LOCAL_FUNDING_PASS', genesis, config: config.toBase58(), prices: prices.toBase58(), intent: intent.toBase58(),
  prefundSignature: prefundSig, configSignature: configSig, publishSignature: publishSig, attackerFirstInitializerRejected: attackerRejected, duplicateInitializationRejected: duplicateInitRejected,
  rollbackCases: rejectedCases, fundingSignature: fundingSig,
  negativeResults,
  stored_mandate_hash: expectedMandateHash.toString('hex'),
  stored_intent_verified: true,
  sourceBefore: beforeSource.map(String), sourceAfter: afterSource.map(String), vaultBefore: beforeVault.map(String), vaultAfter: afterVault.map(String), intentDataLength: intentInfo.data.length,
  priceLabel: 'TEST PRICES; synthetic fixture oracle; no equity price claim', lifecycle: lifecycleEvidence }, null, 2));

function accountDiscriminator(name: string) { return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8); }
function readU64(data: Buffer, offset: number) { let value = 0n; for (let i = 0; i < 8; i++) value |= BigInt(data[offset + i]) << BigInt(8 * i); return value; }
function u64(value: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b; }
function u32(value: number) { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }
function i32(value: number) { const b = Buffer.alloc(4); b.writeInt32LE(value); return b; }
