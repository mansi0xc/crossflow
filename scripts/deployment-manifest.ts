import { PublicKey } from '@solana/web3.js';
import { policyBytes, sha256Hex, toHex } from '../packages/contracts/src/index.js';

export const CROSSFLOW_PROGRAM_ID = 'CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh';
export const APPROVED_DEVNET_INITIALIZER = 'FSyL13FTp3Yrgdo8VWpoNtpL8FS5FcSGL3tdNp1sjw2t';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

type PublicDeploymentCandidate = {
  schema_version: '1';
  cluster: 'localnet' | 'devnet';
  program_id: string;
  genesis: string;
  deployment_id: string;
  expected_initializer: string;
  expected_initial_admin: string;
  fixture_publisher: string;
  policy: unknown;
};

function exactObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label}: object required`);
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) throw new TypeError(`${label}: missing or extra field`);
  return object;
}

function key(value: unknown, label: string): PublicKey {
  if (typeof value !== 'string') throw new TypeError(`${label}: base58 required`);
  let parsed: PublicKey;
  try { parsed = new PublicKey(value); }
  catch { throw new TypeError(`${label}: invalid public key`); }
  if (parsed.toBase58() !== value || parsed.equals(PublicKey.default)) throw new TypeError(`${label}: noncanonical or zero public key`);
  return parsed;
}

function deploymentId(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value) || /^0+$/.test(value)) throw new TypeError('deployment_id: nonzero lowercase 32-byte hex required');
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

export async function prepareDeploymentManifest(value: unknown, expectedGenesis: string) {
  const raw = exactObject(value, [
    'schema_version', 'cluster', 'program_id', 'genesis', 'deployment_id',
    'expected_initializer', 'expected_initial_admin', 'fixture_publisher', 'policy',
  ], 'deployment') as PublicDeploymentCandidate;
  if (raw.schema_version !== '1' || (raw.cluster !== 'localnet' && raw.cluster !== 'devnet')) throw new TypeError('unsupported deployment schema or cluster');
  const program = key(raw.program_id, 'program_id');
  if (program.toBase58() !== CROSSFLOW_PROGRAM_ID) throw new TypeError('wrong CrossFlow program ID');
  const genesis = key(raw.genesis, 'genesis');
  if (genesis.toBase58() !== expectedGenesis) throw new TypeError('RPC genesis mismatch');
  if (raw.cluster === 'devnet') {
    if (raw.genesis !== DEVNET_GENESIS) throw new TypeError('not the reviewed devnet genesis');
    if (raw.expected_initializer !== APPROVED_DEVNET_INITIALIZER || raw.expected_initial_admin !== APPROVED_DEVNET_INITIALIZER || raw.fixture_publisher !== APPROVED_DEVNET_INITIALIZER) {
      throw new TypeError('devnet authority differs from approved CLI wallet');
    }
  } else if (raw.genesis === DEVNET_GENESIS) throw new TypeError('localnet manifest cannot use devnet genesis');
  const deployment = deploymentId(raw.deployment_id);
  const initializer = key(raw.expected_initializer, 'expected_initializer');
  const admin = key(raw.expected_initial_admin, 'expected_initial_admin');
  const publisher = key(raw.fixture_publisher, 'fixture_publisher');
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), Buffer.from(deployment)], program);
  const policy = exactObject(raw.policy, [
    'genesis', 'program_id', 'config_address', 'configuration_version', 'oracle_mode', 'cash_index',
    'assets', 'route_kind', 'route_program', 'pool', 'pool_authority', 'route_vaults', 'max_route_legs',
    'max_age_seconds', 'max_future_skew_seconds', 'max_confidence_bps', 'max_reference_move_bps',
    'max_value_loss_bps', 'max_cross_deviation_bps', 'max_external_deviation_bps',
    'max_intent_lifetime_seconds', 'fixture_publisher', 'protocol_fee_bps',
  ], 'policy');
  if (policy.genesis !== toHex(genesis.toBytes()) || policy.program_id !== toHex(program.toBytes()) ||
      policy.config_address !== toHex(config.toBytes()) || policy.fixture_publisher !== toHex(publisher.toBytes())) {
    throw new TypeError('policy domain or fixture publisher mismatch');
  }
  if (policy.configuration_version !== '1' || policy.oracle_mode !== '0') throw new TypeError('initial policy must be v1 fixture mode');
  const encoded = policyBytes(policy);
  return {
    schema_version: '1' as const,
    cluster: raw.cluster,
    program_id: program.toBase58(),
    genesis: genesis.toBase58(),
    deployment_id: raw.deployment_id,
    config_address: config.toBase58(),
    expected_initializer: initializer.toBase58(),
    expected_initial_admin: admin.toBase58(),
    fixture_publisher: publisher.toBase58(),
    initial_policy_hash: await sha256Hex(encoded),
    policy_bytes_hex: toHex(encoded),
    policy,
  };
}

/** Recheck every derived field immediately before compiling or signing from a stored manifest. */
export async function assertPreparedDeploymentManifest(value: unknown, expectedGenesis: string) {
  const stored = exactObject(value, [
    'schema_version', 'cluster', 'program_id', 'genesis', 'deployment_id', 'config_address',
    'expected_initializer', 'expected_initial_admin', 'fixture_publisher',
    'initial_policy_hash', 'policy_bytes_hex', 'policy',
  ], 'prepared deployment');
  const candidate = {
    schema_version: stored.schema_version, cluster: stored.cluster, program_id: stored.program_id,
    genesis: stored.genesis, deployment_id: stored.deployment_id,
    expected_initializer: stored.expected_initializer, expected_initial_admin: stored.expected_initial_admin,
    fixture_publisher: stored.fixture_publisher, policy: stored.policy,
  };
  const expected = await prepareDeploymentManifest(candidate, expectedGenesis);
  for (const field of ['config_address', 'initial_policy_hash', 'policy_bytes_hex'] as const) {
    if (stored[field] !== expected[field]) throw new TypeError(`prepared deployment ${field} mismatch`);
  }
  return expected;
}
