import { describe, expect, test } from 'vitest';
import { validateWriteDestination, withVerifiedWriteDestination } from '../../scripts/network-guard.mjs';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const LOCAL_GENESIS = '2VLosE4pN2rih9S2YRddrwtixoxGZHTWq6WBhTsgDbrC';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

describe('T23 write-destination guard', () => {
  test('accepts only the reviewed devnet destination', () => {
    expect(validateWriteDestination('https://api.devnet.solana.com', DEVNET_GENESIS, 'devnet')).toBe(DEVNET_GENESIS);
  });

  test('refuses a mainnet or testnet destination even with the right shape', () => {
    for (const url of ['https://api.mainnet-beta.solana.com', 'https://api.testnet.solana.com',
      'https://api.devnet.solana.com.evil.example', 'https://mainnet.devnet.solana.com']) {
      expect(() => validateWriteDestination(url, DEVNET_GENESIS, 'devnet')).toThrow();
    }
    expect(() => validateWriteDestination('http://api.devnet.solana.com', DEVNET_GENESIS, 'devnet')).toThrow();
  });

  test('refuses a devnet host paired with the wrong, public or absent genesis', () => {
    for (const genesis of [MAINNET_GENESIS, LOCAL_GENESIS, '', 'not-a-genesis']) {
      expect(() => validateWriteDestination('https://api.devnet.solana.com', genesis, 'devnet')).toThrow();
    }
  });

  test('refuses credentials, query strings and unknown clusters', () => {
    expect(() => validateWriteDestination('https://user:pass@api.devnet.solana.com', DEVNET_GENESIS, 'devnet')).toThrow();
    expect(() => validateWriteDestination('https://api.devnet.solana.com?x=1', DEVNET_GENESIS, 'devnet')).toThrow();
    expect(() => validateWriteDestination('https://api.devnet.solana.com', DEVNET_GENESIS, 'mainnet' as 'devnet')).toThrow();
  });

  test('accepts an owned local ledger and rejects a public genesis on it', () => {
    expect(validateWriteDestination('http://127.0.0.1:8899', LOCAL_GENESIS, 'local')).toBe(LOCAL_GENESIS);
    expect(() => validateWriteDestination('http://127.0.0.1:8899', DEVNET_GENESIS, 'local')).toThrow('OWNED_LOCAL_IDENTITY_REQUIRED');
    expect(() => validateWriteDestination('http://127.0.0.1', LOCAL_GENESIS, 'local')).toThrow();
    expect(() => validateWriteDestination('https://example.com:8899', LOCAL_GENESIS, 'local')).toThrow();
  });

  test('never runs an action when the live genesis disagrees with the expectation', async () => {
    let ran = false;
    await expect(withVerifiedWriteDestination({
      rpcUrl: 'https://api.devnet.solana.com', expectedGenesis: DEVNET_GENESIS, mode: 'devnet',
      getGenesis: async () => MAINNET_GENESIS,
    }, async () => { ran = true; })).rejects.toThrow('GENESIS_MISMATCH');
    expect(ran).toBe(false);
    const value = await withVerifiedWriteDestination({
      rpcUrl: 'https://api.devnet.solana.com', expectedGenesis: DEVNET_GENESIS, mode: 'devnet',
      getGenesis: async () => DEVNET_GENESIS,
    }, async ({ genesis }) => genesis);
    expect(value).toBe(DEVNET_GENESIS);
  });
});
