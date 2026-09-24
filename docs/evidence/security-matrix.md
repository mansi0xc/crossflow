# Invariant-to-enforcement matrix (T17)

Every row states **where the invariant is enforced in code**, **which check exercises it**, and
**what evidence exists**. A row is only marked exercised when a test or a runtime transcript
actually runs it. Anything not yet exercised says so — this table is an audit surface, not a
claim of coverage.

Legend for evidence: `unit` = Rust/Vitest unit test · `local` = local-validator transcript ·
`devnet` = public devnet probe · `model` = off-chain accounting model · `none` = not yet exercised.

| ID | Invariant | Enforced in | Exercised by | Evidence |
|---|---|---|---|---|
| S01 | Only local validator or verified devnet, with the configured program identity | `scripts/network-guard.mjs`, `scripts/deploy-devnet.ts`, `programs/crossflow/build.rs` | `tests/operations/network-guard.test.ts` (6 cases: mainnet, testnet, lookalike host, credentials, query string, genesis mismatch, unknown cluster) | unit |
| S02 | Only the owner can create/fund or cancel a mandate | `funding.rs` (`Signer` + owner PDA), `recovery.rs` | `tests/program/funding.test.ts` (wrong signer), T05/T07 transcripts (attacker initializer, wrong funder, unauthorized cancel/withdraw) | local |
| S03 | A funded authorization is immutable and binds domain, assets, bounds, recipients | `intent.rs::mandate_hash`, `Config::validate` policy hash check | `tests/spec/wire-vectors.test.ts`, `tests/program/atomic-batch.test.ts`, T05 stored-mandate decode | unit, local |
| S04 | An intent is consumed at most once and cannot be revived | `intent.rs` nonce, `funding.rs` `active_intent`, `recovery.rs::close_intent` | T05 (duplicate intent replay, closed-intent replay), T09/T16 (`double-settle-rejected`) | local |
| S05 | Expired/cancelled/unfunded intents cannot settle | `settlement.rs::within_settlement_window`, `batch.rs` status/expiry gate | `settlement.rs` unit test (before/at/after, negative clock), T07 (settlement after expiry, after cancel), T16 (`wrong-snapshot-sequence`) | unit, local |
| S06 | Per-asset conservation; no unexplained mint, drain or subsidy | `batch.rs` (cross conservation), `settle_routed` pool reconciliation, `math.rs` checked totals | `tests/security/properties.test.ts` (60 generated portfolios: `sum(D) == sum(C)` and per-owner identity), T09/T16 (vault = surplus, pool = 0) | model, local |
| S07 | Every owner's realized output satisfies its signed min/max | `batch.rs` output loop, `settle_routed` output loop | T09 (`output-above-owner-maximum`, `output-below-owner-minimum`), T16 (payout equals the independent expectation for all three owners) | local |
| S08 | Checked arithmetic cannot overflow, underflow or lose precision | `math.rs`, `oracle.rs` checked u128, `packages/contracts/src/amounts.ts` | `tests/contracts/amount-vectors.test.ts`, `math.rs` and `oracle.rs` unit tests, `tests/planner/validation.test.ts` (NaN/Infinity/imprecise JSON) | unit |
| S09 | Rounding and dust have deterministic, disclosed ownership | `math.rs::largest_remainder_three`, `amounts.ts::largestRemainderThree` | `tests/contracts/amount-vectors.test.ts` (ties by ascending owner bytes, permutation), `oracle` differential vector | unit |
| S10 | Account roles are verified; aliases cannot bypass balances | `batch.rs::identity_separation`, `route.rs`, derived ATAs throughout | T09 (`unsorted-owner-accounts`, `duplicate-intent-group`, `substituted-vault-and-recipient`, `wrong-mint-rejected`), T16 (`unsorted-owner-accounts`, `wrong-venue-program`) | local |
| S11 | A failed settlement leaves balances intact | single instruction, state written last | T06 (two successful CPIs then a rejected third leg), T09/T16 (every rejection is a simulation against an unchanged ledger) | local |
| S12 | Refunds cannot be disabled by a solver, a failed order or a global pause | `recovery.rs` (cancel is transfer-independent), pause semantics in `config.rs` | T07 (cancel and withdraw while paused, missing-ATA recreation), T24 devnet probe (cancel → withdraw → close) | local, devnet |
| S13 | Prices are authentic for the permitted feed and bound to the verified bytes | `oracle.rs::read_fixture`, `validate_snapshot` | `oracle.rs` unit tests (wrong owner, wrong PDA, corrupt discriminator, wrong publisher signature) | unit |
| S14 | Price age, confidence, exponent and session policy are enforced | `oracle.rs` | `oracle.rs` unit tests (stale, future, wide confidence, wrong exponent, market closed, equality boundaries) | unit |
| S15 | External routing cannot spend outside declared vaults or keep proceeds | `route.rs` (pinned program/pool/vaults, derived caller ATAs), `settle_routed` measured deltas | T16 (wrong venue program, minimum above the quote, venue reserves equal the measured leg, pools end empty) | local |
| S16 | Unreviewed mint extensions and configurations are rejected | `assets.rs::validate_mint_policy`, `Policy::parse` route rules | `assets.rs` unit tests (wrong program, wrong length, authorities, decimals), T08 (`wrong-token-program-rejected`) | unit, local |
| S17 | User keys never reach the solver; server keys never reach the client | `services/api/src/server.ts` holds no key and accepts none; the wallet boundary is `apps/web/src/wallet.ts` | `tests/services/resource-limits.test.ts` (no secret in any response); the service never signs and returns an unsigned transaction | unit |
| S18 | A UI success claim matches reconciled chain state | `apps/web/src/wallet.ts` confirms before reporting; `apps/web/src/App.tsx` reads intents from chain, not from the service | `tests/ui/approval.spec.ts`, `tests/ui/recovery.spec.ts` | unit |
| S19 | Baselines use identical feasible mandates and cost treatment | `services/optimizer/{independent,fixed_netting,cooperative}.py`, `fixed_netting.plan` baseline check | `services/optimizer/test_engines.py` (B may not rewrite A; C never worse than feasible B), `scripts/evaluate-economics.py` validator | unit |
| S20 | Claimed savings distinguish modeled, replayed and realized quantities | `services/optimizer/shared.py` attribution, `docs/evidence/economic-report.md` | `tests/economics/test_evaluation.py` (false cooperative gain, omitted scenario, dropped sensitivity point all fail) | unit |
| S21 | Batch benefit does not conceal worse per-account outcomes | `cooperative.compare` attribution, per-owner rows in the report | `tests/economics/test_evaluation.py`, held-out report per-owner table and one negative netting scenario retained | unit |
| S22 | Admin/config powers cannot silently weaken approved mandates | `config.rs` (expected version, zero outstanding claims, identity pinning) | T07 transcript (unauthorized config update, stale version, policy weakening, changed feed/route with outstanding claims) | local |
| S23 | Public demo operations have bounded resource use | `batch.rs` fixed maxima, `build-batch.ts` budget, ProRata/`largest_remainder` caps | `tests/program/atomic-batch.test.ts` (oversized body, batch size), `properties.test.ts` (band boundaries) | unit |
| S24 | A deployed artifact is traceable to tested source and supported capacity | `build.rs` (compiled manifest), `verify:task` source binding, evidence hashes | T09/T10/T16 checkers bind the built binary hash to the recorded evidence; `scripts/check-deployment.ts` re-verifies the devnet identity | unit, local, devnet |

