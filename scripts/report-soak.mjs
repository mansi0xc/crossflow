import { readFileSync } from 'node:fs';

/**
 * Report the committed soak transcript in the shape `verify:task` checks.
 *
 * Running the soak itself needs a validator, so the mandatory check reads the committed report and
 * refuses to summarise a run that recorded failures. Regenerate the report with
 * `scripts/local-runs/run-soak.sh`.
 */
const report = JSON.parse(readFileSync('docs/evidence/soak-report.json', 'utf8'));
if (report.status !== 'COMPLETE') throw new Error(`soak report status is ${report.status}`);
if (!report.rent?.everyIntentClosed) throw new Error('the soak left an intent open');
console.log(JSON.stringify({
  status: report.status, task: report.task, profile: report.profile,
  cycles: report.cycles,
  steps: report.totals.steps, ok: report.totals.ok,
  refused: report.totals.refused, chain_errors: report.totals.chain_errors,
  max_compute: report.totals.max_compute, total_compute: report.totals.total_compute,
  every_intent_closed: report.rent.everyIntentClosed,
  over_capacity: report.capacity.overCapacity,
  hashes: report.hashes,
  limitations: report.limitations,
}, null, 2));
