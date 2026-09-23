import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { toHex } from '../packages/contracts/src/index.js';
import { CROSSFLOW_PROGRAM_ID, prepareDeploymentManifest } from './deployment-manifest.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const args = process.argv.slice(2);
if (args.length !== 6) throw new Error('usage: tsx scripts/prepare-local-manifest.ts <rpc> <initializer> <cash-mint> <stock1-mint> <stock2-mint> <output.json>');
const [rpc, initializerText, ...rest] = args;
const output = rest.pop()!;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('local validator RPC only');
if (existsSync(output)) throw new Error('refusing to overwrite existing deployment identity');
const initializer = new PublicKey(initializerText);
if (!PublicKey.isOnCurve(initializer.toBytes())) throw new Error('initializer must be a wallet key');
const mints = rest.map(text => new PublicKey(text));
if (mints.length !== 3 || new Set(mints.map(m => m.toBase58())).size !== 3) throw new Error('three distinct mints required');
for (let i = 1; i < 3; i++) if (Buffer.compare(Buffer.from(mints[i - 1].toBytes()), Buffer.from(mints[i].toBytes())) >= 0) throw new Error('mints must be supplied in ascending raw-byte order, with the cash mint first');
const connection = new Connection(rpc, 'confirmed');
const genesis = await connection.getGenesisHash();
const mintAccounts = await connection.getMultipleAccountsInfo(mints, 'confirmed');
for (let i = 0; i < 3; i++) {
  const account = mintAccounts[i];
  if (!account || !account.owner.equals(TOKEN_PROGRAM) || account.data.length !== 82 ||
      account.data.readUInt32LE(0) !== 0 || account.data.readUInt32LE(46) !== 0 ||
      account.data[44] !== 6 || account.data[45] !== 1) {
    throw new Error(`mint ${i} must be initialized legacy SPL, 6 decimals, with mint/freeze authorities revoked`);
  }
}
const source = JSON.parse(readFileSync('docs/spec/wire-vectors.json', 'utf8'));
const policy = structuredClone(source.policy);
const deploymentId = randomBytes(32).toString('hex');
const program = new PublicKey(CROSSFLOW_PROGRAM_ID);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(deploymentId, 'hex')], program);
policy.genesis = toHex(new PublicKey(genesis).toBytes());
policy.program_id = toHex(program.toBytes());
policy.config_address = toHex(config.toBytes());
policy.fixture_publisher = toHex(initializer.toBytes());
for (let i = 0; i < 3; i++) policy.assets[i].mint = toHex(mints[i].toBytes());
const manifest = await prepareDeploymentManifest({
  schema_version: '1', cluster: 'localnet', program_id: CROSSFLOW_PROGRAM_ID, genesis,
  deployment_id: deploymentId, expected_initializer: initializer.toBase58(),
  expected_initial_admin: initializer.toBase58(), fixture_publisher: initializer.toBase58(), policy,
}, genesis);
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, cluster: manifest.cluster, genesis, config: manifest.config_address,
  initializer: manifest.expected_initializer, mints: mints.map(m => m.toBase58()), policyHash: manifest.initial_policy_hash }, null, 2));
