import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { assertManifest, assertFreshOutput, stripAnsi } from '../../scripts/verify-task.mjs';

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

test('T06 runtime evidence requires both settlement bounds to roll back after prior token CPIs', () => {
  const manifest = { ...base, task: 'T06', checks: [{ name: 'runtime', kind: 't06-runtime', command: 'node', args: ['check.mjs'] }] };
  assert.doesNotThrow(() => assertManifest(manifest, 'T06'));
  assert.doesNotThrow(() => assertFreshOutput('t06-runtime', JSON.stringify({ status: 'PASS', task: 'T06', cluster: 'localnet',
    mandatory_negative_cases: 15, transaction_signatures: 13, settlement_rollback_cpis_per_case: 2,
    final_nonce: '2', outstanding_claim_intents: '0' }), '', process.cwd()));
  assert.throws(() => assertFreshOutput('t06-runtime', JSON.stringify({ status: 'PASS', task: 'T06', cluster: 'devnet',
    mandatory_negative_cases: 15, transaction_signatures: 13, settlement_rollback_cpis_per_case: 2,
    final_nonce: '2', outstanding_claim_intents: '0' }), '', process.cwd()), /incomplete/);
});

test('T07 runtime evidence requires the full lifecycle and source-bound transcript', () => {
  const manifest = { ...base, task: 'T07', checks: [{ name: 'runtime', kind: 't07-runtime', command: 'node', args: ['check.mjs'] }] };
  const report = { status: 'PASS', task: 'T07', cluster: 'localnet',
    genesis: '87iXpApKAgTJWXhqcRMGHky12KK84bKrX5x1XRVtKWqg',
    mandatory_negative_cases: 31, transaction_signatures_count: 27,
    settlement_rollback_cpis_per_case: 2, final_nonce: '3', outstanding_claim_intents: '0',
    demo_transcript_sha256: 'a'.repeat(64), program_binary_sha256: 'b'.repeat(64) };
  assert.doesNotThrow(() => assertManifest(manifest, 'T07'));
  assert.doesNotThrow(() => assertFreshOutput('t07-runtime', JSON.stringify(report), '', process.cwd()));
  assert.throws(() => assertFreshOutput('t07-runtime', JSON.stringify({ ...report, final_nonce: '2' }), '', process.cwd()), /incomplete/);
  assert.throws(() => assertFreshOutput('t07-runtime', JSON.stringify({ ...report, cluster: 'devnet' }), '', process.cwd()), /incomplete/);
});

test('T08 runtime evidence requires old-mint removal before owner closed-vault recovery', () => {
  const manifest = { ...base, task: 'T08', checks: [{ name: 'runtime', kind: 't08-runtime', command: 'node', args: ['check.mjs'] }] };
  const report = { status: 'PASS', task: 'T08', cluster: 'localnet',
    genesis: '87iXpApKAgTJWXhqcRMGHky12KK84bKrX5x1XRVtKWqg', mandatory_negative_cases: 6,
    transaction_signatures_count: 12, old_mint_removed_before_recovery: true,
    recovered_raw: '1000', recovered_vault_rent_lamports: 2039280,
    final_nonce: '1', outstanding_claim_intents: '0',
    hashes: Object.fromEntries(['manifest', 'funding', 'setup', 'recovery', 'binary'].map(k => [k, 'a'.repeat(64)])) };
  assert.doesNotThrow(() => assertManifest(manifest, 'T08'));
  assert.doesNotThrow(() => assertFreshOutput('t08-runtime', JSON.stringify(report), '', process.cwd()));
  assert.throws(() => assertFreshOutput('t08-runtime', JSON.stringify({ ...report, old_mint_removed_before_recovery: false }), '', process.cwd()), /incomplete/);
});

test('T09 runtime evidence requires a three-owner lookup-backed atomic batch', () => {
  const manifest = { ...base, task: 'T09', checks: [{ name: 'runtime', kind: 't09-runtime', command: 'node', args: ['check.mjs'] }] };
  const report = { status: 'PASS', task: 'T09', cluster: 'localnet',
    genesis: '87iXpApKAgTJWXhqcRMGHky12KK84bKrX5x1XRVtKWqg', batch_count: 3,
    mandatory_negative_cases: 14, transaction_signatures_count: 6,
    compute_units: 331_000, serialized_settlement_bytes: 1180, lookup_table_entries: 30,
    final_status: [1, 1, 1],
    hashes: Object.fromEntries(['report', 'manifest', 'binary', 'body', 'env'].map(k => [k, 'b'.repeat(64)])) };
  assert.doesNotThrow(() => assertManifest(manifest, 'T09'));
  assert.doesNotThrow(() => assertFreshOutput('t09-runtime', JSON.stringify(report), '', process.cwd()));
  assert.throws(() => assertFreshOutput('t09-runtime', JSON.stringify({ ...report, final_status: [1, 0, 1] }), '', process.cwd()), /incomplete/);
  assert.throws(() => assertFreshOutput('t09-runtime', JSON.stringify({ ...report, serialized_settlement_bytes: 1400 }), '', process.cwd()), /incomplete/);
  assert.throws(() => assertFreshOutput('t09-runtime', JSON.stringify({ ...report, batch_count: 2 }), '', process.cwd()), /incomplete/);
});

