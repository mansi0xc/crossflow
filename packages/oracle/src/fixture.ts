import { validatePublication, validateUpdate, type FixtureSnapshot, type Observation, type OracleBinding } from './policy.js';
export const FIXTURE_LABEL = 'TEST PRICES — synthetic fixture publisher; not Pyth or live equity data';

/** Creates an unsigned test fixture proposal. It does not initialize an on-chain oracle. */
export function initialFixture(b: OracleBinding, observations: readonly Observation[], now: bigint): FixtureSnapshot {
  const snapshot: FixtureSnapshot = { config: b.config, policyHash: b.policyHash, publisher: b.publisher, mode: 0, sequence: 1n, observations: observations.map(o => ({ ...o })) };
  validatePublication(b, snapshot, now); return snapshot;
}

/** Rust must verify the actual configured publisher signature when this proposal is submitted. */
export function proposeFixtureUpdate(b: OracleBinding, previous: FixtureSnapshot, observations: readonly Observation[], requestedPublisher: string, now: bigint): FixtureSnapshot {
  const candidate: FixtureSnapshot = { config: b.config, policyHash: b.policyHash, publisher: b.publisher, mode: 0, sequence: previous.sequence + 1n, observations: observations.map(o => ({ ...o })) };
  validateUpdate(b, previous, candidate, requestedPublisher, now); return candidate;
}
