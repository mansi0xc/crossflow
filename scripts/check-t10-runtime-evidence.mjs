import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(path);
const json = path => JSON.parse(read(path).toString('utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const report = json('verification/evidence/T10-local-venue-output.json');
const env = json('verification/evidence/T10-local-env.json');

const required = new Map([
  ['empty-reserve-swap', /Error Code: Reserves/],
  ['substituted-pool-vault', /Error Code: Vault/],
  ['redirected-destination', /Error Code: Vault/],
  ['min-out-above-the-quote', /Error Code: MinOut/],
  ['relabelled-mint', /Error Code: Mints/],
  ['same-direction', /Error Code: Direction/],
  ['zero-amount', /Error Code: Amount/],
]);

if (report.status !== 'PASS' || report.task !== 'T10' || report.cluster !== 'localnet') throw new Error('T10 report is not a passing local run');
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(report.genesis ?? '') || report.genesis !== env.genesis) throw new Error('T10 genesis mismatch');
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(report.pool ?? '')) throw new Error('T10 pool missing');
if (!String(report.label ?? '').includes('SYNTHETIC')) throw new Error('T10 must label the venue as synthetic test liquidity');
if (report.mandatory_negative_cases < 7 || report.negativeResults.length !== report.mandatory_negative_cases) throw new Error('T10 negative matrix incomplete');
if (!(report.compute_units > 0) || report.compute_units > report.requested_compute_units) throw new Error('T10 compute measurement invalid');

// The measured output is the venue's own transfer result and must equal the frozen quote model.
const amountIn = BigInt(report.amount_in);
const quoted = BigInt(report.quoted_out);
const measured = BigInt(report.measured_out);
if (amountIn <= 0n || quoted <= 0n) throw new Error('T10 swap amounts must be positive');
if (measured !== quoted) throw new Error('T10 measured output does not match the frozen quote');
if (BigInt(report.min_out) > quoted) throw new Error('T10 minimum output exceeds the quote');
const before = report.reserves_before.map(BigInt);
const after = report.reserves_after.map(BigInt);
if (after[1] !== before[1] + amountIn || after[0] !== before[0] - measured) throw new Error('T10 reserves did not follow the measured transfer');
if (BigInt(report.requoted_after_move) >= quoted) throw new Error('T10 price impact was not observed after the reserve moved');

const negatives = new Map(report.negativeResults.map(row => [row.label, row.log]));
if (negatives.size !== required.size) throw new Error('T10 negative case set mismatch');
for (const [label, pattern] of required) {
  const log = negatives.get(label);
  if (!log?.includes(`Program ${report.program_id} invoke [1]`) ||
      !log.includes(`Program ${report.program_id} failed:`) || !pattern.test(log)) {
    throw new Error(`T10 missing target-program rejection for ${label}`);
  }
}

const signatures = [report.signatures.initialize, ...report.signatures.seed, report.signatures.swap].filter(Boolean);
if (signatures.length < 3 || signatures.some(signature => typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) ||
    new Set(signatures).size !== signatures.length) throw new Error('T10 unique transaction signatures missing');

if (sha(read('target/deploy/test_venue.so')) !== report.hashes.binary) throw new Error('T10 built venue binary does not match the recorded evidence hash');
for (const [name, value] of Object.entries(report.hashes ?? {})) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`T10 hash ${name} invalid`);
}

console.log(JSON.stringify({
  status: 'PASS', task: 'T10', cluster: 'localnet', genesis: report.genesis,
  program_id: report.program_id, pool: report.pool, fee_bps: report.fee_bps,
  mandatory_negative_cases: required.size, transaction_signatures_count: signatures.length,
  transaction_signatures: signatures, compute_units: report.compute_units,
  amount_in: report.amount_in, quoted_out: report.quoted_out, measured_out: report.measured_out,
  reserves_after: report.reserves_after,
  hashes: { report: sha(read('verification/evidence/T10-local-venue-output.json')), env: sha(read('verification/evidence/T10-local-env.json')),
    binary: sha(read('target/deploy/test_venue.so')) },
  limitations: report.limitations,
}, null, 2));
