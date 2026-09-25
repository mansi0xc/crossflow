import { readFileSync } from 'node:fs';

const evidence = JSON.parse(readFileSync('verification/evidence/T05-local-runtime.json', 'utf8'));
const requiredRollbacks = ['one-raw-unit-reference-mismatch', 'insufficient-source-balance', 'substituted-source-ata', 'substituted-configured-mint', 'wrong-funder-signer', 'duplicate-active-intent-new-nonce', 'duplicate-intent-replay'];
const expectedLog = {
  'attacker-first-initializer': /Error Code: Initializer/,
  'duplicate-initialization': /already in use/,
  'one-raw-unit-reference-mismatch': /Error Code: ReferenceMove/,
  'insufficient-source-balance': /Error Code: InsufficientFunds/,
  'substituted-source-ata': /Error Code: (AccountOwnedByWrongProgram|ConstraintAssociated)/,
  'substituted-configured-mint': /Error Code: (ConstraintAssociated|Mint)/,
  'wrong-funder-signer': /Error Code: (ConstraintSeeds|Nonce)/,
  'duplicate-active-intent-new-nonce': /Error Code: Nonce/,
  'duplicate-intent-replay': /already in use/,
};
for (const [label, expected] of Object.entries(expectedLog)) {
  const item = evidence.negative_results?.find((row) => row.label === label);
  if (!item || !item.log.includes('Program CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh failed:') || !expected.test(item.log)) {
    throw new Error(`local runtime evidence lacks expected program rejection log for ${label}`);
  }
}
if (evidence.task !== 'T05' || evidence.status !== 'LOCAL_FUNDING_PASS' || evidence.cluster !== 'localnet' ||
    evidence.genesis !== '87iXpApKAgTJWXhqcRMGHky12KK84bKrX5x1XRVtKWqg' ||
    evidence.program_id !== 'CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh' ||
    evidence.attacker_first_initializer_rejected !== true || evidence.duplicate_initialization_rejected !== true || evidence.prefunded_system_pda_adopted_safely !== true ||
    evidence.prefund_rent_lamports <= 0 || evidence.actual_compute_units <= 0 || evidence.actual_compute_units > evidence.requested_compute_units ||
    requiredRollbacks.some((name) => !evidence.rollback_cases.includes(name)) ||
    // As in T06: distinctness and well-formedness matter, the exact count does not.
    Object.keys(evidence.transaction_signatures).length < 5 ||
    new Set(Object.values(evidence.transaction_signatures)).size !== Object.keys(evidence.transaction_signatures).length ||
    evidence.before_raw_balances.source.some((value, i) => BigInt(value) - BigInt(evidence.after_raw_balances.source[i]) !== BigInt(evidence.after_raw_balances.vault[i]) - BigInt(evidence.before_raw_balances.vault[i])) ||
    evidence.stored_intent_verified !== true || !/^[0-9a-f]{64}$/.test(evidence.stored_mandate_hash) ||
    !evidence.price_label.startsWith('TEST PRICES')) throw new Error('local runtime evidence failed required assertions');
console.log(JSON.stringify(evidence));
