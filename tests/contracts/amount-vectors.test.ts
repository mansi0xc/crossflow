import { describe, expect, test } from 'vitest';
import { formatRawDisplay, largestRemainderThree, MAX_AMOUNT, MAX_POOL_AMOUNT, parseExactDisplay } from '../../packages/contracts/src/amounts.js';

const owners = ['01'.repeat(32), '02'.repeat(32), '03'.repeat(32)] as const;

describe('T08 exact raw amount boundaries', () => {
  test('display conversion is exact and does not use floating point', () => {
    expect(parseExactDisplay('0.000001', 6)).toBe(1n);
    expect(parseExactDisplay('1000000', 6)).toBe(MAX_AMOUNT);
    expect(formatRawDisplay(MAX_AMOUNT, 6)).toBe('1000000');
    expect(formatRawDisplay(1n, 9)).toBe('0.000000001');
    expect(formatRawDisplay(10n, 0)).toBe('10');
    expect(() => parseExactDisplay('0.0000001', 6)).toThrow('excess decimal precision');
    expect(() => parseExactDisplay('1000000.000001', 6)).toThrow('out of range');
    expect(() => parseExactDisplay('01', 6)).toThrow('canonical');
    expect(() => parseExactDisplay('1e6', 6)).toThrow('canonical');
    expect(() => formatRawDisplay(MAX_POOL_AMOUNT + 1n, 6)).toThrow('out of range');
  });

  test('reviewed largest-remainder vectors conserve every raw unit', () => {
    expect(largestRemainderThree(10n, [1n, 1n, 1n], owners)).toEqual([4n, 3n, 3n]);
    expect(largestRemainderThree(5n, [1n, 2n, 0n], owners)).toEqual([2n, 3n, 0n]);
    expect(largestRemainderThree(10n, [1n, 1n, 1n], [owners[2], owners[0], owners[1]])).toEqual([3n, 4n, 3n]);
    expect(largestRemainderThree(0n, [0n, 0n, 0n], owners)).toEqual([0n, 0n, 0n]);
    expect(largestRemainderThree(MAX_AMOUNT, [MAX_AMOUNT, 0n, 0n], owners)).toEqual([MAX_AMOUNT, 0n, 0n]);
  });

  test('tiny infeasible output, excess input/output and duplicate identities reject', () => {
    expect(() => largestRemainderThree(1n, [1n, 1n, 1n], owners)).toThrow('unspendable');
    expect(() => largestRemainderThree(1n, [0n, 0n, 0n], owners)).toThrow('without input');
    expect(() => largestRemainderThree(1n, [MAX_AMOUNT + 1n, 0n, 0n], owners)).toThrow('out of range');
    expect(() => largestRemainderThree(MAX_POOL_AMOUNT + 1n, [1n, 0n, 0n], owners)).toThrow('out of range');
    expect(() => largestRemainderThree(1n, [1n, 0n, 0n], [owners[0], owners[0], owners[2]])).toThrow('distinct');
  });
});
