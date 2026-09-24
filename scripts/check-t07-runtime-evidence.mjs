import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('verification/evidence/T07-local-manifest.json', 'utf8'));
const demo = JSON.parse(readFileSync('verification/evidence/T07-local-demo-output.json', 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const required = new Map([
  ['attacker-first-initializer', /Error Code: Initializer/],
  ['duplicate-initialization', /already in use/],
  ['one-raw-unit-reference-mismatch', /Error Code: ReferenceMove/],
  ['insufficient-source-balance', /Error Code: InsufficientFunds/],
  ['substituted-source-ata', /Error Code: (AccountOwnedByWrongProgram|ConstraintAssociated)/],
  ['substituted-configured-mint', /Error Code: (ConstraintAssociated|Mint)/],
  ['wrong-funder-signer', /Error Code: (ConstraintSeeds|Nonce)/],
  ['duplicate-active-intent-new-nonce', /Error Code: Nonce/],
  ['duplicate-intent-replay', /already in use/],
  ['third-leg-output-bound-rollback', /Error Code: Output/],
  ['third-leg-output-below-minimum', /Error Code: Output/],
  ['double-settle', /Error Code: Settle/],
  ['cancel-after-settle', /Error Code: RecoveryStatus/],
  ['settlement-paused', /Error Code: Paused/],
  ['policy-update-with-outstanding-claim', /Error Code: ClaimsOutstanding/],
  ['changed-feed-with-outstanding-claim', /Error Code: ClaimsOutstanding/],
  ['changed-route-with-outstanding-claim', /Error Code: ClaimsOutstanding/],
  ['settlement-after-expiry', /Error Code: Settle/],
  ['double-cancel', /Error Code: RecoveryStatus/],
  ['settlement-after-cancel', /Error Code: Settle/],
  ['unauthorized-cancel', /Error Code: ConstraintSeeds/],
  ['unauthorized-withdraw', /Error Code: ConstraintSeeds/],
  ['substituted-withdraw-recipient', /Error Code: TokenIdentity/],
  ['completed-withdrawal-replay', /Error Code: NothingToWithdraw/],
  ['closed-intent-replay', /Error Code: Nonce/],
  ['stale-policy-version', /Error Code: StaleVersion/],
  ['weakened-oracle-policy', /Error Code: Policy/],
  ['unauthorized-config-update', /Error Code: Admin/],
  ['stale-admin-version', /Error Code: StaleVersion/],
  ['previous-admin-rejected-after-rotation', /Error Code: Admin/],
]);
const transcript = new Map((demo.negativeResults ?? []).map(row => [row.label, row]));
if (manifest.cluster !== 'localnet' || demo.status !== 'LOCAL_LIFECYCLE_PASS' ||
    demo.genesis !== manifest.genesis || demo.config !== manifest.config_address ||
    demo.priceLabel !== 'TEST PRICES; synthetic fixture oracle; no equity price claim' ||
    hash(Buffer.from(manifest.policy_bytes_hex, 'hex')) !== manifest.initial_policy_hash ||
    demo.stored_intent_verified !== true || !/^[0-9a-f]{64}$/.test(demo.stored_mandate_hash ?? '')) {
  throw new Error('T07 local identity, policy bytes, test-price label or mandate evidence mismatch');
}
for (const [label, expected] of required) {
  const row = transcript.get(label);
  if (!row || !row.log?.includes(`Program ${manifest.program_id} invoke [1]`) ||
      !row.log?.includes(`Program ${manifest.program_id} failed:`) || !expected.test(row.log)) {
    throw new Error(`T07 expected program rejection missing for ${label}`);
  }
  if (label !== 'attacker-first-initializer' && label !== 'duplicate-initialization' && !demo.rollbackCases?.includes(label)) {
    throw new Error(`T07 rollback case omitted from summary: ${label}`);
  }
}
if (transcript.size !== required.size || new Set(demo.rollbackCases ?? []).size !== demo.rollbackCases?.length) {
  throw new Error('T07 negative transcript has missing, duplicate or unreviewed cases');
}
for (const label of ['third-leg-output-bound-rollback', 'third-leg-output-below-minimum']) {
  if ((transcript.get(label)?.log?.match(/Instruction: TransferChecked/g) ?? []).length !== 2) {
    throw new Error(`${label} did not reach two successful token transfer CPIs before rollback`);
  }
}
const lifecycle = demo.lifecycle;
const expectedAmounts = ['100000000', '1000000', '1000000'];
if (!lifecycle || JSON.stringify(lifecycle.settleOutputs) !== JSON.stringify(expectedAmounts) ||
    JSON.stringify(lifecycle.cancelledWithdrawals) !== JSON.stringify(expectedAmounts) ||
    JSON.stringify(lifecycle.vaultsAfterSettledReturn) !== '["0","0","0"]' ||
    lifecycle.cancellationAfterExpiry !== true || lifecycle.recipientAtaRecreatedByOwner !== true ||
    lifecycle.otherAssetRecoveredWhileRecipientMissing !== true ||
    lifecycle.settlementAndFundingPausedDuringOwnerRecovery !== true ||
    lifecycle.postRotationFundingAndOwnerRecovery !== true || lifecycle.policyVersionAfterRotation !== 2 ||
    lifecycle.finalNonce !== '3' || lifecycle.activeIntentCleared !== true ||
    lifecycle.outstandingClaimIntents !== '0' || BigInt(lifecycle.canonicalAtaRentLamports ?? 0) <= 0n ||
    lifecycle.canonicalAtaRentLamports !== lifecycle.devnetWalletRentPrerequisiteLamports) {
  throw new Error('T07 final accounting, ATA recovery, pause, version or rent invariant failed');
}
const signatureMap = {
  prefund: demo.prefundSignature, initialize: demo.configSignature, publish: demo.publishSignature,
  fund: demo.fundingSignature, ...lifecycle.lifecycleSignatures,
};
const signatures = Object.values(signatureMap);
if (signatures.length < 27 || new Set(signatures).size !== signatures.length ||
    signatures.some(value => typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value))) {
  throw new Error('T07 local transaction signatures are absent, malformed or reused');
}
const report = {
  status: 'PASS', task: 'T07', cluster: 'localnet', genesis: manifest.genesis,
  program_id: manifest.program_id, config: manifest.config_address,
  mandatory_negative_cases: required.size, transaction_signatures: signatureMap,
  transaction_signatures_count: signatures.length, settlement_rollback_cpis_per_case: 2,
  final_nonce: lifecycle.finalNonce, outstanding_claim_intents: lifecycle.outstandingClaimIntents,
  deployment_manifest_sha256: hash(readFileSync('verification/evidence/T07-local-manifest.json')),
  demo_transcript_sha256: hash(readFileSync('verification/evidence/T07-local-demo-output.json')),
  program_binary_sha256: hash(readFileSync('target/deploy/crossflow.so')),
  limitations: ['Isolated local validator and synthetic test prices only; no devnet or live equity claim.',
    'Captured local signatures/transcript are historical evidence and require a running ledger for later RPC re-query.'],
};
console.log(JSON.stringify(report, null, 2));