test('T10 runtime evidence requires real measured venue deltas and a labelled synthetic pool', () => {
  const manifest = { ...base, task: 'T10', checks: [{ name: 'runtime', kind: 't10-runtime', command: 'node', args: ['check.mjs'] }] };
  const report = { status: 'PASS', task: 'T10', cluster: 'localnet',
    genesis: '87iXpApKAgTJWXhqcRMGHky12KK84bKrX5x1XRVtKWqg', pool: 'FSyL13FTp3Yrgdo8VWpoNtpL8FS5FcSGL3tdNp1sjw2t',
    mandatory_negative_cases: 7, transaction_signatures_count: 3, compute_units: 41_000,
    quoted_out: '99004', measured_out: '99004',
    hashes: Object.fromEntries(['report', 'env', 'binary'].map(k => [k, 'c'.repeat(64)])) };
  assert.doesNotThrow(() => assertManifest(manifest, 'T10'));
  assert.doesNotThrow(() => assertFreshOutput('t10-runtime', JSON.stringify(report), '', process.cwd()));
  assert.throws(() => assertFreshOutput('t10-runtime', JSON.stringify({ ...report, measured_out: '99005' }), '', process.cwd()), /incomplete/);
  assert.throws(() => assertFreshOutput('t10-runtime', JSON.stringify({ ...report, mandatory_negative_cases: 6 }), '', process.cwd()), /incomplete/);
});

test('colourised test-runner output is interpreted rather than rejected', () => {
  const manifest = { ...base, checks: [{ name: 'focused', kind: 'vitest', command: 'corepack', args: ['pnpm@10.17.1', 'exec', 'vitest', 'run', 'tests/spec/wire-vectors.test.ts'] }] };
  assert.doesNotThrow(() => assertManifest(manifest, 'T04'));
  const coloured = '\u001b[1m\u001b[30m\u001b[46m RUN \u001b[49m\u001b[39m\u001b[22m v5.0.1\n' +
    '\u001b[1m\u001b[32m Test Files \u001b[39m\u001b[22m \u001b[1m\u001b[32m2 passed\u001b[39m\u001b[22m (2)\n' +
    '\u001b[1m\u001b[32m      Tests \u001b[39m\u001b[22m \u001b[1m\u001b[32m18 passed\u001b[39m\u001b[22m (18)\n';
  assert.doesNotThrow(() => assertFreshOutput('vitest', coloured, '', process.cwd()));
  assert.equal(stripAnsi(coloured).includes('\u001b'), false);
  assert.throws(() => assertFreshOutput('vitest', stripAnsi(coloured).replace('18 passed', '17 failed, 1 passed'), '', process.cwd()), /absent, failed or skipped/);
});

test('T16 runtime evidence requires a composed route with intact reserves and measured deltas', () => {
  const manifest = { ...base, task: 'T16', checks: [{ name: 'runtime', kind: 't16-runtime', command: 'node', args: ['check.mjs'] }] };
  const report = { status: 'PASS', task: 'T16', cluster: 'localnet',
    genesis: '87iXpApKAgTJWXhqcRMGHky12KK84bKrX5x1XRVtKWqg',
    mandatory_negative_cases: 6, compute_units: 311_591, serialized_settlement_bytes: 451,
    lookup_table_entries: 43, measured_external_input: '50000', measured_external_output: '493579',
    external_deviation_bps: '128', pools: ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)],
    route: { vaults_are_pool_atas: true },
    hashes: Object.fromEntries(['report', 'manifest', 'binary', 'venue_binary', 'body'].map(k => [k, 'd'.repeat(64)])) };
  assert.doesNotThrow(() => assertManifest(manifest, 'T16'));
  assert.doesNotThrow(() => assertFreshOutput('t16-runtime', JSON.stringify(report), '', process.cwd()));
  assert.throws(() => assertFreshOutput('t16-runtime', JSON.stringify({ ...report, external_deviation_bps: '201' }), '', process.cwd()), /incomplete/);
  assert.throws(() => assertFreshOutput('t16-runtime', JSON.stringify({ ...report, route: { vaults_are_pool_atas: false } }), '', process.cwd()), /incomplete/);
});
