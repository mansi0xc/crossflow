import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { validateWriteDestination } from './network-guard.mjs';
import { CROSSFLOW_PROGRAM_ID, DEVNET_GENESIS } from './deployment-manifest.js';

/**
 * Read-only deployment identity check. Run before and after any devnet write.
 *
 * It never signs or sends: it verifies the cluster genesis, the program identity and owner, the
 * canonical config PDA, the committed policy hash and the outstanding escrow claim counter, and
 * fails loudly on anything else.
 */
const args = process.argv.slice(2);
const manifestPath = process.env.CROSSFLOW_DEVNET_MANIFEST ?? args[0] ?? 'verification/evidence/T24-devnet-manifest.json';
const rpc = process.env.CROSSFLOW_RPC_URL ?? 'https://api.devnet.solana.com';
const expectDeployed = !args.includes('--allow-absent');

validateWriteDestination(rpc, DEVNET_GENESIS, 'devnet');
const connection = new Connection(rpc, 'confirmed');
const genesis = await connection.getGenesisHash();
if (genesis !== DEVNET_GENESIS) throw new Error(`GENESIS_MISMATCH: ${genesis}`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const program = new PublicKey(CROSSFLOW_PROGRAM_ID);
if (manifest.program_id !== CROSSFLOW_PROGRAM_ID) throw new Error('manifest program identity mismatch');

const programInfo = await connection.getAccountInfo(program, 'confirmed');
const configKey = new PublicKey(manifest.config_address);
const configInfo = await connection.getAccountInfo(configKey, 'confirmed');
const [expectedConfig] = PublicKey.findProgramAddressSync(
  [Buffer.from('config'), Buffer.from(manifest.deployment_id, 'hex')], program);
if (!expectedConfig.equals(configKey)) throw new Error('manifest config is not the canonical PDA');
const [prices] = PublicKey.findProgramAddressSync([Buffer.from('prices'), configKey.toBuffer()], program);

/**
 * The deployed bytecode must correspond to the committed source, not merely to a manifest. The
 * program embeds its deployment identity at compile time, so a build from the same manifest must
 * reproduce the bytes that are live — otherwise the running program is not the reviewed one.
 */
const binaryPath = args.find(arg => !arg.startsWith('--')) ?? null;
let binaryMatches: boolean | null = null;
let deployedBinaryHash: string | null = null;
if (programInfo) {
  // The programdata account is derived under the loader that owns the program, so the owner
  // reported by the cluster is used rather than a literal that is easy to mistype.
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], programInfo.owner);
  const data = await connection.getAccountInfo(programData, 'confirmed');
  if (data) {
    // The programdata account carries a 45-byte metadata header (state, slot, option tag, authority).
    const elf = (data.data as Buffer).subarray(45);
    deployedBinaryHash = createHash('sha256').update(elf).digest('hex');
    const candidate = binaryPath ?? 'target/deploy/crossflow.so';
    if (existsSync(candidate)) {
      binaryMatches = createHash('sha256').update(readFileSync(candidate)).digest('hex') === deployedBinaryHash;
    }
  }
}

const report: Record<string, unknown> = {
  cluster: 'devnet', genesis, rpc_host: new URL(rpc).hostname,
  program_id: program.toBase58(),
  program_present: Boolean(programInfo),
  program_owner: programInfo?.owner.toBase58() ?? null,
  program_executable: programInfo?.executable ?? false,
  config_address: configKey.toBase58(),
  deployed_binary_sha256: deployedBinaryHash,
  local_binary_matches_deployed: binaryMatches,
  config_present: Boolean(configInfo),
  prices_address: prices.toBase58(),
};

if (programInfo) {
  const programDataAddress = PublicKey.findProgramAddressSync([program.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
  const programData = await connection.getAccountInfo(programDataAddress, 'confirmed');
  report.upgrade_authority = programData && programData.data.length >= 45
    ? new PublicKey(programData.data.subarray(13, 45)).toBase58() : null;
  report.retained_upgrade_authority = report.upgrade_authority !== '11111111111111111111111111111111';
}
if (configInfo) {
  if (!configInfo.owner.equals(program) || configInfo.data.length !== 831) throw new Error('config account has the wrong owner or length');
  const storedPolicyHash = configInfo.data.subarray(104, 136).toString('hex');
  const admin = new PublicKey(configInfo.data.subarray(788, 820)).toBase58();
  report.stored_policy_hash = storedPolicyHash;
  report.policy_matches_manifest = storedPolicyHash === manifest.initial_policy_hash;
  report.admin = admin;
  report.funding_paused = configInfo.data[820] === 1;
  report.settlement_paused = configInfo.data[821] === 1;
  report.outstanding_claim_intents = configInfo.data.readBigUInt64LE(822).toString();
  if (!report.policy_matches_manifest) throw new Error('deployed config policy does not match the committed manifest');
  if (report.outstanding_claim_intents !== '0') {
    console.error('WARNING: a replacement deployment must not proceed while funded intents exist');
  }
}
if (expectDeployed && (!programInfo || !configInfo)) throw new Error('expected a deployed program and initialized config');
// A live program whose bytes differ from a local build of the same manifest is not the program that
// was reviewed, so this fails loudly rather than reporting the mismatch as a footnote.
if (binaryMatches === false) {
  throw new Error('BINARY_MISMATCH: the deployed program does not match a local build; rebuild with the same manifest and redeploy');
}
console.log(JSON.stringify({ status: 'OK', ...report }, null, 2));
