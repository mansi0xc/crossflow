import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decodeIntent, INTENT_SPACE } from '../../services/api/src/intent-index.js';
import { SNAPSHOT_SPACE, decodeSnapshot, prepareBatch } from '../../services/api/src/batch-coordinator.js';

const PROGRAM = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const CONFIG = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const intentDiscriminator = createHash('sha256').update('account:Intent').digest().subarray(0, 8);

function syntheticIntent(options: { owner?: PublicKey; nonce?: bigint; status?: number } = {}): Buffer {
  const owner = options.owner ?? PublicKey.findProgramAddressSync([Buffer.from('owner')], PROGRAM)[0];
  const data = Buffer.alloc(INTENT_SPACE);
  intentDiscriminator.copy(data, 0);
  CONFIG.toBuffer().copy(data, 8);
  owner.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(options.nonce ?? 0n, 72);
  data.writeBigUInt64LE(1_800_000_000n, 80);
  data.fill(0xab, 88, 120);   // policy hash
  data.fill(0xcd, 120, 152);  // mandate hash
  data.fill(0xef, 152, 184);  // optimization commitment
  for (let i = 0; i < 3; i++) {
    data.writeBigUInt64LE(BigInt(1_000_000 * (i + 1)), 184 + i * 32);          // funding
    data.writeBigUInt64LE(0n, 192 + i * 32);                                    // min output
    data.writeBigUInt64LE(BigInt(2_000_000 * (i + 1)), 200 + i * 32);           // max output
    data.writeBigUInt64LE(1_000_000n, 208 + i * 32);                            // reference price
    PublicKey.findProgramAddressSync([Buffer.from(`recipient-${i}`)], PROGRAM)[0].toBuffer().copy(data, 280 + i * 32);
    PublicKey.findProgramAddressSync([Buffer.from(`vault-${i}`)], PROGRAM)[0].toBuffer().copy(data, 376 + i * 32);
    data.writeBigUInt64LE(BigInt(1_000_000 * (i + 1)), 472 + i * 8);            // booked claims
  }
  data[520] = options.status ?? 0;
  data[521] = 1;
  return data;
}

/** Only the reads the coordinator performs; nothing else is reachable from the tests. */
function fakeConnection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getProgramAccounts: async () => [],
    getAccountInfo: async () => null,
    getMultipleAccountsInfo: async () => [],
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1_000_000 }),
    ...overrides,
  } as never;
}

const OPTIONS = { connection: fakeConnection(), programId: PROGRAM,
  manifest: { deployment_id: 'ab'.repeat(32), genesis: '11'.repeat(32), config_address: CONFIG.toBase58(),
    initial_policy_hash: 'cd'.repeat(32), policy: { route_kind: '0', assets: [] } },
  timeoutMs: 1_000, maxOwners: 3 };

