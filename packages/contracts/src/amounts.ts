/** Raw integers are authoritative; these helpers never round monetary inputs. */
export const MAX_AMOUNT = 1_000_000_000_000n;
export const MAX_POOL_AMOUNT = 3n * MAX_AMOUNT;

function requireRaw(value: bigint, limit: bigint): void {
  if (typeof value !== 'bigint' || value < 0n || value > limit) throw new RangeError('raw amount out of range');
}

function requireDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new RangeError('asset decimals out of range');
}

export function parseExactDisplay(value: string, decimals: number, limit = MAX_AMOUNT): bigint {
  requireDecimals(decimals);
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) {
    throw new TypeError('canonical unsigned decimal string required');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new RangeError('display amount has excess decimal precision');
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction.padEnd(decimals, '0') || '0'));
  requireRaw(raw, limit);
  return raw;
}

export function formatRawDisplay(raw: bigint, decimals: number): string {
  requireDecimals(decimals);
  requireRaw(raw, MAX_POOL_AMOUNT);
  if (decimals === 0) return raw.toString();
  const scale = 10n ** BigInt(decimals);
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${raw / scale}.${fraction}` : (raw / scale).toString();
}

/** External output is assigned to actual contributors with canonical owner-key ties. */
export function largestRemainderThree(output: bigint, inputs: readonly [bigint, bigint, bigint],
  owners: readonly [string, string, string]): [bigint, bigint, bigint] {
  requireRaw(output, MAX_POOL_AMOUNT);
  inputs.forEach(value => requireRaw(value, MAX_AMOUNT));
  if (owners.some(key => !/^[0-9a-f]{64}$/.test(key)) || new Set(owners).size !== 3) {
    throw new TypeError('three distinct lowercase owner key hex strings required');
  }
  const total = inputs.reduce((sum, x) => sum + x, 0n);
  if (total === 0n) {
    if (output !== 0n) throw new RangeError('output without input');
    return [0n, 0n, 0n];
  }
  const allocated: [bigint, bigint, bigint] = [0n, 0n, 0n];
  const residues: [bigint, bigint, bigint] = [0n, 0n, 0n];
  for (let i = 0; i < 3; i++) {
    if (inputs[i] === 0n) continue;
    const product = output * inputs[i];
    allocated[i] = product / total;
    residues[i] = product % total;
  }
  const remaining = output - allocated.reduce((sum, x) => sum + x, 0n);
  const positive = inputs.filter(x => x > 0n).length;
  if (remaining < 0n || remaining >= BigInt(positive)) throw new RangeError('nonconserving allocation');
  const order = [0, 1, 2].sort((a, b) => {
    if (residues[a] !== residues[b]) return residues[a] > residues[b] ? -1 : 1;
    return owners[a] < owners[b] ? -1 : owners[a] > owners[b] ? 1 : 0;
  });
  for (let n = 0; n < Number(remaining); n++) {
    const i = order[n];
    if (inputs[i] === 0n) throw new RangeError('nonparticipant allocated output');
    allocated[i]++;
  }
  if (allocated.some((x, i) => x > MAX_AMOUNT || (inputs[i] > 0n && x === 0n)) ||
      allocated.reduce((sum, x) => sum + x, 0n) !== output) {
    throw new RangeError('unspendable or nonconserving allocation');
  }
  return allocated;
}
