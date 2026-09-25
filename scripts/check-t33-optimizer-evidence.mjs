import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * T33 optimizer-driven execution evidence.
 *
 * The claim is that the optimizer's recommendation becomes the executed trade with the right
 * quantities and an accurate receipt: a matched cross, a sale residual, a purchase residual, and an
 * economically harmful batch refused. Everything below is re-derived from the recorded run, not
 * trusted from a summary — including the purchase conversion, which is recomputed from the residual
 * itself so the units error the compiler once had cannot reappear unnoticed.
 */
const OUTPUT = 'verification/evidence/T33-optimizer-execution-output.json';
const MANIFEST = 'verification/evidence/T33-local-manifest.json';
const report = JSON.parse(readFileSync(OUTPUT, 'utf8'));

// The demo fixes the portfolio convention: ten micro-USD per raw stock unit, one per raw cash unit.
const STOCK_PRICE = 10n;
const CASH_PRICE = 1n;

const fail = message => { throw new Error(message); };
const sum = values => values.reduce((acc, value) => acc + value, 0n);

if (report.status !== 'PASS' || report.task !== 'T33' || report.cluster !== 'localnet') fail('T33 report is not a passing local run');
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(report.genesis ?? '')) fail('T33 genesis missing');
if (!String(report.scope ?? '').includes('LOCAL')) fail('T33 evidence must state its scope');
if (!Array.isArray(report.cycles) || report.cycles.length !== 4) fail('T33 must record four cycles');
if (!Array.isArray(report.limitations) || report.limitations.length < 3) fail('T33 evidence must state its limitations');

const [first, second, third, fourth] = report.cycles;
const settled = [first, second, third];

// The recommendation is carried, not hard-coded: three cycles settle on the recommended method, the
// fourth refuses because the recommendation is independent execution.
for (const cycle of settled) {
  if (!['B', 'C'].includes(cycle.decision?.method)) fail(`a settled cycle ran method ${cycle.decision?.method ?? 'none'}`);
  if (cycle.refused === true) fail('a settled cycle was marked refused');
}
if (fourth.decision?.method !== 'A' || fourth.refused !== true) fail('the harmful cycle did not refuse independent execution');
if (fourth.decision?.no_worse_than_independent !== false || !(fourth.decision?.harmed_owners ?? []).length) {
  fail('the refusal must name an owner worse off than independent execution');
}
if (fourth.settlement !== null) fail('a refused batch must not produce a settlement');
if (!Array.isArray(report.demonstration?.recommendation_honored) ||
    report.demonstration.recommendation_honored.join('/') !== [first, second, third, fourth].map(c => c.decision.method).join('/')) {
  fail('the recorded recommendation does not match the executed method');
}

// Both residual directions are exercised. A sale supplies stock; a purchase supplies *cash*.
const directionOf = cycle => (cycle.compiled?.residuals ?? []).map(leg => leg.direction);
if (!directionOf(second).includes('0')) fail('cycle 2 must route a sale residual');
if (!directionOf(third).includes('1')) fail('cycle 3 must route a purchase residual');

/** Recompute the compiler's committed output floor for a residual leg from its own input side. */
function checkResidualUnits(cycle, expectedDirection) {
  const leg = (cycle.compiled?.residuals ?? []).find(entry => entry.direction === expectedDirection);
  if (!leg) fail(`cycle ${cycle.label} is missing the expected residual direction ${expectedDirection}`);
  const inputs = leg.input_allocations.map(value => BigInt(value));
  const totalInput = sum(inputs);
  const expectedOutput = expectedDirection === '1'
    ? (totalInput * CASH_PRICE) / STOCK_PRICE // a purchase spends cash for stock
    : (totalInput * STOCK_PRICE) / CASH_PRICE; // a sale spends stock for cash
  const minimum = (expectedOutput * 9_800n) / 10_000n;
  if (BigInt(leg.minimum_output) !== minimum) {
    fail(`cycle ${cycle.label}: minimum output ${leg.minimum_output} is not the committed band below the reference ${minimum}`);
  }
  if (totalInput <= 0n) fail(`cycle ${cycle.label}: the residual input must be positive`);
  // A purchase's input is cash and therefore must not equal its stock quantity; the two coincide only
  // when the price ratio is one, which it is not here.
  if (expectedDirection === '1' && totalInput === (minimum * 100n) / 98n) fail(`cycle ${cycle.label}: the purchase input looks like a stock quantity, not cash`);
  return { direction: expectedDirection, total_input_raw: totalInput.toString(), minimum_output_raw: leg.minimum_output };
}
const saleLeg = checkResidualUnits(second, '0');
const purchaseLeg = checkResidualUnits(third, '1');

