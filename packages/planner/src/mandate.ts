import { PublicKey } from '@solana/web3.js';
import { assertMandateMatchesPolicy, mandateBytes, policyBytes, sha256Hex, toHex } from '../../contracts/src/index.js';

export const MAX_AMOUNT = 1_000_000_000_000n;
export const MAX_POOL_AMOUNT = 3n * MAX_AMOUNT;
export const MAX_U64 = (1n << 64n) - 1n;
export const MAX_U128 = (1n << 128n) - 1n;
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MANDATE_KEYS = ['genesis', 'program_id', 'config_address', 'schema_version', 'policy_hash', 'owner', 'nonce', 'expiry_unix_seconds', 'optimization_commitment', 'assets'];
const ASSET_KEYS = ['mint', 'token_program', 'decimals', 'recipient_ata', 'funding', 'min_output', 'max_output', 'funding_reference_price'];
const POLICY_KEYS = ['genesis', 'program_id', 'config_address', 'configuration_version', 'oracle_mode', 'cash_index', 'assets', 'route_kind', 'route_program', 'pool', 'pool_authority', 'route_vaults', 'max_route_legs', 'max_age_seconds', 'max_future_skew_seconds', 'max_confidence_bps', 'max_reference_move_bps', 'max_value_loss_bps', 'max_cross_deviation_bps', 'max_external_deviation_bps', 'max_intent_lifetime_seconds', 'fixture_publisher', 'protocol_fee_bps'];
const POLICY_ASSET_KEYS = ['mint', 'token_program', 'decimals', 'feed_id'];

export function record(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name}: expected object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new TypeError(`${name}: missing or untrusted extra field`);
  return value as Record<string, unknown>;
}

export function list(value: unknown, min: number, max: number, name: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`${name}: expected ${min}–${max} entries`);
  return value;
}

export function decimal(value: unknown, name: string, max = MAX_U64): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${name}: canonical decimal string required`);
  const parsed = BigInt(value);
  if (parsed > max) throw new RangeError(`${name}: out of range`);
  return parsed;
}

export function hex32(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${name}: lowercase 32-byte hex required`);
  return value;
}

export function checkedAdd(a: bigint, b: bigint, name: string, cap = MAX_U128): bigint {
  const sum = a + b;
  if (sum > cap) throw new RangeError(`${name}: arithmetic overflow`);
  return sum;
}

export function checkedMul(a: bigint, b: bigint, name: string): bigint {
  const product = a * b;
  if (product > MAX_U128) throw new RangeError(`${name}: arithmetic overflow`);
  return product;
}

export interface PolicyAsset { mint: string; token_program: string; decimals: string; feed_id: string }
export interface Policy {
  genesis: string; program_id: string; config_address: string; configuration_version: string; oracle_mode: string;
  cash_index: string; assets: PolicyAsset[]; route_kind: string; route_program: string; pool: string;
  pool_authority: string; route_vaults: string[]; max_route_legs: string; max_age_seconds: string;
  max_future_skew_seconds: string; max_confidence_bps: string; max_reference_move_bps: string;
  max_value_loss_bps: string; max_cross_deviation_bps: string; max_external_deviation_bps: string;
  max_intent_lifetime_seconds: string; fixture_publisher: string; protocol_fee_bps: string;
}
export interface MandateAsset { mint: string; token_program: string; decimals: string; recipient_ata: string; funding: string; min_output: string; max_output: string; funding_reference_price: string }
export interface Mandate { genesis: string; program_id: string; config_address: string; schema_version: string; policy_hash: string; owner: string; nonce: string; expiry_unix_seconds: string; optimization_commitment: string; assets: MandateAsset[] }

export function parsePolicy(input: unknown): Policy {
  const p = record(input, POLICY_KEYS, 'policy');
  policyBytes(p); // Normative wire parser and admission maxima.
  const assets = list(p.assets, 3, 3, 'policy.assets').map((a, i) => {
    const item = record(a, POLICY_ASSET_KEYS, `policy.assets[${i}]`);
    return { mint: hex32(item.mint, 'mint'), token_program: hex32(item.token_program, 'token_program'), decimals: String(item.decimals), feed_id: hex32(item.feed_id, 'feed_id') };
  });
  return { ...p, assets } as Policy;
}

export function parseMandate(input: unknown): Mandate {
  const m = record(input, MANDATE_KEYS, 'mandate');
  mandateBytes(m); // Rejects unknowns, JSON numbers, unsupported assets and noncanonical integers.
  const assets = list(m.assets, 3, 3, 'mandate.assets').map((a, i) => {
    const item = record(a, ASSET_KEYS, `mandate.assets[${i}]`);
    return { mint: String(item.mint), token_program: String(item.token_program), decimals: String(item.decimals), recipient_ata: String(item.recipient_ata), funding: String(item.funding), min_output: String(item.min_output), max_output: String(item.max_output), funding_reference_price: String(item.funding_reference_price) };
  });
  return { ...m, assets } as Mandate;
}

