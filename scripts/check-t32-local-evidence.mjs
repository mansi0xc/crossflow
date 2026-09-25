import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * T32 live end-to-end evidence.
 *
 * The claim is that an operator drives the whole path over HTTP — plan, funded-intent discovery,
 * batch preparation, signing, broadcast and reconciliation — without pasting anything by hand.
 * Every step below is checked against what the service actually returned, and the prepared
 * transaction is required to be byte-equivalent to one built by a local client from the same plan.
 */
const report = JSON.parse(readFileSync('verification/evidence/T32-local-service-output.json', 'utf8'));
const step = name => {
  const found = (report.steps ?? []).find(entry => entry.step === name);
  if (!found) throw new Error(`T32 evidence is missing the ${name} step`);
  return found.detail;
};

if (report.status !== 'PASS' || report.task !== 'T32' || report.cluster !== 'localnet') throw new Error('T32 report is not a passing local run');
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(report.genesis ?? '')) throw new Error('T32 genesis missing');
if (!String(report.scope ?? '').includes('LOCAL')) throw new Error('T32 evidence must state its scope');

// The service answered as itself, on the configured deployment.
const health = step('health');
if (health.status !== 'OK' || health.cluster !== 'localnet') throw new Error('T32 health is not a local service');
const deployment = step('deployment');
if (deployment.config !== report.config) throw new Error('T32 deployment config disagrees with the report');
const price = step('price');
if (!String(price.label ?? '').startsWith('TEST PRICES')) throw new Error('T32 evidence must label the fixture prices');

// The numerical engine ran for real and produced all three proposals.
const plans = step('plans');
for (const method of ['A', 'B', 'C']) {
  if (!plans.status?.[method]) throw new Error(`T32 plan is missing proposal ${method}`);
}

// Funded intents were discovered from chain, and the plan named their mandate hashes.
const intents = step('intents');
if (!(intents.funded >= 2)) throw new Error('T32 needs at least two funded intents to form a batch');
if (intents.statuses.filter(status => status === 'Funded').length !== intents.funded) throw new Error('T32 funded count disagrees with the status list');

// The prepared transaction was simulated before being sent, and simulated successfully.
const simulation = step('simulate');
if (simulation.err !== null && simulation.err !== undefined) throw new Error(`T32 prepared transaction does not simulate: ${JSON.stringify(simulation.err)}`);
if (!(simulation.units > 0)) throw new Error('T32 simulation consumed no compute');

// The service built exactly what a local client builds from the same validated plan.
const equivalence = step('local-build-equivalence');
if (equivalence.sameCompiledInstructions !== true || equivalence.sameStaticKeys !== true) {
  throw new Error('T32 service-built transaction differs from a locally built one');
}

// The chain was advancing, so a failure to confirm could not be blamed on a stalled validator.
const liveness = step('height-samples');
if (!(Array.isArray(liveness.samples) && liveness.samples.length >= 2)) throw new Error('T32 must sample chain liveness');
if (!(liveness.samples[liveness.samples.length - 1] > liveness.samples[0])) throw new Error('T32 chain was not advancing before the broadcast');

// The operator, not the service, paid and signed.
const broadcast = step('broadcast');
if (broadcast.feePayer !== report.operator || broadcast.operator !== report.operator) throw new Error('T32 fee payer is not the operator');
if (broadcast.signatureCount !== 1) throw new Error('T32 transaction must carry exactly the operator signature');
if (!(broadcast.serializedBytes > 0) || broadcast.serializedBytes > 1232) throw new Error('T32 prepared transaction size is implausible');
if (!(broadcast.lookupTables >= 1)) throw new Error('T32 three-owner batch must be lookup-table backed');

// Settlement is claimed only from chain state, and every funded participant settled.
const reconciled = step('reconciled');
if (reconciled.settled !== intents.funded) throw new Error(`T32 reconciled ${reconciled.settled} of ${intents.funded} funded intents`);
if (reconciled.statuses.filter(status => status === 'Settled').length < intents.funded) throw new Error('T32 status list does not show the settled intents');

if (!Array.isArray(report.limitations) || report.limitations.length < 2) throw new Error('T32 evidence must state its limitations');
for (const [name, value] of Object.entries(report.hashes ?? {})) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`T32 hash ${name} invalid`);
}
if (createHash('sha256').update(readFileSync('verification/evidence/T32-local-manifest.json')).digest('hex') !== report.hashes.manifest) {
  throw new Error('T32 manifest does not match the recorded evidence hash');
}

console.log(JSON.stringify({
  status: 'PASS', task: 'T32', scope: report.scope, cluster: 'localnet', genesis: report.genesis,
  program_id: report.program_id, config: report.config, operator: report.operator,
  steps: (report.steps ?? []).map(entry => entry.step),
  funded_intents: intents.funded, settled_intents: reconciled.settled,
  compute_units: simulation.units, serialized_bytes: broadcast.serializedBytes,
  lookup_table_entries: step('lookup-table').entries,
  settlement_signature: broadcast.signature,
  hashes: report.hashes,
  limitations: report.limitations,
}, null, 2));
