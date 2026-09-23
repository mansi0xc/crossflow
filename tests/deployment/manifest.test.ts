import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, test } from 'vitest';
import { APPROVED_DEVNET_INITIALIZER, CROSSFLOW_PROGRAM_ID, DEVNET_GENESIS, assertPreparedDeploymentManifest, prepareDeploymentManifest } from '../../scripts/deployment-manifest.js';
import { toHex } from '../../packages/contracts/src/index.js';

const frozen = JSON.parse(readFileSync('docs/spec/wire-vectors.json', 'utf8'));
const program = new PublicKey(CROSSFLOW_PROGRAM_ID);
const genesis = new PublicKey(DEVNET_GENESIS);
const wallet = new PublicKey(APPROVED_DEVNET_INITIALIZER);
const deploymentId = 'ab'.repeat(32);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(deploymentId, 'hex')], program);
function candidate() {
  const policy = structuredClone(frozen.policy);
  policy.genesis = toHex(genesis.toBytes());
  policy.program_id = toHex(program.toBytes());
  policy.config_address = toHex(config.toBytes());
  policy.fixture_publisher = toHex(wallet.toBytes());
  return {
    schema_version: '1', cluster: 'devnet', program_id: CROSSFLOW_PROGRAM_ID, genesis: DEVNET_GENESIS,
    deployment_id: deploymentId, expected_initializer: APPROVED_DEVNET_INITIALIZER,
    expected_initial_admin: APPROVED_DEVNET_INITIALIZER, fixture_publisher: APPROVED_DEVNET_INITIALIZER, policy,
  };
}

describe('public deployment manifest preparation', () => {
  test('derives exact config PDA and canonical initial policy', async () => {
    const manifest = await prepareDeploymentManifest(candidate(), DEVNET_GENESIS);
    expect(manifest.config_address).toBe(config.toBase58());
    expect(manifest.policy_bytes_hex).toHaveLength(1304);
    expect(manifest.initial_policy_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.expected_initializer).toBe(APPROVED_DEVNET_INITIALIZER);
    await expect(assertPreparedDeploymentManifest(manifest, DEVNET_GENESIS)).resolves.toEqual(manifest);
  });
  test('stored manifest cannot substitute derived address, hash or bytes', async () => {
    const valid = await prepareDeploymentManifest(candidate(), DEVNET_GENESIS);
    for (const [key, replacement] of [['config_address', CROSSFLOW_PROGRAM_ID], ['initial_policy_hash', '00'.repeat(32)], ['policy_bytes_hex', 'ff'.repeat(652)]] as const) {
      await expect(assertPreparedDeploymentManifest({ ...valid, [key]: replacement }, DEVNET_GENESIS)).rejects.toThrow(key);
    }
  });
  test('rejects altered network, signer and fixture bindings', async () => {
    const wrongGenesis = candidate(); wrongGenesis.genesis = CROSSFLOW_PROGRAM_ID;
    await expect(prepareDeploymentManifest(wrongGenesis, DEVNET_GENESIS)).rejects.toThrow(/genesis/);
    const wrongAdmin = candidate(); wrongAdmin.expected_initial_admin = CROSSFLOW_PROGRAM_ID;
    await expect(prepareDeploymentManifest(wrongAdmin, DEVNET_GENESIS)).rejects.toThrow(/authority/);
    const wrongPublisher = candidate(); wrongPublisher.policy.fixture_publisher = '11'.repeat(32);
    await expect(prepareDeploymentManifest(wrongPublisher, DEVNET_GENESIS)).rejects.toThrow(/publisher/);
    const wrongConfig = candidate(); wrongConfig.policy.config_address = '22'.repeat(32);
    await expect(prepareDeploymentManifest(wrongConfig, DEVNET_GENESIS)).rejects.toThrow(/domain/);
  });
  test('rejects caller-selected modes and missing/extra identities', async () => {
    const pyth = candidate(); pyth.policy.oracle_mode = '1';
    await expect(prepareDeploymentManifest(pyth, DEVNET_GENESIS)).rejects.toThrow(/fixture/);
    const extra = { ...candidate(), private_key: 'forbidden' };
    await expect(prepareDeploymentManifest(extra, DEVNET_GENESIS)).rejects.toThrow(/extra/);
    const missing = candidate(); missing.deployment_id = '00'.repeat(32);
    await expect(prepareDeploymentManifest(missing, DEVNET_GENESIS)).rejects.toThrow(/deployment_id/);
  });
});
