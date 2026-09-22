const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PUBLIC_GENESIS = new Set([
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  DEVNET_GENESIS,
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
]);

export function validateWriteDestination(rpcUrl, expectedGenesis, mode) {
  if (typeof rpcUrl !== 'string' || typeof expectedGenesis !== 'string') throw new Error('explicit destination and genesis required');
  const url = new URL(rpcUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('unreviewed RPC URL');
  if (mode === 'devnet') {
    if (url.hostname !== 'api.devnet.solana.com' || url.protocol !== 'https:' || expectedGenesis !== DEVNET_GENESIS) throw new Error('DEVNET_IDENTITY_REQUIRED');
  } else if (mode === 'local') {
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || PUBLIC_GENESIS.has(expectedGenesis) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expectedGenesis)) {
      throw new Error('OWNED_LOCAL_IDENTITY_REQUIRED');
    }
  } else throw new Error('unsupported write cluster');
  return expectedGenesis;
}

// Caller supplies a fresh getGenesis query; no signing/send callback runs before equality.
export async function withVerifiedWriteDestination({ rpcUrl, expectedGenesis, mode, getGenesis }, action) {
  validateWriteDestination(rpcUrl, expectedGenesis, mode);
  if (typeof getGenesis !== 'function' || typeof action !== 'function') throw new TypeError('callbacks required');
  const actual = await getGenesis();
  if (actual !== expectedGenesis) throw new Error('GENESIS_MISMATCH');
  return action({ rpcUrl, genesis: actual, mode });
}
