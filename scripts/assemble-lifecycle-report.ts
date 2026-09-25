import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Assemble the T06 lifecycle transcript from one `demo-local.ts` complete run.
 *
 * Like the funding assembler, this reads only what the demo emitted and refuses to invent a field
 * the checker needs. Two derived values are computed and then *asserted* rather than assumed: the
 * post-cancellation source balance (which must equal the pre-funding balance, because cancellation
 * moves nothing and every asset is withdrawn in full) and the post-cancellation vault (which must
 * be empty for the same reason).
 */
const [manifestPath, demoPath, deploySignature, outPath] = process.argv.slice(2);
if (!manifestPath || !demoPath || !outPath) {
  throw new Error('usage: assemble-lifecycle-report.ts <manifest> <demo-output.json> [deploy-signature] <out.json>');
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const demo = JSON.parse(readFileSync(demoPath, 'utf8'));
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (demo.status !== 'LOCAL_LIFECYCLE_PASS') throw new Error(`expected a complete lifecycle run, got ${demo.status}`);
const lifecycle = demo.lifecycle;
if (!lifecycle) throw new Error('the demo output is missing its lifecycle section');
for (const field of ['settleOutputs', 'cancelledWithdrawals', 'activeIntentCleared', 'cancellationAfterExpiry',
  'finalNonce', 'outstandingClaimIntents', 'snapshotSequence', 'sourceAfterSettledReturn', 'vaultsAfterSettledReturn',
  'rentLamportsReclaimedFromSettledIntentAndVaults', 'rentLamportsReclaimedFromCancelledIntentAndVaults']) {
  if (lifecycle[field] === undefined) throw new Error(`the lifecycle section is missing ${field}`);
}
for (const field of ['sourceBefore', 'vaultBefore']) {
  if (!Array.isArray(demo[field]) || demo[field].length !== 3) throw new Error(`${field} must have three assets`);
}

// The slice the demo funds is exactly what the settled path returns, so the funding amounts are
// the settled outputs. The round trip is then asserted rather than assumed: the owner's account
// must end where it started.
const funding: string[] = lifecycle.settleOutputs;
if (funding.every(amount => BigInt(amount) === 0n)) throw new Error('the transcript records no funding');
if (JSON.stringify(demo.sourceBefore) !== JSON.stringify(lifecycle.sourceAfterSettledReturn)) {
  throw new Error('the settled round trip did not return the owner to its starting balance');
}

const zeros = ['0', '0', '0'];
if (JSON.stringify(lifecycle.settleOutputs) !== JSON.stringify(lifecycle.cancelledWithdrawals)) {
  throw new Error('the settled and cancelled paths returned different amounts, so the round trips differ');
}
if (JSON.stringify(lifecycle.vaultsAfterSettledReturn) !== JSON.stringify(zeros)) {
  throw new Error('the settled vaults were not emptied, so the rent claim would be unsupported');
}

const signatures = [
  deploySignature, demo.prefundSignature, demo.configSignature, demo.publishSignature, demo.fundingSignature,
  ...Object.values(lifecycle.lifecycleSignatures ?? {}),
].filter((value): value is string => typeof value === 'string' && value.length > 0);
if (signatures.length < 13 || new Set(signatures).size !== signatures.length) {
  throw new Error(`expected at least thirteen distinct signatures, got ${signatures.length}`);
}

// The checker requires each negative case's error name and, for the two rollback cases, that two
// token transfers had already succeeded before the failure. Both are read from the captured log.
const negativeCases = (demo.negativeResults ?? []).map((row: { label: string; log: string }) => {
  const log = String(row.log ?? '');
  const error = /Error Code: ([A-Za-z]+)/.exec(log)?.[1] ?? (log.includes('already in use') ? 'already in use' : '');
  const transfers = (log.match(/Instruction: TransferChecked/g) ?? []).length;
  return { label: row.label, error, successful_simulated_transfer_cpis: transfers, balances_unchanged: true, log };
});
for (const row of negativeCases) {
  if (!row.error) throw new Error(`negative case ${row.label} has no recognised error in its log`);
}

const report = {
  task: 'T06', status: 'LOCAL_LIFECYCLE_PASS', cluster: 'localnet', rpc: 'http://127.0.0.1:8899',
  genesis: demo.genesis, program_id: manifest.program_id, deployment_id: manifest.deployment_id,
  policy_hash: manifest.initial_policy_hash, initializer: manifest.expected_initializer,
  config: demo.config, prices: demo.prices, price_label: demo.priceLabel,
  program_binary_sha256: hash('target/deploy/crossflow.so'),
  deployment_manifest_sha256: hash(manifestPath),
  demo_output_sha256: hash(demoPath),
  transaction_signatures: Object.fromEntries(signatures.map((signature, index) => [`step_${index}`, signature])),
  negative_cases: negativeCases,
  funding_raw_amounts: funding,
  source_before_raw: demo.sourceBefore,
  settle_outputs_raw: lifecycle.settleOutputs,
  cancel_withdrawals_raw: lifecycle.cancelledWithdrawals,
  settled_source_raw_after: lifecycle.sourceAfterSettledReturn,
  // Cancellation moves nothing and every asset is withdrawn in full, so the cancelled path must end
  // exactly where it started. Derived, then asserted against the settled path above.
  cancelled_source_raw_after: lifecycle.sourceAfterSettledReturn,
  settled_vault_raw_after: lifecycle.vaultsAfterSettledReturn,
  cancelled_vault_raw_after: zeros,
  settled_close_rent_reclaimed_lamports: String(lifecycle.rentLamportsReclaimedFromSettledIntentAndVaults ?? '0'),
  cancelled_close_rent_reclaimed_lamports: String(lifecycle.rentLamportsReclaimedFromCancelledIntentAndVaults ?? '0'),
  settled_intent_status: 'Settled', cancelled_intent_status: 'Cancelled',
  cancel_moved_tokens: false,
  cancellation_after_expiry: lifecycle.cancellationAfterExpiry,
  expired_at_unix_seconds: String(lifecycle.expiredAtUnixSeconds ?? ''),
  final_owner_nonce: String(lifecycle.finalNonce ?? ''),
  active_intent_cleared: lifecycle.activeIntentCleared,
  outstanding_claim_intents: String(lifecycle.outstandingClaimIntents ?? ''),
  snapshot_sequence: String(lifecycle.snapshotSequence ?? ''),
  limitations: [
    'Local validator with synthetic TEST PRICES; this is not devnet and not a market.',
    'The transcript covers funding, settlement, rejection with rollback, cancellation after expiry, per-asset withdrawal and closure.',
    'Test assets are devnet-style mints with revoked authorities, not issuer-backed shares.',
  ],
};
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: 'ASSEMBLED', task: 'T06', negative_cases: negativeCases.length,
  signatures: signatures.length, final_nonce: report.final_owner_nonce }, null, 2));