function bytes32(hex: string): Uint8Array { return Uint8Array.from(hex.match(/../g)!.map(part => Number.parseInt(part, 16))); }

export function canonicalAta(owner: string, tokenProgram: string, mint: string): string {
  const [ata] = PublicKey.findProgramAddressSync([bytes32(hex32(owner, 'owner')), bytes32(hex32(tokenProgram, 'token program')), bytes32(hex32(mint, 'mint'))], ATA_PROGRAM);
  return toHex(ata.toBytes());
}

export async function validateFundedMandate(input: unknown, policyInput: unknown, expectedGenesis: string, now: bigint): Promise<{ mandate: Mandate; hash: string }> {
  const policy = parsePolicy(policyInput);
  const mandate = parseMandate(input);
  await assertMandateMatchesPolicy(mandate, policy, hex32(expectedGenesis, 'expected genesis'));
  if (now < 0n || now > MAX_U64) throw new RangeError('nonnegative on-chain time required');
  const expiry = decimal(mandate.expiry_unix_seconds, 'expiry');
  if (expiry <= now) throw new RangeError('mandate expired');
  if (expiry > checkedAdd(now, decimal(policy.max_intent_lifetime_seconds, 'maximum lifetime'), 'maximum intent lifetime', MAX_U64)) throw new RangeError('mandate lifetime exceeds policy');
  if (!PublicKey.isOnCurve(bytes32(mandate.owner))) throw new TypeError('owner must be a transaction-signing wallet');
  if (mandate.owner === policy.program_id || mandate.owner === policy.config_address || mandate.owner === policy.pool_authority) throw new TypeError('owner aliases program authority');
  for (const asset of mandate.assets) {
    if (asset.recipient_ata !== canonicalAta(mandate.owner, asset.token_program, asset.mint)) throw new TypeError(`recipient ATA mismatch for mint ${asset.mint}`);
  }
  if (mandate.assets[Number(policy.cash_index)].funding_reference_price !== '1000000') throw new TypeError('cash fixture funding reference must be exactly 1000000');
  return { mandate, hash: await sha256Hex(mandateBytes(mandate)) };
}

export interface WeightBandInput { funding: string[]; prices: string[]; decimals: string[]; lower_weight_bps: string[]; upper_weight_bps: string[] }

/** Off-chain preference conversion. Only the returned raw bounds, once owner-approved, are on-chain authority. */
export function deriveReviewableRawBounds(input: unknown): { min_output: string; max_output: string }[] {
  const r = record(input, ['funding', 'prices', 'decimals', 'lower_weight_bps', 'upper_weight_bps'], 'weight bands');
  const funding = list(r.funding, 3, 3, 'funding').map((v, i) => decimal(v, `funding[${i}]`, MAX_AMOUNT));
  if (funding.every(amount => amount === 0n)) throw new RangeError('empty funded slice cannot produce bounds');
  const prices = list(r.prices, 3, 3, 'prices').map((v, i) => {
    const p = decimal(v, `prices[${i}]`, MAX_AMOUNT); if (!p) throw new RangeError('zero price'); return p;
  });
  const decimals = list(r.decimals, 3, 3, 'decimals').map((v, i) => Number(decimal(v, `decimals[${i}]`, 9n)));
  const lower = list(r.lower_weight_bps, 3, 3, 'lower weights').map((v, i) => decimal(v, `lower_weight_bps[${i}]`, 10000n));
  const upper = list(r.upper_weight_bps, 3, 3, 'upper weights').map((v, i) => decimal(v, `upper_weight_bps[${i}]`, 10000n));
  if (lower.reduce((a, b) => a + b) > 10000n || upper.reduce((a, b) => a + b) < 10000n) throw new RangeError('weight bands exclude a whole portfolio');
  const unit = prices.map((p, i) => checkedMul(p, 10n ** BigInt(9 - decimals[i]), 'unit value'));
  const total = funding.reduce((sum, amount, i) => checkedAdd(sum, checkedMul(amount, unit[i], 'funding value'), 'total funding value'), 0n);
  return unit.map((unitValue, i) => {
    if (lower[i] > upper[i]) throw new RangeError(`weight band ${i} inverted`);
    const minNumerator = checkedMul(total, lower[i], 'minimum weight');
    const maxNumerator = checkedMul(total, upper[i], 'maximum weight');
    const divisor = checkedMul(10000n, unitValue, 'weight divisor');
    const min = checkedAdd(minNumerator, divisor - 1n, 'minimum rounding') / divisor;
    const max = maxNumerator / divisor;
    if (min > max || max > MAX_AMOUNT) throw new RangeError(`weight band ${i} cannot be represented within raw cap`);
    return { min_output: min.toString(), max_output: max.toString() };
  });
}
