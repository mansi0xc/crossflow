import { existsSync, readFileSync } from 'node:fs';

/**
 * Report the capacity envelope of the composed settlement, separating what was actually executed
 * from what was only estimated.
 *
 * `--full` (the only supported mode) refuses to print a capacity claim unless a composed run
 * exists in evidence. It never derives an execution number from an estimate.
 */
const args = process.argv.slice(2);
if (!args.includes('--full')) throw new Error('measure-batch.ts requires --full; estimates alone are not capacity evidence');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const local = read('verification/evidence/T09-local-batch-output.json');
const routed = read('verification/evidence/T16-local-route-output.json');
const probePath = 'verification/evidence/capacity-probe.json';
const probe = existsSync(probePath) ? read(probePath) : { label: 'NOT_CAPTURED', note: 'no committed pre-implementation probe artifact' };

if (local.status !== 'PASS' || routed.status !== 'PASS') throw new Error('capacity cannot be reported from a failed run');

const report = {
  label: 'MEASURED_COMPOSED_EXECUTION',
  actualExecution: true,
  internalOnly: {
    label: 'MEASURED_LOCAL_EXECUTION',
    owners: local.batch_count,
    computeUnits: local.compute_units,
    requestedComputeUnits: local.requested_compute_units,
    serializedBytes: local.serialized_settlement_bytes,
    legacyEncodedBytes: local.legacy_encoded_bytes,
    legacyPacketLimit: local.legacy_packet_limit,
    lookupTableEntries: local.lookup_table_entries,
    fits: local.serialized_settlement_bytes <= local.legacy_packet_limit,
  },
  composedRoute: {
    label: 'MEASURED_LOCAL_EXECUTION',
    owners: routed.owners.length,
    residualLegs: 1,
    computeUnits: routed.compute_units,
    requestedComputeUnits: routed.requested_compute_units,
    serializedBytes: routed.serialized_settlement_bytes,
    lookupTableEntries: routed.lookup_table_entries,
    measuredExternalInput: routed.measured_external_input,
    measuredExternalOutput: routed.measured_external_output,
    externalDeviationBps: (() => {
      const stock = BigInt(routed.measured_external_input) * 10_000_000n * 1_000n;
      const cash = BigInt(routed.measured_external_output) * 1_000_000n * 1_000n;
      const delta = cash > stock ? cash - stock : stock - cash;
      return Number((delta * 10_000n) / stock);
    })(),
    fits: routed.serialized_settlement_bytes <= 1232,
  },
  preImplementationEstimate: probe,
  limits: [
    'The composed numbers are measured on an isolated local validator with synthetic test liquidity; they are not a devnet measurement.',
    'Compute headroom is not capacity for another leg: a second residual leg needs another venue CPI, more accounts and more compute.',
    'The economic bound bites first: this pool can only absorb a leg small enough to stay inside the committed ±200 bps per-owner execution band.',
    'Devnet route capacity is unmeasured; the devnet probe used the internal-only instruction.',
  ],
};
console.log(JSON.stringify(report, null, 2));
