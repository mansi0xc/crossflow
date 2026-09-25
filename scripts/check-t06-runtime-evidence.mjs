import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const report = readJson('verification/evidence/T06-local-runtime.json');
const manifest = readJson('verification/evidence/T06-local-manifest.json');
const demo = readJson('verification/evidence/T06-local-demo-output.json');
const requiredFailures = new Map([
  ['attacker-first-initializer', 'Initializer'], ['duplicate-initialization', 'already in use'],
  ['one-raw-unit-reference-mismatch', 'ReferenceMove'], ['insufficient-source-balance', 'InsufficientFunds'],
  ['substituted-source-ata', 'AccountOwnedByWrongProgram'], ['substituted-configured-mint', 'ConstraintAssociated'],
  ['wrong-funder-signer', 'ConstraintSeeds'], ['duplicate-active-intent-new-nonce', 'Nonce'],
  ['duplicate-intent-replay', 'already in use'], ['third-leg-output-above-maximum', 'Output'],
  ['third-leg-output-below-minimum', 'Output'], ['double-settle', 'Settle'],
  ['double-cancel', 'RecoveryStatus'], ['unauthorized-cancel', 'ConstraintSeeds'],
  ['unauthorized-withdraw', 'ConstraintSeeds'],
]);
const signatures = Object.values(report.transaction_signatures ?? {});
if (report.task !== 'T06' || report.status !== 'LOCAL_LIFECYCLE_PASS' || report.cluster !== 'localnet' ||
    report.rpc !== 'http://127.0.0.1:8899' || report.genesis !== manifest.genesis ||
    report.program_id !== manifest.program_id || report.deployment_id !== manifest.deployment_id ||
    report.policy_hash !== manifest.initial_policy_hash || report.initializer !== manifest.expected_initializer ||
    report.config !== manifest.config_address || report.price_label !== 'TEST PRICES; synthetic fixture oracle; no equity price claim' ||
    report.program_binary_sha256 !== sha256('target/deploy/crossflow.so') ||
    report.deployment_manifest_sha256 !== sha256('verification/evidence/T06-local-manifest.json') ||
    report.demo_output_sha256 !== sha256('verification/evidence/T06-local-demo-output.json') ||
    demo.status !== 'LOCAL_LIFECYCLE_PASS' || demo.genesis !== report.genesis || demo.config !== report.config ||
    demo.prices !== report.prices || demo.intent !== report.intent_nonce_0 || demo.priceLabel !== report.price_label ||
    !Array.isArray(report.limitations) || report.limitations.length < 2 ||
    // The property is that every recorded transaction is a distinct, well-formed signature. The
    // exact count is incidental to how many steps the demo happens to run, so it is a floor.
    signatures.length < 13 || new Set(signatures).size !== signatures.length ||
    signatures.some(signature => typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature))) {
  throw new Error('T06 local evidence identity, hashes, transaction signatures, or test-price labels do not match');
}
const seenFailures = new Map((report.negative_cases ?? []).map(row => [row.label, row]));
const transcriptFailures = new Map((demo.negativeResults ?? []).map(row => [row.label, row]));
for (const [label, error] of requiredFailures) {
  const rowLabel = label === 'third-leg-output-above-maximum' ? 'third-leg-output-bound-rollback' : label;
  const row = seenFailures.get(rowLabel);
  if (!row || row.error !== error) throw new Error(`T06 required negative case missing or mismatched: ${label}`);
  const transcriptLabel = label === 'third-leg-output-above-maximum' ? 'third-leg-output-bound-rollback' : label;
  const transcript = transcriptFailures.get(transcriptLabel);
  if (!transcript || !transcript.log?.includes(`Program ${report.program_id} invoke [1]`) ||
      !transcript.log?.includes(`Program ${report.program_id} failed:`)) throw new Error(`T06 captured runtime transcript missing for ${label}`);
  if (error === 'already in use' ? !transcript.log.includes('already in use') : !transcript.log.includes(`Error Code: ${error}`)) {
    throw new Error(`T06 captured runtime error differs for ${label}`);
  }
}
for (const label of ['third-leg-output-above-maximum', 'third-leg-output-below-minimum']) {
  const row = seenFailures.get(label === 'third-leg-output-above-maximum' ? 'third-leg-output-bound-rollback' : label);
  if (row.successful_simulated_transfer_cpis !== 2 || row.balances_unchanged !== true) {
    throw new Error(`${label} does not prove atomic rollback after two successful token CPIs`);
  }
  const transcript = transcriptFailures.get(label === 'third-leg-output-above-maximum' ? 'third-leg-output-bound-rollback' : label);
  if ((transcript?.log?.match(/Instruction: TransferChecked/g) ?? []).length !== 2) {
    throw new Error(`${label} transcript does not show the two successful simulated transfer CPIs`);
  }
}
for (const field of ['funding_raw_amounts', 'source_before_raw', 'settle_outputs_raw', 'cancel_withdrawals_raw', 'settled_source_raw_after', 'cancelled_source_raw_after']) {
  if (!Array.isArray(report[field]) || report[field].length !== 3 || report[field].some(value => !/^(0|[1-9][0-9]*)$/.test(value))) {
    throw new Error(`T06 malformed three-asset amount evidence: ${field}`);
  }
}
if (JSON.stringify(report.funding_raw_amounts) !== JSON.stringify(report.settle_outputs_raw) ||
    JSON.stringify(report.funding_raw_amounts) !== JSON.stringify(report.cancel_withdrawals_raw) ||
    JSON.stringify(report.source_before_raw) !== JSON.stringify(report.settled_source_raw_after) ||
    JSON.stringify(report.source_before_raw) !== JSON.stringify(report.cancelled_source_raw_after) ||
    report.cancel_moved_tokens !== false || report.settled_intent_status !== 'Settled' || report.cancelled_intent_status !== 'Cancelled' ||
    report.cancellation_after_expiry !== true || !/^[1-9][0-9]*$/.test(report.expired_at_unix_seconds ?? '') ||
    JSON.stringify(report.settled_vault_raw_after) !== '["0","0","0"]' || JSON.stringify(report.cancelled_vault_raw_after) !== '["0","0","0"]' ||
    BigInt(report.settled_close_rent_reclaimed_lamports) <= 0n || BigInt(report.cancelled_close_rent_reclaimed_lamports) <= 0n ||
    // The final nonce is however many intents this run funded; what matters is that it advanced
    // and that no intent is left active or claiming.
    !/^[1-9][0-9]*$/.test(report.final_owner_nonce ?? '') || BigInt(report.final_owner_nonce) < 2n ||
    report.active_intent_cleared !== true || report.outstanding_claim_intents !== '0' ||
    !/^[1-9][0-9]*$/.test(report.snapshot_sequence ?? '') || demo.lifecycle?.cancellationAfterExpiry !== true ||
    demo.lifecycle?.activeIntentCleared !== true || demo.lifecycle?.outstandingClaimIntents !== '0' ||
    JSON.stringify(demo.lifecycle?.settleOutputs) !== JSON.stringify(report.settle_outputs_raw) ||
    JSON.stringify(demo.lifecycle?.cancelledWithdrawals) !== JSON.stringify(report.cancel_withdrawals_raw)) {
  throw new Error('T06 lifecycle amounts, rent recovery, or terminal-state invariants do not hold');
}
console.log(JSON.stringify({ status: 'PASS', task: 'T06', cluster: report.cluster, mandatory_negative_cases: requiredFailures.size,
  transaction_signatures: signatures.length, settlement_rollback_cpis_per_case: 2, final_nonce: report.final_owner_nonce,
  outstanding_claim_intents: report.outstanding_claim_intents, demo_transcript_sha256: report.demo_output_sha256 }, null, 2));