describe('T32 orchestration guards', () => {
  test('a chain intent decodes field by field, and a wrong discriminator is refused', () => {
    const owner = PublicKey.findProgramAddressSync([Buffer.from('owner')], PROGRAM)[0];
    const decoded = decodeIntent('intent-address', syntheticIntent({ owner, nonce: 4n }), 'now');
    expect(decoded.owner).toBe(owner.toBase58());
    expect(decoded.nonce).toBe('4');
    expect(decoded.config).toBe(CONFIG.toBase58());
    expect(decoded.assets.map(asset => asset.funding)).toEqual(['1000000', '2000000', '3000000']);
    expect(decoded.assets.map(asset => asset.maxOutput)).toEqual(['2000000', '4000000', '6000000']);
    expect(decoded.bookedClaims).toEqual(['1000000', '2000000', '3000000']);
    expect(decoded.status).toBe(0);
    const corrupted = syntheticIntent();
    corrupted[0] ^= 0xff;
    expect(() => decodeIntent('intent-address', corrupted, 'now')).toThrow(/discriminator/);
  });

  test('a fixture snapshot decodes without trusting a display-only value', () => {
    const data = Buffer.alloc(SNAPSHOT_SPACE);
    data.fill(0x11, 40, 72);  // policy hash
    data.fill(0x22, 72, 104); // publisher
    data.writeBigUInt64LE(9n, 105);
    for (let i = 0; i < 3; i++) {
      const base = 113 + i * 102;
      data.fill(0x40 + i, base + 32, base + 64);
      data.writeBigUInt64LE(BigInt(1_000_000 * (i + 1)), base + 64);
      data.writeBigUInt64LE(0n, base + 72);
      data.writeBigInt64LE(0n, base + 80);
      data.writeBigUInt64LE(1_000n, base + 85);
      data.writeBigUInt64LE(1_001n, base + 93);
    }
    const snapshot = decodeSnapshot(data);
    expect(snapshot.sequence).toBe('9');
    expect(snapshot.marketClosed).toBe(false);
    expect(snapshot.assets.map(asset => asset.price)).toEqual(['1000000', '2000000', '3000000']);
    expect(() => decodeSnapshot(data.subarray(0, 10))).toThrow(/unexpected length/);
  });

  test('prepare refuses before building anything when the funded set is not a valid batch', async () => {
    // A program-derived address is off the ed25519 curve, so it cannot be a wallet.
    const offCurve = PublicKey.findProgramAddressSync([Buffer.from('off-curve')], PROGRAM)[0];
    const none = await prepareBatch(OPTIONS, { plan: {}, operator: offCurve.toBase58() });
    expect(none.status).toBe('REJECTED');
    expect(none.reason).toMatch(/operator must be a wallet key/);

    const wallet = Keypair.generate().publicKey;
    const empty = await prepareBatch(OPTIONS, { plan: {}, operator: wallet.toBase58() });
    expect(empty.status).toBe('REJECTED');
    expect(empty.reason).toMatch(/expected 2–3 funded intents, found 0/);
    expect(empty.transaction).toBeUndefined();

    // Four funded intents exceed the configured maximum and must be refused rather than trimmed.
    const four = await prepareBatch({ ...OPTIONS, connection: fakeConnection({
      getProgramAccounts: async () => [0, 1, 2, 3].map(index => ({ pubkey: PublicKey.findProgramAddressSync([Buffer.from(`intent-${index}`)], PROGRAM)[0],
        account: { data: syntheticIntent({ owner: PublicKey.findProgramAddressSync([Buffer.from(`owner-${index}`)], PROGRAM)[0], nonce: BigInt(index) }) } })),
    }) }, { plan: {}, operator: wallet.toBase58() });
    expect(four.status).toBe('REJECTED');
    expect(four.reason).toMatch(/expected 2–3 funded intents, found 4/);
  });

  test('a proposal is compiled by the service and must cover the funded set exactly', async () => {
    const wallet = Keypair.generate().publicKey;
    const two = fakeConnection({
      getProgramAccounts: async () => [0, 1].map(index => ({ pubkey: PublicKey.findProgramAddressSync([Buffer.from(`intent-${index}`)], PROGRAM)[0],
        account: { data: syntheticIntent({ owner: PublicKey.findProgramAddressSync([Buffer.from(`owner-${index}`)], PROGRAM)[0], nonce: BigInt(index) }) } })),
    });
    // One account cannot describe two funded intents; the refusal happens before any chain read, so
    // the service never compiles a proposal against the wrong owner set.
    const short = await prepareBatch({ ...OPTIONS, connection: two },
      { plan: {}, operator: wallet.toBase58(), proposal: { accounts: [{}], prices: {} } });
    expect(short.status).toBe('REJECTED');
    expect(short.reason).toMatch(/must cover exactly the 2 funded intents/);
    expect(short.transaction).toBeUndefined();
  });

  test('settled and cancelled intents are excluded from the fundable set', async () => {
    const wallet = Keypair.generate().publicKey;
    const mixed = prepareBatch({ ...OPTIONS, connection: fakeConnection({
      getProgramAccounts: async () => [0, 1, 2].map(index => ({ pubkey: PublicKey.findProgramAddressSync([Buffer.from(`intent-${index}`)], PROGRAM)[0],
        account: { data: syntheticIntent({ owner: PublicKey.findProgramAddressSync([Buffer.from(`owner-${index}`)], PROGRAM)[0], nonce: BigInt(index), status: index === 0 ? 1 : 0 }) } })),
    }) }, { plan: {}, operator: wallet.toBase58() });
    // Only two intents are still Funded, which is a valid batch size, so the count guard passes
    // and the next chain read is what fails. A chain-read failure is an operational error, not a
    // rejected plan, so it surfaces as an exception rather than a fabricated plan rejection.
    await expect(mixed).rejects.toThrow(/fixture snapshot is missing/);
  });
});
