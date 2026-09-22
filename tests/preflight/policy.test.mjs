import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateConfig, verifyRpc, DEVNET_GENESIS, MAINNET_GENESIS, TESTNET_GENESIS } from '../../scripts/preflight.mjs';

const fixture = JSON.parse(await readFile(new URL('../../preflight.config.json', import.meta.url), 'utf8'));
function config(change = {}) { return { ...structuredClone(fixture), ...change }; }
function mockRpc(genesis = DEVNET_GENESIS, options = {}) {
  const calls = [];
  return { calls, fetch: async (_url, request) => {
    const input = JSON.parse(request.body); calls.push(input.method);
    assert.equal(request.redirect, 'error');
    const result = { getGenesisHash: genesis, getHealth: options.health ?? 'ok', getVersion: { 'solana-core': 'test' } }[input.method];
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: input.id, result }) };
  } };
}

test('approved fixture/devnet/zero-spend config passes without mutating input', () => {
  const c = config(); const original = structuredClone(c);
  validateConfig(c); assert.deepEqual(c, original);
});
for (const url of ['https://api.mainnet-beta.solana.com', 'https://api.testnet.solana.com', 'https://api.devnet.solana.com.evil.test', 'https://user:secret@api.devnet.solana.com', 'https://api.devnet.solana.com?key=secret', 'https://api.devnet.solana.com/redirect']) {
  test(`reject non-allowlisted endpoint ${url.replace(/secret/g, 'REDACTED')} before any request`, async () => {
    let calls = 0;
    await assert.rejects(verifyRpc(config({ rpcUrl: url }), async () => { calls++; }), /DEVNET_IDENTITY_REQUIRED/);
    assert.equal(calls, 0);
  });
}
test('mainnet network field cannot use devnet URL as camouflage', () => assert.throws(() => validateConfig(config({ network: 'mainnet' })), /NETWORK_NOT_ALLOWED/));
test('caller cannot approve a different devnet genesis', () => assert.throws(() => validateConfig(config({ expectedGenesis: 'wrong' })), /DEVNET_IDENTITY_REQUIRED/));
test('wrong chain responds: stop after identity read with no write', async () => {
  const rpc = mockRpc('wrong-chain');
  await assert.rejects(verifyRpc(config(), rpc.fetch), /GENESIS_MISMATCH/);
  assert.deepEqual(rpc.calls, ['getGenesisHash']);
});
test('successful preflight sends only the three read methods', async () => {
  const rpc = mockRpc(); await verifyRpc(config(), rpc.fetch);
  assert.deepEqual(rpc.calls, ['getGenesisHash', 'getHealth', 'getVersion']);
});
for (const value of [1, -1, null, '0', NaN, Infinity]) {
  test(`reject budget value ${String(value)}`, () => assert.throws(() => validateConfig(config({ newSpendBudget: value })), /SPENDING_NOT_AUTHORIZED/));
}
test('paid service is rejected even if headline budget is zero', () => assert.throws(() => validateConfig(config({ services: [{ name: 'RPC', incrementalCost: 1, creditCardRequired: false }] })), /PAID_OR_UNVERIFIED_SERVICE/));
test('card-required service is rejected', () => assert.throws(() => validateConfig(config({ services: [{ name: 'trial', incrementalCost: 0, creditCardRequired: true }] })), /PAID_OR_UNVERIFIED_SERVICE/));
test('Pyth cannot silently replace approved fixture mode', () => assert.throws(() => validateConfig(config({ oracleMode: 'pyth' })), /PYTH_NOT_AUTHORIZED_IN_T00/));
test('localnet requires an explicitly pinned local identity', () => assert.throws(() => validateConfig(config({ network: 'localnet', rpcUrl: 'http://127.0.0.1:8899', expectedGenesis: '' })), /LOCAL_IDENTITY_REQUIRED/));
test('valid local identity is supported', () => assert.doesNotThrow(() => validateConfig(config({ network: 'localnet', rpcUrl: 'http://127.0.0.1:8899', expectedGenesis: '11111111111111111111111111111111' }))));
test('mainnet identity cannot be disguised as localnet behind localhost', async () => {
  let calls = 0;
  await assert.rejects(verifyRpc(config({ network: 'localnet', rpcUrl: 'http://127.0.0.1:8899', expectedGenesis: MAINNET_GENESIS }), async () => { calls++; }), /LOCAL_IDENTITY_REQUIRED/);
  assert.equal(calls, 0);
});
test('testnet identity cannot be disguised as localnet behind localhost', () => {
  assert.throws(() => validateConfig(config({ network: 'localnet', rpcUrl: 'http://127.0.0.1:8899', expectedGenesis: TESTNET_GENESIS })), /LOCAL_IDENTITY_REQUIRED/);
});
test('unhealthy RPC does not pass', async () => {
  const rpc = mockRpc(DEVNET_GENESIS, { health: 'behind' });
  await assert.rejects(verifyRpc(config(), rpc.fetch), /RPC_UNHEALTHY/);
  assert.deepEqual(rpc.calls, ['getGenesisHash', 'getHealth']);
});
test('transport and JSON-RPC errors remain failures', async () => {
  await assert.rejects(verifyRpc(config(), async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(verifyRpc(config(), async () => ({ ok: false, status: 429 })), /RPC_HTTP_429/);
  await assert.rejects(verifyRpc(config(), async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -1 } }) })), /RPC_INVALID_RESPONSE/);
});
