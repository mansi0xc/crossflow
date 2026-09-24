import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { encodeSettlementBody } from '../packages/planner/src/validate.js';

const read = path => readFileSync(path);
const json = path => JSON.parse(read(path).toString('utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const report = json('verification/evidence/T16-local-route-output.json');
const manifest = json('verification/evidence/T16-local-manifest.json');

const required = new Map([
  ['unsorted-owner-accounts', /Error Code: BatchAccount/],
  ['wrong-venue-program', /Error Code: RouteIdentity/],
  ['cross-price-outside-committed-band', /Error Code: TradePrice/],
  ['minimum-output-above-the-measured-quote', /Error Code: (?:RouteOutput|MinOut)/],
  ['wrong-snapshot-sequence', /Error Code: (?:SnapshotSequence|Sequence)/],
  ['double-settle-rejected', /Error Code: Settle/],
]);

if (report.status !== 'PASS' || report.task !== 'T16' || report.cluster !== 'localnet') throw new Error('T16 report is not a passing local run');
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(report.genesis ?? '')) throw new Error('T16 genesis missing');
if (!String(report.price_label ?? '').startsWith('TEST PRICES')) throw new Error('T16 evidence must label the fixture prices');
if (!report.pools_ended_empty || !report.vaults_ended_at_surplus || !report.intents_settled) throw new Error('T16 terminal state was not asserted');
if (!(report.compute_units > 0) || report.compute_units > report.requested_compute_units) throw new Error('T16 compute measurement invalid');
if (!(report.serialized_settlement_bytes > 0) || report.serialized_settlement_bytes > 1232) throw new Error('T16 settlement packet must fit only through lookup tables');
if (!(report.lookup_table_entries >= 30)) throw new Error('T16 lookup table does not cover the batch and route accounts');
if (report.mandatory_negative_cases < 6 || report.negativeResults.length !== report.mandatory_negative_cases) throw new Error('T16 negative matrix incomplete');
if (!report.route?.vaults_are_pool_atas) throw new Error('T16 route vaults must be the venue pool canonical ATAs');
if (!Array.isArray(report.pools) || report.pools.length !== 3) throw new Error('T16 must bind three transient batch pools');

// The route identity must equal what the committed policy pins.
if (manifest.policy.route_kind !== '1') throw new Error('T16 manifest is not route enabled');
const hexOf = (base58) => Buffer.from(new PublicKey(base58).toBytes()).toString('hex');
for (const [field, value] of [['route_program', report.route.program], ['pool', report.route.pool]]) {
  if (manifest.policy[field] !== hexOf(value)) throw new Error(`T16 ${field} does not match the committed policy`);
}
for (let i = 0; i < 3; i++) {
  if (!report.route.vaults[i] || manifest.policy.route_vaults[i] !== hexOf(report.route.vaults[i])) {
    throw new Error('T16 route vault does not match the committed policy');
  }
}

// Recompute the expected payout from the recorded funding, the committed cross and the frozen
// venue quote, rather than comparing two fields the generator wrote together.
if (!Array.isArray(report.measured_outputs) || report.measured_outputs.length !== 3) throw new Error('T16 must record three owners');
const feeBps = BigInt(report.route.fee_bps);
const quote = (reserveIn, reserveOut, amountIn) => {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) throw new Error('T16 quote inputs must be positive');
  const net = amountIn * (10_000n - feeBps);
  const out = (reserveOut * net) / (reserveIn * 10_000n + net);
  if (out <= 0n || out >= reserveOut) throw new Error('T16 quote would exhaust the reserve');
  return out;
};
const reserveStockBefore = BigInt(report.venue_before.stock1);
const reserveCashBefore = BigInt(report.venue_before.cash);
const residualInput = BigInt(report.measured_external_input);
const expectedExternal = quote(reserveStockBefore, reserveCashBefore, residualInput);
if (report.measured_external_output !== expectedExternal.toString()) {
  throw new Error(`T16 measured external output ${report.measured_external_output} != recomputed ${expectedExternal}`);
}
// Realized per-owner execution deviation against the reference price, in basis points.
const stockValue = residualInput * 10_000_000n * 1_000n;
const cashValue = expectedExternal * 1_000_000n * 1_000n;
const deviation = (cashValue > stockValue ? cashValue - stockValue : stockValue - cashValue) * 10_000n / stockValue;
if (deviation > 200n) throw new Error('T16 external execution left the committed band');
const seller = Number(report.cross.seller_index);
const buyer = Number(report.cross.buyer_index);
const crossQuantity = BigInt(report.cross.stock_quantity);
const crossCash = BigInt(report.cross.cash_amount);
const stockIndex = Number(report.cross.stock_index);
for (let i = 0; i < 3; i++) {
  const funding = report.vault_before[i].map(BigInt);
  const debit = [0n, 0n, 0n];
  const credit = [0n, 0n, 0n];
  if (i === seller) { debit[stockIndex] += crossQuantity; credit[0] += crossCash; debit[stockIndex] += residualInput; credit[0] += expectedExternal; }
  if (i === buyer) { debit[0] += crossCash; credit[stockIndex] += crossQuantity; }
  const expected = funding.map((amount, a) => amount - debit[a] + credit[a]);
  for (let a = 0; a < 3; a++) {
    if (BigInt(report.measured_outputs[i][a]) !== expected[a]) throw new Error(`owner ${i} asset ${a} payout mismatch`);
    if (expected[a] < 0n) throw new Error('T16 negative authorized output');
  }
  if (funding.every(value => value === 0n)) throw new Error('T16 member funded an empty slice');
}

