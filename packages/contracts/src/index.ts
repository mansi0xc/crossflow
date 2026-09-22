// Canonical CrossFlow v1 bytes. The funded mandate, rather than JSON text, is the authority.
const ZERO32 = '00'.repeat(32);
const TOKEN_PROGRAM = '06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9';
const MAX_AMOUNT = 1_000_000_000_000n;

type ObjectValue = Record<string, unknown>;

function object(value: unknown, keys: readonly string[], name: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name}: expected object`);
  const result = value as ObjectValue;
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new TypeError(`${name}: missing or unknown field`);
  return result;
}

function array(value: unknown, length: number, name: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length) throw new TypeError(`${name}: expected ${length} entries`);
  return value;
}

function uint(value: unknown, bits: 8 | 16 | 32 | 64, name: string, max?: bigint): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${name}: canonical decimal string required`);
  const number = BigInt(value);
  if (number >= 1n << BigInt(bits) || (max !== undefined && number > max)) throw new RangeError(`${name}: out of range`);
  return number;
}

function le(value: unknown, bits: 8 | 16 | 32 | 64, name: string, max?: bigint): Uint8Array {
  let number = uint(value, bits, name, max);
  const result = new Uint8Array(bits / 8);
  for (let i = 0; i < result.length; i++) {
    result[i] = Number(number & 255n);
    number >>= 8n;
  }
  return result;
}

