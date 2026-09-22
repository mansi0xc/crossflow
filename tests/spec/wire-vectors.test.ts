import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { assertMandateMatchesPolicy, fundingBodyBytes, mandateBytes, policyBytes, sha256Hex, toHex } from '../../packages/contracts/src/index.js';

const vectors = JSON.parse(readFileSync('docs/spec/wire-vectors.json', 'utf8'));
const policy = vectors.policy;
const policyHex = vectors.policy_hex;

describe('canonical v1 wire vectors', () => {
  test('policy bytes and digest match independently frozen Python vectors', async () => {
    const encoded = policyBytes(policy);
    expect(encoded.length).toBe(652);
    expect(toHex(encoded)).toBe(policyHex);
    expect(await sha256Hex(encoded)).toBe(vectors.policy_sha256);
  });

  for (const vector of vectors.positive) {
    test(`mandate and compact funding ${vector.id}`, async () => {
      const canonical = mandateBytes(vector.mandate);
      const funding = fundingBodyBytes(vector.mandate);
      await assertMandateMatchesPolicy(vector.mandate, policy, policy.genesis);
      expect(canonical.length).toBe(605);
      expect(funding.length).toBe(177);
      expect(toHex(canonical)).toBe(vector.canonical_hex);
      expect(toHex(funding)).toBe(vector.funding_body_hex);
      expect(await sha256Hex(canonical)).toBe(vector.canonical_sha256);
      expect(await sha256Hex(funding)).toBe(vector.funding_body_sha256);
    });
  }

  for (const invalid of vectors.invalid_inputs) {
    test(`rejects ${invalid.id}`, async () => {
      await expect(assertMandateMatchesPolicy(invalid.mandate, policy, policy.genesis)).rejects.toThrow();
    });
  }

  test('JSON object key order is not a hash preimage', () => {
    const forward = vectors.positive[0].mandate;
    const reverse = Object.fromEntries(Object.entries(forward).reverse());
    expect(toHex(mandateBytes(reverse))).toBe(toHex(mandateBytes(forward)));
  });

  test('all 35 one-byte mutations change the reviewed commitment', async () => {
    const original = mandateBytes(vectors.positive[0].mandate);
    expect(vectors.one_field_byte_mutations.length).toBe(35);
    for (const mutation of vectors.one_field_byte_mutations) {
      const changed = original.slice();
      changed[Number(mutation.byte_offset)] ^= Number.parseInt(mutation.xor_hex, 16);
      expect(await sha256Hex(changed)).toBe(mutation.mutated_sha256);
      expect(await sha256Hex(changed)).not.toBe(vectors.positive[0].canonical_sha256);
    }
  });

  test('a changed policy hash cannot be signed under the old review', async () => {
    const changed = structuredClone(vectors.positive[0].mandate);
    changed.policy_hash = 'ab'.repeat(32);
    await expect(assertMandateMatchesPolicy(changed, policy, policy.genesis)).rejects.toThrow('policy mismatch');
  });
});
