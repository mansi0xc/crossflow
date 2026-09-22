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
  assert.throws(() => assertFreshOutput('workspace', 'PASS', '', process.cwd()), /mandatory tests/);
  assert.throws(() => assertFreshOutput('cargo-test', 'Finished successfully', '', process.cwd()), /Rust test/);
  assert.throws(() => assertFreshOutput('json-pass', '{"status":"PASS","positive_vectors":0}', '', process.cwd()), /missing required/);
});
test('skipped or failed mandatory tests are rejected', () => {
  assert.throws(() => assertFreshOutput('workspace', 'ℹ pass 2\nℹ skipped 1\nTests 2 passed', '', process.cwd()), /mandatory tests/);
  assert.throws(() => assertFreshOutput('workspace', 'ℹ pass 2\nℹ fail 1\nTests 2 passed', '', process.cwd()), /mandatory tests/);
});
test('mainnet and parent path in manifest are rejected', () => {
  assert.throws(() => assertManifest({ ...base, checks: [{ name: 'a', kind: 'workspace', command: 'node', args: ['--url', 'https://api.mainnet-beta.solana.com'] }] }, 'T04'), /mainnet/);
  assert.throws(() => assertManifest({ ...base, sourceFiles: ['../outside'] }, 'T04'), /unsafe/);
});
