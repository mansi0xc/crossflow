import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';

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

// Every owner's realized payout must equal the independent expectation, and nothing may remain.
for (let i = 0; i < report.measured_outputs.length; i++) {
  for (let a = 0; a < 3; a++) {
    if (report.measured_outputs[i][a] !== report.expected_outputs[i][a]) throw new Error(`owner ${i} asset ${a} payout mismatch`);
  }
}

// The measured external leg must satisfy the committed ±200 bps per-owner execution band.
const soldStock = BigInt(report.measured_external_input);
const receivedCash = BigInt(report.measured_external_output);
if (soldStock <= 0n || receivedCash <= 0n) throw new Error('T16 external leg must be positive');
const stockValue = soldStock * 10_000_000n * 1_000n;
const cashValue = receivedCash * 1_000_000n * 1_000n;
const deviation = (cashValue > stockValue ? cashValue - stockValue : stockValue - cashValue) * 10_000n / stockValue;
if (deviation > 200n) throw new Error('T16 external execution left the committed band');
const stockReserve = BigInt(report.venue_after.stock1) - BigInt(report.venue_before.stock1);
const cashReserve = BigInt(report.venue_before.cash) - BigInt(report.venue_after.cash);
if (stockReserve !== soldStock || cashReserve !== receivedCash) throw new Error('T16 venue reserves do not match the measured leg');

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
