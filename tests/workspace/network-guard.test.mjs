import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { withVerifiedWriteDestination } from '../../scripts/network-guard.mjs';

const devnet = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const local = '4NvEmQ5DwAduuJb5KiTAQLi1hvFcxNXPTPRkM3KYaUG6';

test('devnet exact genesis allows signing callback', async () => {
  let actions = 0;
  await withVerifiedWriteDestination({ rpcUrl: 'https://api.devnet.solana.com', expectedGenesis: devnet, mode: 'devnet', getGenesis: async () => devnet }, async () => { actions++; });
  assert.equal(actions, 1);
});

for (const [name, input] of [
  ['mainnet URL', { rpcUrl: 'https://api.mainnet-beta.solana.com', expectedGenesis: devnet, mode: 'devnet' }],
  ['testnet URL', { rpcUrl: 'https://api.testnet.solana.com', expectedGenesis: devnet, mode: 'devnet' }],
  ['wrong expected genesis', { rpcUrl: 'https://api.devnet.solana.com', expectedGenesis: local, mode: 'devnet' }],
  ['local public genesis', { rpcUrl: 'http://127.0.0.1:8899', expectedGenesis: devnet, mode: 'local' }],
  ['local no port', { rpcUrl: 'http://127.0.0.1', expectedGenesis: local, mode: 'local' }],
  ['embedded credentials', { rpcUrl: 'https://key@api.devnet.solana.com', expectedGenesis: devnet, mode: 'devnet' }],
  ['unknown mode', { rpcUrl: 'https://api.devnet.solana.com', expectedGenesis: devnet, mode: 'mainnet' }],
]) {
  test(`${name} cannot reach signing callback`, async () => {
    let reads = 0, writes = 0;
    await assert.rejects(withVerifiedWriteDestination({ ...input, getGenesis: async () => { reads++; return input.expectedGenesis; } }, async () => { writes++; }));
    assert.equal(reads, 0);
    assert.equal(writes, 0);
  });
}

test('RPC genesis mismatch blocks signing callback', async () => {
  let writes = 0;
  await assert.rejects(withVerifiedWriteDestination({ rpcUrl: 'https://api.devnet.solana.com', expectedGenesis: devnet, mode: 'devnet', getGenesis: async () => local }, async () => { writes++; }), /GENESIS_MISMATCH/);
  assert.equal(writes, 0);
});

test('owned local validator exact genesis allows operation', async () => {
  let writes = 0;
  await withVerifiedWriteDestination({ rpcUrl: 'http://127.0.0.1:8899', expectedGenesis: local, mode: 'local', getGenesis: async () => local }, async () => { writes++; });
  assert.equal(writes, 1);
});
