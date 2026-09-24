# Consolidated money-path review (T22)

Scope: funding, internal batch settlement, composed residual routing and recovery — the paths that
move or can move value. Two independent reviews were commissioned in fresh contexts with no access
to this conversation; both read the specification, the code, the off-chain models and the evidence,
and both were told to report rather than edit.

| Review | Record | Verdict |
|---|---|---|
| Internal batch settlement (T09) | `.planning/T09-INDEPENDENT-REVIEW.md` | PASS after fixes |
| Composed residual route (T16) | `.planning/T16-INDEPENDENT-REVIEW.md` | PASS after fixes |

Machine-readable findings, including the ones accepted rather than fixed, are in
`docs/reviews/findings.json`. Every fixed finding has a regression test in
`tests/security/review-regressions.test.ts` that names it, so a fix cannot be quietly reverted.

## What the reviewers independently confirmed

- **No new privilege.** Neither settlement instruction declares a signer. Authority comes from
  funded mandates, and the only account ever granted signer privileges is CrossFlow's own derived
  PDA, obtained through `invoke_signed`.
- **Derive, do not trust.** Owner states, intents, vaults, recipients, batch pools and venue vaults
  are all re-derived and cross-checked against stored state. Aliasing is rejected within each role
  and across roles.
- **Realized amounts, not claims.** Every signed bound, the per-cross band, the per-owner external
  band, the aggregate external band and the whole-slice loss guard are checked on what the chain
  actually moved, after the CPIs.
- **Conservation closes.** Internal debits and credits cancel per mint, the pools must hold exactly
  the sum of credits, and each vault must end at its owner-attributed surplus. A donation cannot
  change an authorized output, become solver revenue or expand spending authority.
- **Atomicity and replay.** State is written last; any failure rolls back; a second settlement
  rejects.

## What the reviewers found that mattered

Both review cycles produced the same shape of result: no critical or high finding, but real
medium-severity defects that a passing test suite had not caught.

- The internal review caught a **guard that was labelled tested but never executed** (the
  no-round-trip rule) and a **one-owner batch** that the off-chain validator rejected but the chain
  accepted — a permissionless no-op state transition on someone else's funded intent.
- The route review caught a **decoder that read a fixed three weights regardless of `batch_count`**,
  so a two-owner routed body produced by the shipping client could not execute while a crafted one
  fed a phantom participant into the pro-rata allocation; a **loader that was not actually shared**
  and validated mints more weakly on the routed path than on the internal one; and an **evidence
  checker that compared two fields the generator had written together** instead of recomputing.
- Reviewing the route also surfaced a regression in *already-reviewed* code: adding the route field
  to `Policy` pushed both handlers past the SBF stack frame limit. `Policy` was boxed and the T09
  local evidence regenerated against the current code.

Three defects of the implementer's own were found and fixed during the route work: the venue pool
authority and CrossFlow's batch PDA were conflated; the pool reconciliation compared pre-route
intake against post-route credits; and the payout transfer was nested inside the credit branch, so
a pure-debit owner received nothing.

## Residual risk and what this does not establish

- Both reviews were **static**. Neither reviewer executed the validator, the suites or the checkers.
- **No devnet route and no real venue.** The composed path has only ever run against a synthetic
  constant-product pool with test tokens; the residual leg is bounded by the committed ±200 bps
  execution band rather than by demand.
- **No Pyth**, so no authenticated-price claim.
- **No service or UI**, so the secret-handling and reconciled-status invariants have nothing to
  enforce yet.
- There is **no adversarial runtime matrix** against the deployed instructions; adversarial
  coverage is the fourteen internal and six routed named rejections plus the property suite.
- This is a scoped engineering review, **not an audit and not a security guarantee**.