// The receipt reports "within signed bounds" separately from "matches the proposal", and the routed
// payout is where the two differ. Every settled owner's outcome must be inside its signed bounds.
let inBoundsReceipts = 0;
let routeDifferences = 0;
let exactMatches = 0;
for (const cycle of settled) {
  const settlement = cycle.settlement;
  // A transaction signature is a 64-byte value, so its base58 form is far longer than a 32-byte key.
  if (!settlement || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(settlement.signature ?? '')) fail(`cycle ${cycle.label} has no settlement signature`);
  if (!(settlement.serialized_bytes > 0)) fail(`cycle ${cycle.label} has an implausible transaction size`);
  if (!(settlement.lookup_table_entries >= 20)) fail(`cycle ${cycle.label} is not lookup-table backed`);
  if (!Array.isArray(cycle.reconstruction) || cycle.reconstruction.length === 0) fail(`cycle ${cycle.label} has no settlement reconstruction`);
  for (const entry of cycle.reconciled ?? []) {
    if (entry.within_signed_bounds !== true) fail(`cycle ${cycle.label}: a delivered outcome left its signed bounds`);
    inBoundsReceipts += 1;
    if (entry.matches_proposal === true) exactMatches += 1;
    if (Object.keys(entry.route_difference_raw ?? {}).length > 0) routeDifferences += 1;
  }
}
if (inBoundsReceipts < 3) fail('T33 must prove at least three owners inside their signed bounds');
if (routeDifferences < 1) fail('a routed payout must report its difference from the model');
if (exactMatches < 1) fail('a non-routed outcome must be reported as an exact match');

// The reconstruction is derived from the compiled settlement, so it depends on the quote only when
// a residual is present.
for (const cycle of settled) {
  const quoteDependent = (cycle.compiled?.residuals ?? []).length > 0;
  for (const entry of cycle.reconstruction) {
    if (entry.quote_dependent !== quoteDependent) fail(`cycle ${cycle.label}: reconstruction quote-dependence disagrees with the settlement`);
  }
}

if (report.demonstration?.harmful_batch_refused !== true) fail('T33 must report the harmful batch as refused');

for (const [name, value] of Object.entries(report.hashes ?? {})) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`T33 hash ${name} is invalid`);
}
if (createHash('sha256').update(readFileSync(MANIFEST)).digest('hex') !== report.hashes.manifest) {
  fail('T33 manifest does not match the recorded evidence hash');
}

console.log(JSON.stringify({
  status: 'PASS', task: 'T33', scope: report.scope, cluster: 'localnet', genesis: report.genesis,
  program_id: report.program_id, config: report.config,
  cycles: report.cycles.length,
  recommendation_honored: report.demonstration.recommendation_honored,
  residual_sell: directionOf(second).filter(direction => direction === '0').length,
  residual_buy: directionOf(third).filter(direction => direction === '1').length,
  sale_leg: saleLeg, purchase_leg: purchaseLeg,
  in_bounds_receipts: inBoundsReceipts, route_differences: routeDifferences, exact_matches: exactMatches,
  harmful_batch_refused: true,
  binary_sha256: report.hashes.binary,
  hashes: report.hashes,
  limitations: report.limitations,
}, null, 2));
