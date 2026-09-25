import { describe, expect, test } from 'vitest';

/**
 * T28 — lifecycle soak at the model level.
 *
 * A seeded random walk over the program's lifecycle, checking its invariants after *every*
 * operation rather than only at the end. This is evidence that the rules hold across
 * interleavings; it is not proof that they hold universally. The on-chain soak in
 * `scripts/soak.ts` covers the same ground against real accounts.
 */
const RENT = 1_000_000n;
const ASSETS = 3;
/** Owner balances plus every vault, recipient and closed-vault stake must always sum to this. */
const TOTAL_PER_ASSET: bigint[] = [1_500_000_000n, 900_000_000n, 600_000_000n];
const START: bigint[][] = [
  [500_000_000n, 300_000_000n, 200_000_000n],
  [500_000_000n, 300_000_000n, 200_000_000n],
  [500_000_000n, 300_000_000n, 200_000_000n],
];

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type IntentStatus = 'Funded' | 'Settled' | 'Cancelled';

interface Owner { nextNonce: bigint; active: string | null; balance: bigint[] }
interface Intent {
  id: string; owner: number; nonce: bigint; status: IntentStatus;
  claims: bigint[]; vault: bigint[]; recipient: bigint[]; rentHeld: boolean;
}
interface World {
  owners: Owner[];
  intents: Map<string, Intent>;
  closedPool: bigint[];
  rentEscrow: bigint;
  operations: number;
}

function emptyWorld(): World {
  return {
    owners: START.map(row => ({ nextNonce: 0n, active: null, balance: [...row] })),
    intents: new Map(), closedPool: new Array(ASSETS).fill(0n), rentEscrow: 0n, operations: 0,
  };
}

function totals(world: World): bigint[] {
  const sum = new Array(ASSETS).fill(0n) as bigint[];
  for (const owner of world.owners) for (let a = 0; a < ASSETS; a++) sum[a] += owner.balance[a];
  for (const intent of world.intents.values()) {
    for (let a = 0; a < ASSETS; a++) sum[a] += intent.vault[a] + intent.recipient[a];
  }
  for (let a = 0; a < ASSETS; a++) sum[a] += world.closedPool[a];
  return sum;
}

/** Throws on the first violated invariant. */
function invariants(world: World, phase: string) {
  for (let owner = 0; owner < world.owners.length; owner++) {
    const funded = [...world.intents.values()].filter(intent => intent.owner === owner && intent.status === 'Funded');
    if (funded.length > 1) throw new Error(`${phase}: owner ${owner} has ${funded.length} funded intents`);
    const active = world.owners[owner].active;
    if (active === null && funded.length > 0) throw new Error(`${phase}: owner ${owner} has a funded intent with no active pointer`);
    if (active !== null) {
      const intent = world.intents.get(active);
      if (!intent) throw new Error(`${phase}: active pointer names a missing intent`);
      if (intent.status !== 'Funded') throw new Error(`${phase}: active pointer names a ${intent.status} intent`);
      if (intent.owner !== owner) throw new Error(`${phase}: active pointer names another owner's intent`);
    }
  }
  for (const intent of world.intents.values()) {
    for (let a = 0; a < ASSETS; a++) {
      if (intent.vault[a] < 0n || intent.recipient[a] < 0n) throw new Error(`${phase}: negative balance`);
      if (intent.claims[a] < 0n) throw new Error(`${phase}: negative booked claim`);
      if (intent.claims[a] > intent.vault[a]) throw new Error(`${phase}: booked claims exceed the vault`);
      // The program books the whole slice while Funded; a settled intent must have released every
      // claim, and a cancelled one may still hold claims its owner has not withdrawn yet.
      if (intent.status === 'Funded' && intent.claims[a] !== intent.vault[a]) {
        throw new Error(`${phase}: a Funded intent does not book its whole vault`);
      }
      if (intent.status === 'Settled' && intent.claims[a] !== 0n) throw new Error(`${phase}: a Settled intent still books claims`);
    }
  }
  const actual = totals(world);
  for (let a = 0; a < ASSETS; a++) {
    if (actual[a] !== TOTAL_PER_ASSET[a]) throw new Error(`${phase}: asset ${a} total moved to ${actual[a]}`);
  }
  if (world.rentEscrow < 0n) throw new Error(`${phase}: negative rent escrow`);
}

