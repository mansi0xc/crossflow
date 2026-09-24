import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(path);
const json = path => JSON.parse(read(path).toString('utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const report = json('verification/evidence/T09-local-batch-output.json');

const required = new Map([
  ['unsorted-owner-accounts', /Error Code: BatchAccount/],
  ['duplicate-intent-group', /Error Code: (?:BatchAccount|Alias)/],
  ['output-above-owner-maximum', /Error Code: Output/],
  ['cross-price-outside-committed-band', /Error Code: TradePrice/],
  ['output-below-owner-minimum', /Error Code: Output/],
  ['debit-exceeds-original-funding', /Error Code: BatchRecord/],
  ['round-trip-buy-and-sell-same-stock', /Error Code: BatchRecord/],
  ['substituted-vault-and-recipient', /Error Code: TokenIdentity/],
  ['wrong-mint-rejected', /Error Code: Mint/],
  ['trailing-instruction-bytes-rejected', /Error Code: Instruction/],
  ['wrong-snapshot-sequence', /Error Code: (?:SnapshotSequence|Sequence)/],
  ['residual-record-rejected', /Error Code: Instruction/],
  ['settlement-paused', /Error Code: Paused/],
  ['double-settle-rejected', /Error Code: Settle/],
]);

if (report.status !== 'PASS' || report.task !== 'T09' || report.cluster !== 'localnet') throw new Error('T09 report is not a passing local run');
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(report.genesis ?? '')) throw new Error('T09 genesis missing');
if (report.batch_count !== 3 || !Array.isArray(report.owners) || report.owners.length !== 3 || new Set(report.owners).size !== 3) throw new Error('T09 must bind three distinct owners');
if (!String(report.price_label ?? '').startsWith('TEST PRICES')) throw new Error('T09 evidence must label the fixture prices');
if (report.mandatory_negative_cases < 14 || report.negativeResults.length !== report.mandatory_negative_cases) throw new Error('T09 negative matrix incomplete');
if (!(report.compute_units > 0) || report.compute_units > report.requested_compute_units) throw new Error('T09 compute measurement invalid');
if (!(report.serialized_settlement_bytes > 0) || report.serialized_settlement_bytes > report.legacy_packet_limit) throw new Error('T09 settlement packet must fit only through lookup tables');
if (!(report.legacy_encoded_bytes > report.legacy_packet_limit)) throw new Error('T09 must record that the legacy encoding exceeds the packet limit');
if (sha(read('target/deploy/crossflow.so')) !== report.hashes.binary) throw new Error('T09 built binary does not match the recorded evidence hash');
if (sha(read('verification/evidence/T09-local-manifest.json')) !== report.hashes.manifest) throw new Error('T09 manifest does not match the recorded evidence hash');
if (!(report.lookup_table_entries >= 24)) throw new Error('T09 lookup table does not cover the batch accounts');
if (!report.limitations?.some(line => /lookup table/i.test(line))) throw new Error('T09 must disclose the lookup-table capacity dependency');
if (report.final_status.length !== 3 || report.final_status.some(value => value !== 1)) throw new Error('T09 intents did not all settle');

const negatives = new Map(report.negativeResults.map(row => [row.label, row.log]));
if (negatives.size !== required.size) throw new Error('T09 negative case set mismatch');
for (const [label, pattern] of required) {
  const log = negatives.get(label);
  if (!log?.includes(`Program ${report.program_id} invoke [1]`) ||
      !log.includes(`Program ${report.program_id} failed:`) || !pattern.test(log)) {
    throw new Error(`T09 missing target-program rejection for ${label}`);
  }
}

const signatures = Object.values(report.signatures).flat().filter(Boolean);
if (signatures.length !== report.signature_count || signatures.length < 6 ||
    signatures.some(signature => typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) ||
    new Set(signatures).size !== signatures.length) throw new Error('T09 unique transaction signatures missing');

// Derive each owner's authorized output from the recorded funding and the one explicit cross:
// the seller gives up stock and receives cash, the buyer does the reverse, others are unchanged.
const quantity = BigInt(report.crosses[0].stock_quantity);
const cash = BigInt(report.crosses[0].cash_amount);
if (quantity !== 2_000_000n || cash !== 20_000_000n) throw new Error('T09 cross record changed');
const stock = Number(report.crosses[0].stock_index);
const sellerIndex = Number(report.crosses[0].seller_index);
const buyerIndex = Number(report.crosses[0].buyer_index);
if (stock === 0 || sellerIndex === buyerIndex) throw new Error('T09 cross must name a distinct stock and two owners');
for (let i = 0; i < 3; i++) {
  const funding = report.vault_before[i].map(BigInt);
  const output = report.estimated_outputs[i].map(BigInt);
  const expected = funding.map(value => value);
  if (i === sellerIndex) { expected[stock] -= quantity; expected[0] += cash; }
  if (i === buyerIndex) { expected[0] -= cash; expected[stock] += quantity; }
  for (let a = 0; a < 3; a++) {
    if (output[a] !== expected[a]) throw new Error(`owner ${i} asset ${a} output mismatch`);
    if (output[a] < 0n) throw new Error('T09 negative authorized output');
  }
  if (funding.every(value => value === 0n)) throw new Error('T09 member funded an empty slice');
}
for (const [name, value] of Object.entries(report.hashes ?? {})) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`T09 hash ${name} invalid`);
}
if (Object.keys(report.hashes ?? {}).length !== 5) throw new Error('T09 hash set incomplete');

console.log(JSON.stringify({
  status: 'PASS', task: 'T09', cluster: 'localnet', genesis: report.genesis,
  config: report.config, program_id: report.program_id, batch_count: report.batch_count,
  mandatory_negative_cases: required.size, transaction_signatures_count: signatures.length,
  transaction_signatures: signatures, compute_units: report.compute_units,
  serialized_settlement_bytes: report.serialized_settlement_bytes,
  lookup_table_entries: report.lookup_table_entries, snapshot_sequence: report.snapshot_sequence,
  final_status: report.final_status,
  hashes: { report: sha(read('verification/evidence/T09-local-batch-output.json')), manifest: report.hashes.manifest,
    binary: sha(read('target/deploy/crossflow.so')), body: report.hashes.body, env: report.hashes.env },
  limitations: report.limitations,
}, null, 2));
