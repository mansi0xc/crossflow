const PUBLIC_GENESIS = new Set([
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
]);

export function validateExpectedLocalGenesis(expected) {
  if (typeof expected !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expected) || PUBLIC_GENESIS.has(expected)) {
    throw new Error('Explicit experiment-owned LOCAL genesis required');
  }
  return expected;
}

// No funding/sign/send callback can run before identity is validated and matched.
export async function withLocalIdentity(expected, getGenesis, action) {
  validateExpectedLocalGenesis(expected);
  const actual = await getGenesis();
  if (actual !== expected) throw new Error('LOCAL_GENESIS_MISMATCH');
  return action(actual);
}

export function isAuthorityRejection(error, programId) {
  const code = error?.error?.errorCode;
  return code?.code === 'Unauthorized' && code?.number === 6000 &&
    Array.isArray(error.logs) &&
    error.logs.includes(`Program ${programId} failed: custom program error: 0x1770`);
}
