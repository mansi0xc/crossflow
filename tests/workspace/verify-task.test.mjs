import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { assertManifest, assertFreshOutput } from '../../scripts/verify-task.mjs';

const base = { task: 'T04', sourceFiles: ['package.json'], checks: [{ name: 'a', kind: 'workspace', command: 'node', args: ['x'] }] };
test('missing task selector, source, checks and duplicate checks fail closed', () => {
  assert.throws(() => assertManifest(base, ''), /selector/);
  assert.throws(() => assertManifest({ ...base, sourceFiles: [] }, 'T04'), /source/);
  assert.throws(() => assertManifest({ ...base, checks: [] }, 'T04'), /zero/);
  assert.throws(() => assertManifest({ ...base, checks: [base.checks[0], base.checks[0]] }, 'T04'), /duplicate/);
});
test('forged success text without selected tests is rejected', () => {
  assert.throws(() => assertFreshOutput('locked-install', 'Already up to date', '', process.cwd()), /locked install/);
  assert.throws(() => assertFreshOutput('vitest', 'PASS', '', process.cwd()), /Vitest selection/);
  assert.throws(() => assertFreshOutput('workspace', 'PASS', '', process.cwd()), /mandatory tests/);
  assert.throws(() => assertFreshOutput('cargo-test', 'Finished successfully', '', process.cwd()), /Rust test/);
  assert.throws(() => assertFreshOutput('json-pass', '{"status":"PASS","positive_vectors":0}', '', process.cwd()), /missing required/);
});
test('locked install requires frozen-lockfile completion evidence', () => {
  assert.doesNotThrow(() => assertFreshOutput('locked-install', 'Lockfile is up to date, resolution step is skipped\nDone in 210ms', '', process.cwd()));
});
test('focused Vitest evidence requires selected passing tests and no skips', () => {
  assert.doesNotThrow(() => assertFreshOutput('vitest', 'Test Files  1 passed (1)\nTests  26 passed (26)', '', process.cwd()));
  assert.throws(() => assertFreshOutput('vitest', 'Test Files  1 passed (1)\nTests  26 passed | 1 skipped', '', process.cwd()), /Vitest selection/);
});
test('skipped or failed mandatory tests are rejected', () => {
  assert.throws(() => assertFreshOutput('workspace', 'ℹ pass 2\nℹ skipped 1\nTests 2 passed', '', process.cwd()), /mandatory tests/);
  assert.throws(() => assertFreshOutput('workspace', 'ℹ pass 2\nℹ fail 1\nTests 2 passed', '', process.cwd()), /mandatory tests/);
});
test('mainnet and parent path in manifest are rejected', () => {
  assert.throws(() => assertManifest({ ...base, checks: [{ name: 'a', kind: 'workspace', command: 'node', args: ['--url', 'https://api.mainnet-beta.solana.com'] }] }, 'T04'), /mainnet/);
  assert.throws(() => assertManifest({ ...base, sourceFiles: ['../outside'] }, 'T04'), /unsafe/);
});

test('local runtime evidence requires real local identities, guarded rollback and conserved asset deltas', () => {
  const report = { task: 'T05', status: 'LOCAL_FUNDING_PASS', cluster: 'localnet', genesis: '87iXpApKAgTJWXhqcRMGHky12KK84bKrX5x1XRVtKWqg',
    attacker_first_initializer_rejected: true, duplicate_initialization_rejected: true, prefunded_system_pda_adopted_safely: true,
    actual_compute_units: 188730, requested_compute_units: 600000,
    rollback_cases: ['one-raw-unit-reference-mismatch', 'insufficient-source-balance', 'substituted-source-ata', 'substituted-configured-mint', 'wrong-funder-signer', 'duplicate-active-intent-new-nonce', 'duplicate-intent-replay'],
    negative_results: [
      ['attacker-first-initializer', 'Error Code: Initializer'], ['duplicate-initialization', 'account already in use'],
      ['one-raw-unit-reference-mismatch', 'Error Code: ReferenceMove'], ['insufficient-source-balance', 'Error Code: InsufficientFunds'],
      ['substituted-source-ata', 'Error Code: AccountOwnedByWrongProgram'], ['substituted-configured-mint', 'Error Code: ConstraintAssociated'],
      ['wrong-funder-signer', 'Error Code: ConstraintSeeds'], ['duplicate-active-intent-new-nonce', 'Error Code: Nonce'],
      ['duplicate-intent-replay', 'account already in use'],
    ].map(([label, reason]) => ({ label, log: `Program CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh invoke [1]\nProgram log: ${reason}\nProgram CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh failed: custom program error` })),
    stored_intent_verified: true, stored_mandate_hash: 'a'.repeat(64),
    transaction_signatures: { deploy: 'a'.repeat(64), prefund: 'e'.repeat(64), initialize: 'b'.repeat(64), publish: 'c'.repeat(64), fund: 'd'.repeat(64) },
    before_raw_balances: { source: ['100', '20', '30'], vault: ['0', '0', '0'] },
    after_raw_balances: { source: ['90', '18', '27'], vault: ['10', '2', '3'] }, price_label: 'TEST PRICES' };
  assert.doesNotThrow(() => assertFreshOutput('local-runtime', JSON.stringify(report), '', process.cwd()));
  assert.throws(() => assertFreshOutput('local-runtime', JSON.stringify({ ...report, cluster: 'devnet' }), '', process.cwd()), /local runtime/);
  assert.throws(() => assertFreshOutput('local-runtime', JSON.stringify({ ...report, after_raw_balances: { source: ['89', '18', '27'], vault: ['10', '2', '3'] } }), '', process.cwd()), /conservation/);
});
