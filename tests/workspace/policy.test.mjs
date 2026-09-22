import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertNoMainnetWriteTarget, assertPinnedWorkspace, assertNoTrackedSecrets } from '../../scripts/check-workspace.mjs';

test('write destinations reject mainnet, testnet, unknown host and missing URL', () => {
  for (const value of ['', 'https://api.mainnet-beta.solana.com', 'https://api.testnet.solana.com', 'https://unreviewed.example']) {
    assert.throws(() => assertNoMainnetWriteTarget(value));
  }
  assert.doesNotThrow(() => assertNoMainnetWriteTarget('https://api.devnet.solana.com'));
  assert.doesNotThrow(() => assertNoMainnetWriteTarget('http://127.0.0.1:8899'));
});

test('pinning rejects a moving version and mainnet Anchor default', () => {
  const root = mkdtempSync(join(tmpdir(), 'crossflow-check-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@10.17.1', dependencies: { a: '^1.0.0' } }));
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    writeFileSync(join(root, 'Cargo.lock'), 'version = 3\n');
    writeFileSync(join(root, 'Cargo.toml'), '[profile.release]\noverflow-checks = true\n');
    writeFileSync(join(root, 'Anchor.toml'), '[provider]\ncluster = "localnet"\n');
    writeFileSync(join(root, '.env.example'), 'CROSSFLOW_CLUSTER=localnet\nCROSSFLOW_RPC_URL=http://127.0.0.1:8899\n');
    assert.throws(() => assertPinnedWorkspace(root), /unpinned/);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@10.17.1', dependencies: { a: '1.0.0' } }));
    writeFileSync(join(root, 'Anchor.toml'), '[provider]\ncluster = "mainnet"\n');
    assert.throws(() => assertPinnedWorkspace(root), /localnet/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tracked keypair filename is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'crossflow-secret-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'keys'));
    writeFileSync(join(root, 'keys', 'wallet-keypair.json'), '[1,2,3]');
    execFileSync('git', ['add', 'keys/wallet-keypair.json'], { cwd: root });
    assert.throws(() => assertNoTrackedSecrets(root), /tracked signing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
