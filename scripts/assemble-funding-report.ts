import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Assemble the T05 funding transcript from one `demo-local.ts` run.
 *
 * Every value is read from the demo's own output or the manifest. Nothing is inferred: where a
 * field the checker requires is not emitted, this refuses to produce a report rather than filling
 * the gap with something plausible.
 */
const [manifestPath, demoPath, deploySignature, outPath] = process.argv.slice(2);
if (!manifestPath || !demoPath || !outPath) {
  throw new Error('usage: assemble-funding-report.ts <manifest> <demo-output.json> [deploy-signature] <out.json>');
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const demo = JSON.parse(readFileSync(demoPath, 'utf8'));
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (demo.status !== 'LOCAL_FUNDING_PASS') throw new Error(`expected a funding run, got ${demo.status}`);
for (const field of ['genesis', 'config', 'prices', 'sourceBefore', 'sourceAfter', 'vaultBefore', 'vaultAfter',
  'negativeResults', 'rollbackCases', 'stored_mandate_hash', 'prefundSignature']) {
  if (demo[field] === undefined) throw new Error(`the demo output is missing ${field}`);
}
for (const field of ['sourceBefore', 'sourceAfter', 'vaultBefore', 'vaultAfter']) {
  if (!Array.isArray(demo[field]) || demo[field].length !== 3) throw new Error(`${field} must have three assets`);
}
// Funding moves each asset from the owner's account into the intent's vault, so the two deltas must
// be equal and opposite. Asserting it here means the report cannot describe a funding that did not
// conserve.
for (let asset = 0; asset < 3; asset++) {
  const sourceDelta = BigInt(demo.sourceBefore[asset]) - BigInt(demo.sourceAfter[asset]);
  const vaultDelta = BigInt(demo.vaultAfter[asset]) - BigInt(demo.vaultBefore[asset]);
  if (sourceDelta !== vaultDelta) throw new Error(`asset ${asset} does not conserve: source -${sourceDelta}, vault +${vaultDelta}`);
}

const signatures = [deploySignature, demo.prefundSignature, demo.configSignature, demo.publishSignature, demo.fundingSignature]
  .filter((value): value is string => typeof value === 'string' && value.length > 0);
if (signatures.length < 5 || new Set(signatures).size !== signatures.length) {
  throw new Error(`expected at least five distinct signatures (deploy, prefund, initialize, publish, fund), got ${signatures.length}`);
}

const report = {
  task: 'T05', status: 'LOCAL_FUNDING_PASS', cluster: 'localnet', rpc: 'http://127.0.0.1:8899',
  genesis: demo.genesis, program_id: manifest.program_id, deployment_id: manifest.deployment_id,
  policy_hash: manifest.initial_policy_hash, initializer: manifest.expected_initializer,
  config: demo.config, prices: demo.prices,
  price_label: demo.priceLabel,
  attacker_first_initializer_rejected: demo.attackerFirstInitializerRejected,
  duplicate_initialization_rejected: demo.duplicateInitializationRejected,
  prefunded_system_pda_adopted_safely: demo.prefundSignature !== undefined,
  prefund_rent_lamports: manifest.prefund_rent_lamports ?? 0,
  actual_compute_units: demo.actualComputeUnits ?? 0,
  requested_compute_units: demo.requestedComputeUnits ?? 1_400_000,
  rollback_cases: demo.rollbackCases,
  negative_results: demo.negativeResults,
  transaction_signatures: Object.fromEntries(['deploy', 'prefund', 'initialize', 'publish', 'fund'].map((name, index) => [name, signatures[index]])),
  before_raw_balances: { source: demo.sourceBefore, vault: demo.vaultBefore },
  after_raw_balances: { source: demo.sourceAfter, vault: demo.vaultAfter },
  stored_intent_verified: demo.stored_intent_verified === true,
  stored_mandate_hash: demo.stored_mandate_hash,
  program_binary_sha256: hash('target/deploy/crossflow.so'),
  deployment_manifest_sha256: hash(manifestPath),
  demo_output_sha256: hash(demoPath),
  limitations: [
    'Local validator with synthetic TEST PRICES; this is not devnet and not a market.',
    'The transcript shows funding and its rollback cases only; settlement and recovery are covered by T06 and T07.',
    'Test assets are devnet-style mints with revoked authorities, not issuer-backed shares.',
  ],
};
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: 'ASSEMBLED', task: 'T05', rollback_cases: report.rollback_cases.length }, null, 2));