function hex32(value: unknown, name: string): Uint8Array {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${name}: lowercase 32-byte hex required`);
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i++) result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}

function bytes(...items: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(items.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const item of items) { result.set(item, offset); offset += item.length; }
  return result;
}

function label(value: string): Uint8Array { return new TextEncoder().encode(value); }

export function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(value.byteLength);
  new Uint8Array(owned).set(value);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', owned)));
}

const POLICY_KEYS = [
  'genesis', 'program_id', 'config_address', 'configuration_version', 'oracle_mode', 'cash_index',
  'assets', 'route_kind', 'route_program', 'pool', 'pool_authority', 'route_vaults',
  'max_route_legs', 'max_age_seconds', 'max_future_skew_seconds', 'max_confidence_bps',
  'max_reference_move_bps', 'max_value_loss_bps', 'max_cross_deviation_bps',
  'max_external_deviation_bps', 'max_intent_lifetime_seconds', 'fixture_publisher', 'protocol_fee_bps',
] as const;
const POLICY_ASSET_KEYS = ['mint', 'token_program', 'decimals', 'feed_id'] as const;
const MANDATE_KEYS = [
  'genesis', 'program_id', 'config_address', 'schema_version', 'policy_hash', 'owner',
  'nonce', 'expiry_unix_seconds', 'optimization_commitment', 'assets',
] as const;
const MANDATE_ASSET_KEYS = [
  'mint', 'token_program', 'decimals', 'recipient_ata', 'funding',
  'min_output', 'max_output', 'funding_reference_price',
] as const;

function policyAssets(value: unknown): { records: ObjectValue[]; encoded: Uint8Array[] } {
  const records = array(value, 3, 'policy.assets').map((entry, index) => object(entry, POLICY_ASSET_KEYS, `policy.assets[${index}]`));
  let previous = '';
  const encoded = records.map((record, index) => {
    const mint = record.mint;
    hex32(mint, `asset[${index}].mint`);
    if (typeof mint !== 'string' || mint <= previous) throw new TypeError('policy assets must be unique and sorted by mint bytes');
    previous = mint;
    if (record.token_program !== TOKEN_PROGRAM) throw new TypeError('only legacy SPL Token admitted');
    return bytes(hex32(mint, 'mint'), hex32(record.token_program, 'token_program'), le(record.decimals, 8, 'decimals', 9n), hex32(record.feed_id, 'feed_id'));
  });
  return { records, encoded };
}

export function policyBytes(input: unknown): Uint8Array {
  const p = object(input, POLICY_KEYS, 'policy');
  const assets = policyAssets(p.assets);
  if (uint(p.configuration_version, 32, 'configuration_version') === 0n) throw new RangeError('configuration_version must be positive');
  if (p.oracle_mode !== '0') throw new TypeError('Pyth mode is reserved until admitted');
  if (uint(p.cash_index, 8, 'cash_index') > 2n) throw new RangeError('cash_index');
  if (p.route_kind !== '0' && p.route_kind !== '1') throw new TypeError('route_kind');
  const route = p.route_kind === '1';
  const vaults = array(p.route_vaults, 3, 'route_vaults');
  if (route) {
    if ([p.route_program, p.pool, p.pool_authority, ...vaults].some((field) => field === ZERO32)) throw new TypeError('enabled route identity missing');
    if (p.max_route_legs !== '2') throw new TypeError('enabled route requires two-leg capacity');
  } else if ([p.route_program, p.pool, p.pool_authority, ...vaults].some((field) => field !== ZERO32) || p.max_route_legs !== '0') {
    throw new TypeError('disabled route must have zero identities');
  }
  if (p.protocol_fee_bps !== '0') throw new TypeError('protocol fee must be zero');
  if (p.fixture_publisher === ZERO32) throw new TypeError('fixture publisher missing');
  const age = uint(p.max_age_seconds, 32, 'max_age_seconds', 60n);
  if (age === 0n) throw new RangeError('max_age_seconds');
  const lifetime = uint(p.max_intent_lifetime_seconds, 32, 'max_intent_lifetime_seconds', 900n);
  if (lifetime === 0n) throw new RangeError('max_intent_lifetime_seconds');
  return bytes(
    label('CFLCFG01'), hex32(p.genesis, 'genesis'), hex32(p.program_id, 'program_id'), hex32(p.config_address, 'config_address'),
    le(p.configuration_version, 32, 'configuration_version'), le(p.oracle_mode, 8, 'oracle_mode'), le(p.cash_index, 8, 'cash_index'), le('3', 8, 'asset_count'),
    ...assets.encoded, le(p.route_kind, 8, 'route_kind'), hex32(p.route_program, 'route_program'), hex32(p.pool, 'pool'), hex32(p.pool_authority, 'pool_authority'),
    ...vaults.map((v) => hex32(v, 'route_vault')), le(p.max_route_legs, 8, 'max_route_legs'), le(p.max_age_seconds, 32, 'max_age_seconds', 60n),
    le(p.max_future_skew_seconds, 32, 'max_future_skew_seconds', 2n), le(p.max_confidence_bps, 16, 'max_confidence_bps', 100n),
    le(p.max_reference_move_bps, 16, 'max_reference_move_bps', 500n), le(p.max_value_loss_bps, 16, 'max_value_loss_bps', 200n),
    le(p.max_cross_deviation_bps, 16, 'max_cross_deviation_bps', 100n), le(p.max_external_deviation_bps, 16, 'max_external_deviation_bps', 200n),
    le(p.max_intent_lifetime_seconds, 32, 'max_intent_lifetime_seconds', 900n), hex32(p.fixture_publisher, 'fixture_publisher'),
    le(p.protocol_fee_bps, 16, 'protocol_fee_bps'),
  );
}

function mandateAssets(value: unknown): { records: ObjectValue[]; encoded: Uint8Array[] } {
  const records = array(value, 3, 'mandate.assets').map((entry, index) => object(entry, MANDATE_ASSET_KEYS, `mandate.assets[${index}]`));
  let previous = '';
  const recipients = new Set<string>();
  const encoded = records.map((a) => {
    const mint = a.mint;
    hex32(mint, 'mint');
    if (typeof mint !== 'string' || mint <= previous) throw new TypeError('mandate assets must be unique and sorted');
    previous = mint;
    if (a.token_program !== TOKEN_PROGRAM) throw new TypeError('token program mismatch');
    const recipient = a.recipient_ata;
    hex32(recipient, 'recipient_ata');
    if (typeof recipient !== 'string' || recipients.has(recipient)) throw new TypeError('duplicate recipient');
    recipients.add(recipient);
    const funding = uint(a.funding, 64, 'funding', MAX_AMOUNT);
    const lower = uint(a.min_output, 64, 'min_output', MAX_AMOUNT);
    const upper = uint(a.max_output, 64, 'max_output', MAX_AMOUNT);
    if (lower > upper) throw new RangeError('min_output exceeds max_output');
    if (uint(a.funding_reference_price, 64, 'funding_reference_price', MAX_AMOUNT) === 0n) throw new RangeError('zero reference price');
    void funding;
    return bytes(hex32(a.mint, 'mint'), hex32(a.token_program, 'token_program'), le(a.decimals, 8, 'decimals', 9n),
      hex32(a.recipient_ata, 'recipient_ata'), le(a.funding, 64, 'funding', MAX_AMOUNT),
      le(a.min_output, 64, 'min_output', MAX_AMOUNT), le(a.max_output, 64, 'max_output', MAX_AMOUNT),
      le(a.funding_reference_price, 64, 'funding_reference_price', MAX_AMOUNT));
  });
  return { records, encoded };
}

export function mandateBytes(input: unknown): Uint8Array {
  const m = object(input, MANDATE_KEYS, 'mandate');
  if (m.schema_version !== '1') throw new TypeError('unsupported schema_version');
  if (m.optimization_commitment === ZERO32) throw new TypeError('empty optimization commitment');
  const assets = mandateAssets(m.assets);
  if (assets.records.every((a) => a.funding === '0')) throw new TypeError('empty funded slice');
  return bytes(label('CFLINT01'), le(m.schema_version, 8, 'schema_version'), hex32(m.genesis, 'genesis'),
    hex32(m.program_id, 'program_id'), hex32(m.config_address, 'config_address'), hex32(m.policy_hash, 'policy_hash'), hex32(m.owner, 'owner'),
    le(m.nonce, 64, 'nonce'), le(m.expiry_unix_seconds, 64, 'expiry_unix_seconds'), hex32(m.optimization_commitment, 'optimization_commitment'),
    le('3', 8, 'asset_count'), ...assets.encoded);
}

export function fundingBodyBytes(input: unknown): Uint8Array {
  const m = object(input, MANDATE_KEYS, 'mandate');
  mandateBytes(m); // Funding and commitment must pass the same structural checks.
  const assets = mandateAssets(m.assets);
  return bytes(le(m.schema_version, 8, 'schema_version'), hex32(m.policy_hash, 'policy_hash'), le(m.nonce, 64, 'nonce'),
    le(m.expiry_unix_seconds, 64, 'expiry_unix_seconds'), hex32(m.optimization_commitment, 'optimization_commitment'),
    ...assets.records.flatMap((a) => [le(a.funding, 64, 'funding', MAX_AMOUNT), le(a.min_output, 64, 'min_output', MAX_AMOUNT),
      le(a.max_output, 64, 'max_output', MAX_AMOUNT), le(a.funding_reference_price, 64, 'funding_reference_price', MAX_AMOUNT)]));
}

export async function assertMandateMatchesPolicy(mandate: unknown, policy: unknown, expectedGenesis: string): Promise<void> {
  const p = object(policy, POLICY_KEYS, 'policy');
  const m = object(mandate, MANDATE_KEYS, 'mandate');
  const encodedPolicy = policyBytes(p);
  mandateBytes(m);
  if (m.genesis !== expectedGenesis || m.genesis !== p.genesis || m.program_id !== p.program_id || m.config_address !== p.config_address) {
    throw new TypeError('deployment domain mismatch');
  }
  if (m.policy_hash !== await sha256Hex(encodedPolicy)) throw new TypeError('policy mismatch');
  const policyAssetList = policyAssets(p.assets).records;
  const mandateAssetList = mandateAssets(m.assets).records;
  for (let index = 0; index < 3; index++) {
    for (const key of ['mint', 'token_program', 'decimals'] as const) {
      if (mandateAssetList[index][key] !== policyAssetList[index][key]) throw new TypeError('asset identity mismatch');
    }
  }
}