// The committed policy identity must come from the recorded policy bytes, not the decoded JSON.
const policyBytes = Buffer.from(manifest.policy_bytes_hex, 'hex');
if (policyBytes.length !== 652) throw new Error('T16 committed policy length mismatch');
if (createHash('sha256').update(policyBytes).digest('hex') !== manifest.initial_policy_hash) throw new Error('T16 committed policy hash mismatch');
if (report.policy_hash !== manifest.initial_policy_hash) throw new Error('T16 report policy hash does not match the manifest');
if (policyBytes.subarray(72, 104).toString('hex') !== Buffer.from(new PublicKey(report.config).toBytes()).toString('hex')) {
  throw new Error('T16 committed policy config does not match the deployed config');
}

// Rebuild the canonical body and instruction data and compare the hashes rather than trusting them.
const cross = { stock_index: report.cross.stock_index, seller_index: report.cross.seller_index,
  buyer_index: report.cross.buyer_index, stock_quantity: report.cross.stock_quantity, cash_amount: report.cross.cash_amount };
const residual = { stock_index: report.residual.stock_index, direction: report.residual.direction,
  minimum_output: report.residual.minimum_output, input_allocations: report.residual_inputs };
const body = encodeSettlementBody({ schema_version: '1', expected_snapshot_sequence: report.snapshot_sequence,
  crosses: [cross], residuals: [residual] }, 3);
const instructionData = Buffer.concat([Buffer.from([0xf9, 0x3a, 0xb0, 0x2c, 0xd2, 0xdc, 0x77, 0xa7]),
  (() => { const length = Buffer.alloc(4); length.writeUInt32LE(body.length); return length; })(), Buffer.from(body)]);
if (createHash('sha256').update(instructionData).digest('hex') !== report.hashes.body) throw new Error('T16 recorded body hash does not reproduce');

const negatives = new Map(report.negativeResults.map(row => [row.label, row.log]));
if (negatives.size !== required.size) throw new Error('T16 negative case set mismatch');
for (const [label, pattern] of required) {
  const log = negatives.get(label);
  if (!log?.includes('failed:') || !pattern.test(log)) throw new Error(`T16 missing target-program rejection for ${label}`);
}

if (sha(read('target/deploy/crossflow.so')) !== report.hashes.binary) throw new Error('T16 built binary does not match the recorded evidence hash');
if (sha(read('target/deploy/test_venue.so')) !== report.hashes.venue_binary) throw new Error('T16 built venue binary does not match the recorded evidence hash');
if (sha(read('verification/evidence/T16-local-manifest.json')) !== report.hashes.manifest) throw new Error('T16 manifest does not match the recorded evidence hash');
for (const [name, value] of Object.entries(report.hashes ?? {})) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`T16 hash ${name} invalid`);
}

console.log(JSON.stringify({
  status: 'PASS', task: 'T16', cluster: 'localnet', genesis: report.genesis,
  program_id: report.program_id, config: report.config, batch_authority: report.batch_authority,
  route: report.route, pools: report.pools,
  mandatory_negative_cases: required.size, compute_units: report.compute_units,
  serialized_settlement_bytes: report.serialized_settlement_bytes, lookup_table_entries: report.lookup_table_entries,
  measured_external_input: report.measured_external_input, measured_external_output: report.measured_external_output,
  external_deviation_bps: deviation.toString(),
  measured_outputs: report.measured_outputs,
  hashes: { report: sha(read('verification/evidence/T16-local-route-output.json')), manifest: report.hashes.manifest,
    binary: sha(read('target/deploy/crossflow.so')), venue_binary: sha(read('target/deploy/test_venue.so')), body: report.hashes.body },
  limitations: report.limitations,
}, null, 2));
