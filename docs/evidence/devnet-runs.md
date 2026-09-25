# Isolated devnet probe (T24, scoped-probe exception)

Status: **PASS as a probe, not as a release.** This is the master plan's scoped-probe exception
for an isolated thin slice: the reviewed build is deployed to public devnet, a three-owner
funding and one bounded atomic internal settlement are executed, several invalid variants are
rejected by the deployed program, and an owner cancels and recovers its funds. There is **no**
external residual route, **no** Pyth and **no** integrated release claim.

## Deployment identity

| Item | Value |
|---|---|
| Cluster / genesis | devnet / `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Program | `CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh` |
| Config PDA | `ENcnvW9bRMTcABwniQQpUaKmTGR9q8AtjEuu1iwYCs8D` |
| Deployment identity | recorded in `verification/evidence/T24-devnet-manifest.json` |
| Upgrade authority | retained by the approved devnet wallet `FSyL…jw2t` — a disclosed trust assumption |
| Test assets | three devnet mints with mint and freeze authority revoked, created by `scripts/devnet-assets.ts` |

## What actually happened on chain

This evidence was regenerated against the current build so the deployed artifact is traceable to
tested source; the identity above is the current one.

- Three independently constrained owners funded their own slices into their own per-intent vaults:
  owner A funded 10,000,000 cash + 4,000,000 stock1, owner B 40,000,000 cash, owner C 30,000,000 cash.
- One explicit internal cross settled atomically for all three owners in a single transaction:
  the seller gave up 2,000,000 stock1 and received 20,000,000 cash, the buyer did the reverse, and
  the third owner's holdings were unchanged. The batch consumed 161,316 compute units
  and needed an address lookup table with 33 entries, because the
  three-owner instruction does not fit the legacy 1232-byte packet.
- Every vault ended at its owner-attributed surplus (zero here) and every recipient gained exactly
  its authorised output, re-read from chain after settlement.
- Seven invalid variants were rejected by the deployed program with named errors: unsorted owner
  accounts, an output above the signed maximum, a cross price outside the committed band, a wrong
  snapshot sequence, a second settlement of an already-settled intent, and two withdrawals of an
  asset with no claim.
- Recovery: a fresh intent was funded with 5,000,000 cash, cancelled, withdrawn per asset and
  closed; the owner received exactly 5,000,000 back and the config's outstanding-claim counter
  returned to zero.

Transaction signatures and the full per-asset before/after record are in
`verification/evidence/T24-devnet-output.json`.

## Operational findings worth keeping

- The free public devnet RPC rate-limits aggressively (HTTP 429). Every read in the probe is
  paced and retried with backoff; the deploy itself still took minutes. This is a real quota
  constraint, not an implementation detail.
- A repeat probe run must recover the previous run's intents before funding again, because the
  policy allows only one active intent per owner. The probe does exactly that, using the owner
  path rather than any admin shortcut.
- A devnet deployment is bound to the policy it was initialized with, so replacing the committed
  policy requires a **new deployment identity**, not a code upgrade in place. The tooling now
  enforces that and refuses to replace a deployment that still has outstanding claim intents.
- Test mints are immutable once their supply is fixed, and repeated probe cycles over one asset set
  eventually leave an owner short of the stock it must fund. Each run therefore creates a fresh
  asset set.
- Nothing is upgraded or migrated silently: a different committed policy requires a new
  deployment identity and fresh user authorisation.

## What this does not establish

No external residual liquidity, no authenticated oracle, no routed residual, no composed
oracle-plus-route capacity measurement, no independent review of the integrated money path
(T17/T22), and no production or mainnet readiness. Interest rate, slippage and market-impact
figures in the economic evaluation are modelled, not observed.


## Scope of this deployment

This deployment's committed policy has routing disabled, so the probe exercises the internal
crossing path only. The composed residual route has never run on devnet; its evidence is local
(`verification/evidence/T16-local-route-output.json`). The live policy hash and the deployed
bytecode are both checked against the committed manifest, so this scope cannot drift silently.