function walk(seed: number, steps: number): { applied: number; refused: number; world: World } {
  const random = rng(seed);
  const world = emptyWorld();
  let applied = 0;
  let refused = 0;

  for (let step = 0; step < steps; step++) {
    const owner = Math.floor(random() * world.owners.length);
    const state = world.owners[owner];
    const active = state.active ? world.intents.get(state.active) : undefined;
    const nonFunded = [...world.intents.values()].filter(intent => intent.owner === owner && intent.status !== 'Funded');
    const choice = random();
    try {
      if (choice < 0.30) {
        if (active) throw new Error('owner already has an active intent');
        const amounts = Array.from({ length: ASSETS }, (_, a) =>
          random() < 0.6 ? state.balance[a] / (2n + BigInt(Math.floor(random() * 4))) : 0n);
        if (amounts.every(amount => amount === 0n)) throw new Error('nothing to fund');
        const id = `${owner}:${state.nextNonce}`;
        for (let a = 0; a < ASSETS; a++) state.balance[a] -= amounts[a];
        world.intents.set(id, { id, owner, nonce: state.nextNonce, status: 'Funded', claims: [...amounts],
          vault: [...amounts], recipient: new Array(ASSETS).fill(0n), rentHeld: true });
        world.rentEscrow += RENT;
        state.active = id;
        state.nextNonce += 1n;
        applied += 1;
      } else if (choice < 0.45) {
        if (!active) throw new Error('nothing to settle');
        for (let a = 0; a < ASSETS; a++) {
          active.recipient[a] += active.vault[a];
          active.vault[a] = 0n;
          active.claims[a] = 0n;
        }
        active.status = 'Settled';
        state.active = null;
        applied += 1;
      } else if (choice < 0.55) {
        if (!active) throw new Error('nothing to cancel');
        active.status = 'Cancelled';
        state.active = null;
        applied += 1;
      } else if (choice < 0.78) {
        // withdraw_asset moves the whole vault for one asset and clears that asset's claim. It is
        // the only operation that reduces a booked claim.
        const withBalance = nonFunded.filter(intent => intent.vault.some(value => value > 0n));
        const target = withBalance[Math.floor(random() * withBalance.length)];
        if (!target) throw new Error('nothing to withdraw');
        const a = target.vault.findIndex(value => value > 0n);
        target.recipient[a] += target.vault[a];
        target.vault[a] = 0n;
        target.claims[a] = 0n;
        applied += 1;
      } else if (choice < 0.93) {
        // close_intent refuses while any claim remains, so every asset must be withdrawn first.
        const target = nonFunded.find(intent => intent.rentHeld && intent.claims.every(claim => claim === 0n));
        if (!target) throw new Error('no closable intent: claims remain');
        target.rentHeld = false;
        world.rentEscrow -= RENT;
        applied += 1;
      } else {
        const a = Math.floor(random() * ASSETS);
        if (world.closedPool[a] === 0n) throw new Error('nothing staked to recover');
        const amount = world.closedPool[a];
        world.closedPool[a] = 0n;
        world.owners[0].balance[a] += amount;
        applied += 1;
      }
    } catch {
      refused += 1;
    }
    world.operations += 1;
    invariants(world, `seed ${seed} step ${step}`);
  }
  return { applied, refused, world };
}

describe('T28 lifecycle soak properties', () => {
  test('invariants hold after every operation across 120 seeded interleavings', () => {
    let applied = 0;
    let refused = 0;
    let settled = 0;
    let closed = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const result = walk(seed, 60);
      applied += result.applied;
      refused += result.refused;
      settled += [...result.world.intents.values()].filter(intent => intent.status === 'Settled').length;
      closed += [...result.world.intents.values()].filter(intent => !intent.rentHeld).length;
    }
    // The walk must actually exercise the machine: many successes, some genuinely impossible
    // operations attempted and refused, and real completions of both terminal paths.
    // Measured, not assumed: the walk applies roughly 2,600 operations and refuses roughly 4,600,
    // because closing requires every claim released first.
    console.log(`soak: applied=${applied} refused=${refused} settled=${settled} closed=${closed}`);
    expect(applied).toBeGreaterThan(2000);
    expect(refused).toBeGreaterThan(1000);
    expect(settled).toBeGreaterThan(200);
    expect(closed).toBeGreaterThan(100);
  });

  test('a terminal intent that books claims again is caught', () => {
    const { world } = walk(7, 40);
    const finished = [...world.intents.values()].find(intent => intent.status === 'Settled');
    if (!finished) return;
    finished.claims[0] = 1n;
    finished.vault[0] = 1n;
    // Conservation still holds; the invariant that must catch this is the claim rule.
    world.owners[0].balance[0] -= 1n;
    expect(() => invariants(world, 'direct')).toThrow(/still books claims/);
  });

  test('an owner holding two funded intents is caught', () => {
    const world = emptyWorld();
    const base = { owner: 0, status: 'Funded' as IntentStatus, claims: [1n, 0n, 0n],
      vault: [1n, 0n, 0n], recipient: [0n, 0n, 0n], rentHeld: true };
    world.intents.set('a', { ...base, id: 'a', nonce: 0n });
    world.intents.set('b', { ...base, id: 'b', nonce: 1n });
    world.owners[0].balance = [TOTAL_PER_ASSET[0] - 2n, TOTAL_PER_ASSET[1], TOTAL_PER_ASSET[2]];
    world.owners[0].active = 'a';
    expect(() => invariants(world, 'direct')).toThrow(/2 funded intents/);
  });

  test('every successful operation leaves conservation intact, and rent is recoverable', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { world } = walk(seed, 40);
      const actual = totals(world);
      expect(actual).toEqual(TOTAL_PER_ASSET);
      // Rent escrowed equals the rent of every intent still holding it.
      const holding = [...world.intents.values()].filter(intent => intent.rentHeld).length;
      expect(world.rentEscrow).toBe(BigInt(holding) * RENT);
    }
  });
});
