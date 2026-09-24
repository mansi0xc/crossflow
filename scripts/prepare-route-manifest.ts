import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { toHex } from '../packages/contracts/src/index.js';
import { CROSSFLOW_PROGRAM_ID, prepareDeploymentManifest } from './deployment-manifest.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const args = process.argv.slice(2);
if (args.length !== 7) {
  throw new Error('usage: tsx scripts/prepare-route-manifest.ts <rpc> <initializer> <cash> <stock1> <stock2> <venue-program> <out.json>');
}
const [rpc, initializerText, ...rest] = args;
const output = rest.pop()!;
const venueProgramText = rest.pop()!;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('local validator RPC only');
if (existsSync(output)) throw new Error('refusing to overwrite an existing deployment identity');
const initializer = new PublicKey(initializerText);
const mints = rest.map(text => new PublicKey(text));
if (mints.length !== 3 || new Set(mints.map(mint => mint.toBase58())).size !== 3) throw new Error('three distinct mints required');
for (let i = 1; i < 3; i++) {
  if (Buffer.compare(mints[i - 1].toBytes(), mints[i].toBytes()) >= 0) throw new Error('mints must be supplied in ascending raw-byte order, with the cash mint first');
}
const venueProgram = new PublicKey(venueProgramText);
if (venueProgram.equals(new PublicKey(CROSSFLOW_PROGRAM_ID))) throw new Error('the venue must be a distinct program');
const connection = new Connection(rpc, 'confirmed');
const genesis = await connection.getGenesisHash();
const mintAccounts = await connection.getMultipleAccountsInfo(mints, 'confirmed');
for (let i = 0; i < 3; i++) {
  const account = mintAccounts[i];
  if (!account || !account.owner.equals(TOKEN_PROGRAM) || account.data.length !== 82 ||
      account.data.readUInt32LE(0) !== 0 || account.data.readUInt32LE(46) !== 0 ||
      account.data[44] !== 6 || account.data[45] !== 1) {
    throw new Error(`mint ${i} must be an initialized legacy SPL mint with revoked authorities`);
  }
}

// The route identity is derived, exactly as the program re-derives it during policy parsing.
const [pool] = PublicKey.findProgramAddressSync(
  [Buffer.from('pool'), mints[0].toBuffer(), mints[1].toBuffer(), mints[2].toBuffer()], venueProgram);
const vaults = mints.map(mint => PublicKey.findProgramAddressSync(
  [pool.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0]);

const source = JSON.parse(readFileSync('docs/spec/wire-vectors.json', 'utf8'));
const policy = structuredClone(source.policy);
const deploymentId = randomBytes(32).toString('hex');
const program = new PublicKey(CROSSFLOW_PROGRAM_ID);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(deploymentId, 'hex')], program);
policy.genesis = toHex(new PublicKey(genesis).toBytes());
policy.program_id = toHex(program.toBytes());
policy.config_address = toHex(config.toBytes());
policy.fixture_publisher = toHex(initializer.toBytes());
policy.route_kind = '1';
policy.route_program = toHex(venueProgram.toBytes());
policy.pool = toHex(pool.toBytes());
policy.pool_authority = toHex(pool.toBytes());
policy.route_vaults = vaults.map(vault => toHex(vault.toBytes()));
policy.max_route_legs = '2';
for (let i = 0; i < 3; i++) policy.assets[i].mint = toHex(mints[i].toBytes());

const manifest = await prepareDeploymentManifest({
  schema_version: '1', cluster: 'localnet', program_id: CROSSFLOW_PROGRAM_ID, genesis,
  deployment_id: deploymentId, expected_initializer: initializer.toBase58(),
  expected_initial_admin: initializer.toBase58(), fixture_publisher: initializer.toBase58(), policy,
}, genesis);
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, cluster: manifest.cluster, genesis, config: manifest.config_address,
  initializer: manifest.expected_initializer, mints: mints.map(mint => mint.toBase58()),
  route_program: venueProgram.toBase58(), pool: pool.toBase58(), route_vaults: vaults.map(vault => vault.toBase58()),
  policyHash: manifest.initial_policy_hash }, null, 2));
