import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { validateWriteDestination } from './network-guard.mjs';
import { toHex } from '../packages/contracts/src/index.js';
import { APPROVED_DEVNET_INITIALIZER, CROSSFLOW_PROGRAM_ID, DEVNET_GENESIS, prepareDeploymentManifest } from './deployment-manifest.js';

/**
 * Prepare the public devnet deployment identity and refuse to proceed on anything else.
 *
 * This script only writes a manifest. It never signs, deploys or transfers: the shell step that
 * follows runs `anchor build` against that manifest and then deploys the reviewed artifact.
 * Every write path re-checks the RPC genesis, the program identity and the approved authority.
 */
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const unknown = args.filter(arg => arg !== '--dry-run');
if (unknown.length) throw new Error(`unknown argument ${unknown[0]}`);
const rpc = process.env.CROSSFLOW_RPC_URL ?? 'https://api.devnet.solana.com';
const outPath = process.env.CROSSFLOW_DEVNET_MANIFEST ?? 'verification/evidence/T24-devnet-manifest.json';

// The reviewed guard rejects a mainnet/testnet hostname, a non-TLS URL and any destination
// other than the exact devnet genesis before a single byte is written.
validateWriteDestination(rpc, DEVNET_GENESIS, 'devnet');
const connection = new Connection(rpc, 'confirmed');
const genesis = await connection.getGenesisHash();
if (genesis !== DEVNET_GENESIS) throw new Error(`GENESIS_MISMATCH: ${genesis} is not the reviewed devnet genesis`);
const program = new PublicKey(CROSSFLOW_PROGRAM_ID);
const authority = new PublicKey(APPROVED_DEVNET_INITIALIZER);
if (!PublicKey.isOnCurve(authority.toBytes())) throw new Error('approved devnet authority is not a wallet key');

const balance = await connection.getBalance(authority, 'confirmed');
const programInfo = await connection.getAccountInfo(program, 'confirmed');
const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;
const deploymentId = existing?.deployment_id ?? randomBytes(32).toString('hex');
if (!/^[0-9a-f]{64}$/.test(deploymentId)) throw new Error('existing deployment identity is malformed');

const envPath = process.env.CROSSFLOW_DEVNET_ENV ?? 'verification/evidence/T24-devnet-env.json';
if (!existsSync(envPath)) throw new Error(`run scripts/devnet-assets.ts first; ${envPath} is missing`);
const env = JSON.parse(readFileSync(envPath, 'utf8'));
if (!Array.isArray(env.mint_public_keys) || env.mint_public_keys.length !== 3) throw new Error('devnet env must name exactly three test mints');
const source = JSON.parse(readFileSync('docs/spec/wire-vectors.json', 'utf8'));
const policy = structuredClone(source.policy);
for (let i = 0; i < 3; i++) policy.assets[i].mint = toHex(new PublicKey(env.mint_public_keys[i]).toBytes());
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(deploymentId, 'hex')], program);
policy.genesis = toHex(new PublicKey(genesis).toBytes());
policy.program_id = toHex(program.toBytes());
policy.config_address = toHex(config.toBytes());
policy.fixture_publisher = toHex(authority.toBytes());

const manifest = await prepareDeploymentManifest({
  schema_version: '1', cluster: 'devnet', program_id: CROSSFLOW_PROGRAM_ID, genesis,
  deployment_id: deploymentId, expected_initializer: APPROVED_DEVNET_INITIALIZER,
  expected_initial_admin: APPROVED_DEVNET_INITIALIZER, fixture_publisher: APPROVED_DEVNET_INITIALIZER, policy,
}, genesis);

const report = {
  cluster: 'devnet', genesis, rpc_host: new URL(rpc).hostname,
  program_id: manifest.program_id, config_address: manifest.config_address,
  deployment_id: manifest.deployment_id, expected_initializer: manifest.expected_initializer,
  authority_balance_lamports: balance,
  program_already_deployed: Boolean(programInfo),
  program_data_length: programInfo?.data.length ?? 0,
  policy_hash: manifest.initial_policy_hash,
  dry_run: dryRun,
};
if (dryRun) {
  console.log(JSON.stringify({ ...report, wrote: false }, null, 2));
} else {
  if (programInfo && existing && existing.initial_policy_hash !== manifest.initial_policy_hash) {
    throw new Error('an existing devnet deployment has a different committed policy; recover outstanding intents before replacing it');
  }
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...report, wrote: outPath }, null, 2));
}
