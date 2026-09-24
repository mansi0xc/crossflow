import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Recompute every client discriminator from its instruction name. A discriminator is the only
 * thing tying a client instruction to a program handler, so a stale constant would silently build
 * an instruction the program does not recognise.
 */
const source = readFileSync('packages/client/src/discriminators.ts', 'utf8');
const entries = [...source.matchAll(/^\s{2}(\w+): \[([^\]]+)\]/gm)];
if (entries.length === 0) throw new Error('no discriminators found');
const errors = [];
for (const [, name, bytes] of entries) {
  const declared = bytes.split(',').map(part => Number(part.trim()));
  const expected = [...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)];
  if (declared.length !== 8 || declared.some((value, i) => value !== expected[i])) {
    errors.push(`${name}: declared [${declared}] != computed [${expected}]`);
  }
}
// Every instruction the program exposes must be present in the client table.
const rust = readFileSync('programs/crossflow/src/lib.rs', 'utf8');
// Generic parameters (`pub fn settle_batch<'info>(`) must match too, or the two most
// security-critical instructions would be silently skipped.
const programInstructions = [...rust.matchAll(/pub fn (\w+)[<(]/g)].map(match => match[1])
  .filter(name => name !== 'schema_marker');
const declaredNames = new Set(entries.map(([, name]) => name));
for (const name of programInstructions) {
  if (!declaredNames.has(name)) errors.push(`program instruction ${name} has no client discriminator`);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(JSON.stringify({ status: 'PASS', discriminators: entries.length, programInstructions: programInstructions.length }, null, 2));