## Honest gaps

- **S17/S18 now have a service and UI to enforce them, and an independent review of that surface
  is recorded in `.planning/T32-INDEPENDENT-REVIEW.md`.** It found one high finding (recovery was
  unreachable when the service was offline) and two medium ones, all fixed. The real Phantom
  extension flow, any hosting and any multi-tenancy remain untested.
- **S06/S07 are exercised at full weight only on the model and on local transcripts.** Property
  counts here are 60 generated portfolios plus the frozen suite; that is evidence, not proof.
- **S15 is exercised for one leg shape** (a single small sell inside the committed ±200 bps band)
  and only against the synthetic venue. No real venue, no second leg, no devnet route.
- **S13/S14 are exercised with the labelled fixture oracle only.** Pyth is excluded (T15), so no
  authenticated-equity claim is made.
- **S17/S18 are enforced over a loopback, single-deployment, unauthenticated local service.** The
  browser flow is tested with an injected wallet stub and a stubbed RPC; the real Phantom extension
  path, hosting and multi-tenancy are untested.
- **S11 rollback is asserted through simulations and the local transcripts**, not through an
  explicit failing-transaction-on-chain capture on devnet.
- **S23 composed capacity is measured on the local validator** (T16: 451 serialized bytes,
  43 lookup entries, 330,095 CU). Devnet route capacity is unmeasured.
