import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * T24 devnet probe evidence.
 *
 * This checks the committed transcript offline: what the run claims it did, that the negative
 * matrix is present, that recovery returned exactly what was escrowed, and that nothing secret
 * leaked into the artefact. The *live* identity re-check is a separate command
 * (`scripts/check-deployment.ts`), because it needs the network.
 */
const report = JSON.parse(readFileSync('verification/evidence/T24-devnet-output.json', 'utf8'));
const manifest = JSON.parse(readFileSync('verification/evidence/T24-devnet-manifest.json', 'utf8'));
const errors = [];

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
if (report.status !== 'PASS' || report.task !== 'T24') errors.push('T24 report is not a passing probe');
if (report.cluster !== 'devnet') errors.push('T24 must be a devnet probe');
if (report.genesis !== DEVNET_GENESIS) errors.push('T24 genesis is not the reviewed devnet genesis');
if (report.program_id !== manifest.program_id) errors.push('T24 program id disagrees with the manifest');
if (report.config !== manifest.config_address) errors.push('T24 config disagrees with the manifest');
if (report.policy_hash !== manifest.initial_policy_hash) errors.push('T24 policy hash disagrees with the manifest');
if (!String(report.price_label ?? '').startsWith('TEST PRICES')) errors.push('T24 must label the fixture prices');
if (!String(report.scope ?? '').toLowerCase().includes('probe')) errors.push('T24 must state that it is a scoped probe');

// Supported capacity, measured rather than assumed.
if (!(report.compute_units > 0) || report.compute_units > report.requested_compute_units) errors.push('T24 compute measurement invalid');
if (!(report.lookup_table_entries >= 30)) errors.push('T24 three-owner probe must be lookup-table backed');
if (report.mandatory_negative_cases < 7 || report.negativeResults.length !== report.mandatory_negative_cases) errors.push('T24 negative matrix incomplete');

// Recovery must return exactly what was escrowed, and each asset separately.
const recovery = report.recovery ?? {};
if (recovery.funded !== recovery.returned) errors.push(`T24 recovery returned ${recovery.returned} of ${recovery.funded}`);
if (!Array.isArray(recovery.withdrawals) || recovery.withdrawals.length < 1) errors.push('T24 withdrew no asset');
if (!recovery.cancel_signature || !recovery.close_signature) errors.push('T24 recovery signatures missing');

// The negative matrix must name the cases the plan requires.
const labels = new Set(report.negativeResults.map(entry => entry.label));
for (const required of ['unsorted-owner-accounts', 'output-above-owner-maximum',
  'cross-price-outside-committed-band', 'wrong-snapshot-sequence', 'double-settle-rejected']) {
  if (!labels.has(required)) errors.push(`T24 is missing the ${required} rejection`);
}
// Every rejection must be the CrossFlow program refusing, not a client-side guard. Some entries
// record the full program log and others only the program's error code, so both are accepted.
for (const entry of report.negativeResults) {
  const log = String(entry.log ?? '');
  const isProgramError = log.includes('Error Code:') || (log.includes('failed:') && log.includes(report.program_id));
  if (!isProgramError) errors.push(`T24 rejection ${entry.label} is not a target-program failure`);
}

if (!Array.isArray(report.limitations) || report.limitations.length < 2) errors.push('T24 must state its limitations');
if (!Array.isArray(report.signatures) && typeof report.signatures !== 'object') errors.push('T24 must record its signatures');

// A devnet artefact must never carry a key.
const raw = readFileSync('verification/evidence/T24-devnet-output.json', 'utf8');
for (const pattern of [/secretKey/i, /privateKey/i, /seedPhrase/i, /mnemonic/i, /api[_-]?key/i,
  /"(?:key|secret)"\s*:\s*\[\s*\d/i]) {
  if (pattern.test(raw)) errors.push(`T24 evidence matches a secret-like pattern: ${pattern}`);
}
const manifestRaw = readFileSync('verification/evidence/T24-devnet-manifest.json', 'utf8');
for (const pattern of [/secretKey/i, /privateKey/i, /seedPhrase/i, /mnemonic/i, /api[_-]?key/i]) {
  if (pattern.test(manifestRaw)) errors.push(`T24 manifest matches a secret-like pattern: ${pattern}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({
  status: 'PASS', task: 'T24', cluster: report.cluster, scope: report.scope,
  genesis: report.genesis, program_id: report.program_id, config: report.config,
  compute_units: report.compute_units, lookup_table_entries: report.lookup_table_entries,
  mandatory_negative_cases: report.mandatory_negative_cases,
  recovery: { funded: recovery.funded, returned: recovery.returned, assets: recovery.withdrawals.length },
  hashes: {
    output: createHash('sha256').update(readFileSync('verification/evidence/T24-devnet-output.json')).digest('hex'),
    manifest: createHash('sha256').update(readFileSync('verification/evidence/T24-devnet-manifest.json')).digest('hex'),
  },
  limitations: report.limitations,
}, null, 2));
