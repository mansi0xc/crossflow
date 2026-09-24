# CrossFlow executable task ledger

**Status: plan only. None of the commands, tests, application files or acceptance results below exists merely because it is named here.** Implement the verification harness and each task's tests before claiming that task passed. This ledger complements `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md` and the master execution plan. The master plan governs security invariants and release gates; this file governs execution order, ownership and evidence.

## Execution contract

The target deliverable is one bounded, three-strategy-wallet, two-test-stock and test-cash workflow. A capacity fallback follows the master's documented amendment rule, updates R11/task acceptance, reruns economics/demo gates and keeps at least two independently constrained portfolios and one stock plus cash; it cannot pass the original larger-capacity requirement. Each owner funds a selected portfolio slice into a separate intent's vaults and approves final raw-unit bounds. Cooperative adjustment operates within those bounds; arbitrary optimizer output is never authority. Protocol fees are zero. Test assets are never represented as issuer-backed shares. Local validator and devnet are the only write destinations. Pyth integration is conditional on suitable free access; Meteora DBC is optional. An excluded integration is recorded as **EXCLUDED**, never **PASS**.

Use these states: NOT_STARTED → ACTIVE → READY_FOR_REVIEW → DONE; failure becomes BLOCKED or REWORK. Conditional tasks may become EXCLUDED with a dated reason. A dependency is satisfied only by DONE or an explicitly permitted exclusion that leaves the mandatory fallback intact. Never advance a money-path gate with an unresolved critical/high defect.

Every task must produce `artifacts/tasks/<task-id>/<commit-or-tree-hash>/manifest.json`, a concise `result.md`, exact command output, relevant test reports and review findings. The manifest identifies commit/tree hash, tool versions, timestamp, cluster/genesis when applicable, config and fixture hashes, seed, expected versus actual outcomes and reviewer. Never include private keys, API credentials or unredacted authenticated URLs. Label evidence LOCAL, DEVNET, REPLAY or SYNTHETIC. Screenshots supplement transaction/account evidence; they cannot substitute for it.

All commands below are **planned commands** run from repository root after T04 creates the harness. The proposed `pnpm run verify:task -- Txx` dispatcher reads a committed task manifest, runs the named underlying commands, checks artifact freshness and fails on missing/skipped mandatory tests. Before T04, use the named standalone script or documented experiment. Exact package versions and the local Solana testing library are selected by T00 compatibility evidence, then pinned. A command unavailable on the selected stack must be replaced in the task manifest with an equivalent command and reviewed before execution; never silently report it passed.

The implementation owner runs positive and negative tests. A different agent reviews critical financial, authorization and deployment changes in a fresh context. If that reviewer is unavailable, the gate remains unreviewed; self-review is not called independent. Reviewers read actual diffs and evidence rather than accepting another agent's summary. Root integration ownership includes `package.json`, lockfiles, shared schemas, `Anchor.toml` and program entrypoint: workers request changes through that owner rather than racing to edit shared files. Run task checks after every task, affected checks before every merge, the full invariant suite after any shared-schema/accounting/authentication change, and deploy checks after every deployment. The master plan adds periodic and release checks.

Timeboxes below are **focused effort estimates**, not permission to weaken acceptance. Parallel agents can reduce elapsed time after dependencies freeze. Reassess at the end of a timebox; extend with an explicit remaining-time tradeoff, fix the blocker, or exclude only optional scope. Mandatory correctness cannot be cut. Start with T00; do not start all cards simultaneously.

## Dependency waves and ownership

These waves are dependency levels, not dates. A higher-wave independent path may proceed while an unrelated lower-wave task is blocked. Shared file conflicts always require sequencing, even when task dependencies permit parallel work.

| Wave | Tasks | Main ownership / dependency purpose |
|---|---|---|
| 0 | T00 | Integration lead: evidence, access, stack and zero-spend feasibility |
| 1 | T01, T02 | Economics scenarios; protocol/schema specification |
| 2 | T03, T04 | Economic opportunity experiment; reproducible workspace |
| 3 | T05, T11, T14 | Thin funded intent; plan validation; oracle interface |
| 4 | T06, T12, T15 | Thin settlement/recovery; baseline engines; conditional Pyth |
| 5 | T07, T08, T13, T18, T23 | Lifecycle; arithmetic/assets; allocation; UI shell; deployment tooling |
| 6 | T09, T10, T21 | Atomic batch; controlled venue; held-out economics |
| 7 | T16, T20 | Residual integration; receipt/recovery flow |
| 8 | T17, T32 | Adversarial composed money-path suite; API and batch orchestration |
| 9 | T19, T22 | Exact approval flow; independent financial/security integration review |
| 10 | T24 | Complete public devnet workflow |
| 11 | T25, T26, T27, T29 | Optional DBC; resilience; accessible UI; evidence-based claims |
| 12 | T28 | Repeated operation and bounded transaction measurements |
| 13 | T30 | Frozen release rehearsal |
| 14 | T31 | Submission-ready package and human handoff |

The economic spike T03 must pass the master plan's opportunity gate before substantial expansion beyond the thin slice. The work calendar should protect the 25 September 2026 19:30 IST internal readiness target and 26 September 01:30 IST official deadline, subject to T00 verification. Exclude DBC at the master plan's cutoff if it lacks complete evidence. Package whatever is genuinely implemented; do not conceal failures to meet a deadline.

## Task cards

### T00 — Prove the operating constraints before installation or building

**Phase / dependencies / owner / effort:** 0 / none / integration lead, reviewed by technical researcher / 2–3 hours. **Requirements:** R01, R02, R07, R14, R17, R19.

**Files:** `docs/decisions/preflight.md`, `docs/decisions/dependencies.csv`, `docs/operations/cost-ledger.csv`, `scripts/preflight.mjs`, `artifacts/tasks/T00/<commit-or-tree-hash>/`.

**Action:** Recheck the official deadline, sponsor terms and submission requirements. Inventory Anchor 1.1.2, Solana 3.1.10, Cargo 1.91.1 and Node 24.10 without assuming their mutual compatibility. Compile/run a disposable compatible example. Audit package identities, licenses and pinned versions before installs; unclear package identity/license/scripts block installation until an independent dependency review resolves the concern. Verify devnet RPC/faucet, disk capacity, wallet availability, free hosting limitations and a local demo path. Inspect Pyth's free trial terms without purchasing: confirm actual equity entitlement, expiry, credentials and usable verification path. No free entitlement is a documented conditional exclusion, not a core blocker. Record tool versions and zero spending.

**Checks:** Planned `node scripts/preflight.mjs --write-evidence`. Positive: compatible build, expected devnet genesis and free resource path. Negative: supplied mainnet URL, wrong genesis and a priced service configuration are refused without transmitting a write. Manually verify deadline conversion against the official page.

**Done / failure:** An implementable no-spend stack, known cluster identity and explicit Pyth decision exist. If compatibility fails, test one documented compatible pinned set. If money is required, stop that dependency; do not silently consume a paid trial or add a card.

### T01 — Freeze representative economic scenarios before choosing winners

**Phase / dependencies / owner / effort:** 0 / T00 / economics researcher, reviewed by evaluation owner / 2–3 hours. **Requirements:** R08, R09, R20.

**Files:** `research/economics/scenario-spec.md`, `research/economics/scenarios.json`, `research/economics/split-manifest.json`, `scripts/check-scenarios.py`.

**Action:** Define initial holdings, prices, target bands, turnover/risk constraints, cost curves and fee assumptions for independent, fixed-order-netting and cooperative approaches. Commit train/held-out assignment before optimizer tuning. Include opposite flow, all-buy flow, no overlap, asymmetric account sizes, tight bands, zero feasible trades, expensive residual liquidity and price disturbances. Distinguish synthetic inputs from observed/replayed data and document provenance/license. Fix what “equivalent acceptable portfolio outcome” means, including maximum drift and any required progress toward the target; an optimizer must not win by doing nothing.

**Checks:** `python3 scripts/check-scenarios.py`. Positive: every scenario validates and split hashes reproduce. Negative: overlapping train/test IDs, missing costs, impossible target ranges and unlabelled synthetic data fail. Reference portfolios satisfy or explicitly violate constraints as expected.

**Done / failure:** Every scenario has an expected qualitative case and a complete cost model. Correct invalid scenarios without looking at held-out performance; record amendment history. Never delete a losing held-out case because it weakens the pitch.

### T02 — Specify the signed mandate and trust boundaries

**Phase / dependencies / owner / effort:** 1 / T00 / protocol architect, reviewed by independent security reviewer / 3–4 hours. **Requirements:** R03–R06, R10, R12, R13, R20.

**Files:** `docs/spec/intent-contract.md`, `docs/spec/settlement-accounting.md`, `docs/spec/threat-model.md`, `docs/spec/wire-vectors.json`.

**Action:** Specify exact version, network/program domain, owner, nonce, expiry, mint/program/decimals identities, funding amounts, final output minima/maxima, recipient accounts, route policy and reference policy. Choose one authorization flow: the owner's funding transaction commits the complete reviewed mandate into program state; any additional off-chain signature needs its own explicit verification contract. Define lifecycle transitions, cancellation precedence, per-intent vault PDAs, one active intent policy and rent beneficiary. Derive per-mint accounting equations, deterministic raw-unit rounding and owner-attributed dust. Specify authenticated reference guards separately from raw output bounds. Define unsupported assets and signer/account alias rejection.

**Checks:** Planned `pnpm exec vitest run tests/spec/wire-vectors.test.ts`, implemented in T04. Before T04, independently review all vectors and state transitions. Positive: equivalent encoding hashes identically. Negative: one-field changes, alternate domain, ambiguous encodings and duplicated account identities are rejected by expected vectors.

**Done / failure:** Owner authorization and economic bounds are unambiguous. No implementation begins against disputed money semantics; resolve the specification and update vectors first.

### T03 — Reproduce the economic mechanism and test the incremental claim

**Phase / dependencies / owner / effort:** 0 / T01 / economics engineer, reviewed by independent evaluation owner / 4–6 hours. **Requirements:** R08, R09, R17, R20.

**Files:** `research/economics/reference.py`, `research/economics/test_reference.py`, `research/economics/opportunity-report.md`, `research/economics/reference-results.json`.

**Action:** Independently implement the cited cooperative-cost mechanism, or reuse author code only with a verified suitable license. Start with analytically checkable cases. Compute independent execution, netting of the same independently chosen fixed orders, and cooperative trade adjustment under the same mandates. Show objective terms, constraint residuals, costs and per-account trade differences. Include cost/noise sensitivity, negligible/no-benefit cases and solver infeasibility. Assess realistic stock trading cadence and why a multi-strategy operator would use the result.

**Checks:** `python3 -m unittest research/economics/test_reference.py`. Positive: tiny cases match hand calculations and cooperative feasible solutions satisfy unchanged constraints. Negative: deliberately zero trading, weaker target bands or a weakened netting baseline cannot masquerade as improvement. Compare equal starting state and include disclosed execution costs.

**Done / failure:** G0 gets a reproducible, bounded incremental opportunity or a documented negative result. If no credible incremental benefit appears, stop feature expansion, investigate the actual cause and revise claims or product direction explicitly. Do not manufacture a demonstration by removing adverse cases.

### T04 — Create a reproducible workspace and fail-closed verification harness

**Phase / dependencies / owner / effort:** 1 / T00, T02 / integration lead, reviewed by build reviewer / 3–4 hours. **Requirements:** R01–R03, R13, R14, R17, R19.

**Files / ownership:** Root workspace manifests and lockfiles, `Anchor.toml`, `.github/workflows/check.yml`, `scripts/verify-task.mjs`, `verification/tasks/`, `packages/contracts/`, and test scaffolds. This is the exclusive shared-build-file owner.

**Action:** Pin the proven toolchain and reviewed dependencies; establish Rust program, TypeScript client/UI and Python economics locations. Add schema-generated encoders and golden vectors, local test harness, lint/type/build commands, a network-write guard and secret scanning. The task dispatcher records fresh outputs and fails on zero selected tests, skipped mandatory tests, missing evidence or inconsistent config. Create a secrets-free sample environment and local-only defaults. Register later task command manifests through the integration owner. Also create scripts/probe-capacity.ts to serialize the planned maximum transaction envelope (oracle payload/verification instructions, route accounts, all owner vaults, destinations and compute budget) before large implementation work. Distinguish estimates from actual executed capacity; fail an oversize envelope and reduce scope early.

**Checks:** `pnpm run check:workspace`, `pnpm exec vitest run tests/spec/wire-vectors.test.ts`, and `pnpm run verify:task -- T04`. Positive: clean-checkout locked install/build plus vectors. Negative: changed lockfile, missing test selector, forged success report and mainnet write config fail.

**Done / failure:** A second checkout reproduces the same builds and schema hash. Resolve dependency audit or compatibility failures before adding packages; do not unpin versions to make one machine pass.

### T05 — Fund one selected portfolio slice through the real local stack

**Phase / dependencies / owner / effort:** 1 / T04 / protocol implementer, reviewed by protocol reviewer / 3–4 hours. **Requirements:** R03, R04, R06, R12.

**Files:** `programs/crossflow/src/intent.rs`, `programs/crossflow/src/funding.rs`, `programs/crossflow/src/config.rs`, `packages/client/src/fund.ts`, `tests/program/funding.test.ts`, `scripts/demo-local.ts`.

**Action:** First implement one-time configuration initialization: a canonical config PDA, expected initializer identity embedded in the reviewed deployment artifact, network/deployment domain, policy version and registered admin. Require the expected initializer signature; a first caller cannot appoint itself admin. Then implement owner-authorized intent creation and exact funding into mint-specific per-intent vaults, supported basic SPL fixtures and recipient validation. Make create/fund atomic; no committed intent may claim funds it did not receive. Store the schema/domain/nonce and exact mandate. The local script uses a real wallet signature and program call, then prints the deposited slice and recovery instructions. Ordinary token balances elsewhere in the wallet remain outside the mandate.

**Checks:** `pnpm exec vitest run tests/program/funding.test.ts`; `pnpm exec tsx scripts/demo-local.ts --step fund`. Positive: balances move exactly once to the derived vaults and owner metadata matches. Negative: initialize twice, attacker initializing itself as admin, wrong signer, insufficient funds, mismatched mint/decimals, duplicate active intent and substituted recipient revert with no partial debit.

**Done / failure:** A user can fund an inspectable local intent end to end. Stop on any mismatched ledger delta; recover test funds through the validated path before reusing the fixture.

### T06 — Complete the thin local settle, reject and recover slice

**Phase / dependencies / owner / effort:** 1 / T05, T14 / protocol implementer, reviewed by independent protocol reviewer / 3–4 hours. **Requirements:** R04–R06, R11, R13.

**Files:** `programs/crossflow/src/settlement.rs`, `programs/crossflow/src/recovery.rs`, `packages/client/src/recover.ts`, `tests/program/thin-flow.test.ts`, `scripts/demo-local.ts`.

**Action:** Implement the narrow end-to-end settlement path with actual token transfers, final-output checks, receipt event and rent recovery. Add token-transfer-independent cancellation followed by owner-authorized per-asset withdrawals, including expired intents, without a solver dependency. Keep per-asset claims until every refund/surplus is recovered; cancellation succeeds even when one admitted asset cannot transfer. Exercise the same reviewed mandate in a valid case and an invalid output case. Implement only semantics already specified in T02; the thin slice is the first functional proof, not permission to loosen safeguards.

**Checks:** `pnpm exec vitest run tests/program/thin-flow.test.ts`; `pnpm exec tsx scripts/demo-local.ts --step complete`. Positive: fund→settle closes permitted state and returns correct outputs/rent; fund→cancel→withdraw returns each deposit; cancellation itself performs no token transfer. Negative: final output below minimum rolls back all transfers; double settle/cancel and unauthorized recovery fail.

**Done / failure:** G1 has transaction-level local proof of success, rejection and recovery. If invalid settlement changes balances, stop all dependent work until rollback correctness is understood.

### T07 — Harden the complete intent lifecycle and recovery races

**Phase / dependencies / owner / effort:** 2 / T03, T06 / lifecycle owner, reviewed by security reviewer / 4–5 hours. **Requirements:** R03, R04, R13, R15.

**Files:** `programs/crossflow/src/intent.rs`, `programs/crossflow/src/recovery.rs`, `programs/crossflow/src/config.rs`, `packages/client/src/lifecycle.ts`, `tests/program/lifecycle.test.ts`, `tests/program/config.test.ts`.

**Action:** Implement program config update authorization and lifecycle accounting first. The registered admin may pause new funding/settlement without disabling cancellation or per-asset withdrawals. All other policy/feed/route/asset updates require the expected current version, registered admin signature and zero outstanding escrow claims; the open-claim count decreases only when settlement/refunds/surplus recovery truly finish. Existing intents retain their stored policy commitment. Program logic cannot prevent an external retained BPF upgrade authority from replacing code; the separate deployment runbook/trust disclosure governs that power. Implement expiry boundary semantics, monotonically protected owner nonce, no replay after account closure, intent capacity, cancellation/settlement race handling and recovery while new settlements are paused. Use owner signatures and on-chain state as authority. A blockhash timeout alone is not proof a transaction failed. Preserve receipt/query information needed to resolve uncertain results and make retries safe. Keep cancellation independent of transfers and make each asset refundable separately to its fixed owner recipient. Preserve blocked claims until unpause and prohibit closure until all claims/held balances are empty. Baseline SPL fixtures have no freeze authority; reject unadmitted authority/extension policies before funding.

**Checks:** `pnpm exec vitest run tests/program/lifecycle.test.ts tests/program/config.test.ts`. Positive: before/at/after expiry matches specification, nonce advances safely, cancellation wins or loses atomically according to chain order. Negative: nonce reuse, stale cancelled intent, cross-owner refund, wrong rent recipient and replay after closure fail. Unauthorized config update, policy weakening, changed feed/route with outstanding claims and a pause that blocks recovery all fail. A locally injected blocked-asset case cannot prevent cancellation or another asset withdrawal; replaying a completed withdrawal fails.

**Done / failure:** Every allowed and forbidden state transition has a named test, including pause/recovery. Add a missing/closed-recipient-ATA case: the owner recreates the same canonical allowed account in the withdrawal transaction and recovers without solver/admin access; a different recipient is rejected. Display the required devnet SOL/rent prerequisite. Never add a privileged emergency withdrawal as a shortcut to repair a failing owner-recovery design.

### T08 — Lock down supported assets, integer math and dust

**Phase / dependencies / owner / effort:** 2 / T03, T06 / accounting owner, reviewed by independent accounting reviewer / 4–5 hours. **Requirements:** R06, R12, R13.

**Files:** `programs/crossflow/src/assets.rs`, `programs/crossflow/src/math.rs`, `packages/contracts/src/amounts.ts`, `tests/program/assets-math.test.ts`, `tests/contracts/amount-vectors.test.ts`.

**Action:** Enforce the explicit mint/token-program allowlist, expected decimals and recorded authority/extension policy. Store quantities as checked raw integers end to end; make display conversions explicit. Reject unsupported Token-2022 capabilities before funding. Define and implement deterministic round directions and residual-unit assignment so no operator-owned dust pool accumulates. Aggregate and per-owner amounts must remain within bounded numeric ranges. Distinguish booked funding from unsolicited vault donations; excess never expands solver authority, belongs to the owner, remains separately recoverable and cannot be erased on intent consumption/closure.

**Checks:** `pnpm exec vitest run tests/program/assets-math.test.ts tests/contracts/amount-vectors.test.ts`; Rust math tests via the pinned workspace command. Positive: cross-language vectors agree on edge quantities and division remainders. Negative: overflow/underflow, changed mint identity, extension addition, wrong token program, excess decimal precision and account aliasing reject.

**Done / failure:** Every supported asset has a capability record and every residual unit has an owner. Exclude an unsupported asset rather than approximating transfer fees or scaled balances; schema changes trigger T02/T04 vector review.

### T09 — Implement bounded three-wallet atomic internal settlement

**Phase / dependencies / owner / effort:** 2 / T07, T08, T14 / settlement owner, reviewed by independent money-path reviewer / 6–8 hours. **Requirements:** R03–R06, R13.

**Files:** `programs/crossflow/src/settlement.rs`, `programs/crossflow/src/accounts.rs`, `packages/client/src/build-batch.ts`, `tests/program/atomic-batch.test.ts`.

**Action:** Enforce the fixed maximum batch/accounts/mints, unique intents and account roles, correct PDA seeds, account owners, signatures and registered recipients. Wire the T14 oracle authentication/policy guard into the actual settlement instruction before any transfer; enforce its exact integer crossing-price inequalities and optional signed final-value guard. Verify all mandates and reference-policy commitments before settlement; check actual final net outputs, not optimizer-declared amounts. Match internal flows under the committed accounting policy. Account for every input/output per mint, zero protocol fee and allocated dust. Reject invalid plans atomically without creating a solver recovery privilege.

**Checks:** `pnpm exec vitest run tests/program/atomic-batch.test.ts`. Positive: three owners obtain permitted final amounts with exact conservation and closed/terminal intent state. Negative: stale/forged/wrong-feed oracle inside the actual settlement (not just its helper), one underfilled owner, one exceeded maximum, repeated owner/vault, substitute signer/program, duplicated mint, wrong nonce, overflow or an oversized batch reverts every participant. Donation-before-settlement cannot change booked F-D+C accounting or let the solver extract surplus; exercise surplus recovery after terminal settlement.

**Done / failure:** A rejected final participant leaves all earlier participants unchanged. Any counterexample blocks the batch feature and every dependent integration until a regression test and fix pass independent review.

### T10 — Build an honest controlled residual venue and route interface

**Phase / dependencies / owner / effort:** 3 / T08 / venue owner, reviewed by adapter reviewer / 4–5 hours. **Requirements:** R06, R10, R17, R20.

**Files:** `programs/test-venue/`, `packages/adapters/src/types.ts`, `packages/adapters/src/controlled.ts`, `tests/adapters/controlled-venue.test.ts`.

**Action:** Implement a deliberately labelled deterministic test liquidity venue for local/devnet residual orders and an adapter contract containing program/pool identity, input maximum, output minimum and allowed accounts. Use actual test token transfers and a documented quote/liquidity model; seed reserves with test tokens only. Put venue setup/admin keys apart from portfolio owners. The interface must make route simulation and measured output available without assuming Jupiter supports fixture mints on devnet.

**Checks:** `pnpm exec vitest run tests/adapters/controlled-venue.test.ts`. Positive: quotes and actual exact-in deltas agree under documented rounding. Negative: insufficient reserves, wrong pool/token program, malicious output account, expired quote and reserve changes causing min-output failure reject or revert.

**Done / failure:** External residual liquidity in the demo is real test-token execution with transparent provenance. If the interface cannot enforce custody/account restrictions, block T16; do not replace execution evidence with a UI animation.

### T11 — Implement a solver-independent mandate and plan validator

**Phase / dependencies / owner / effort:** 3 / T02, T03, T04 / contracts owner, reviewed by protocol reviewer / 3–4 hours. **Requirements:** R03, R05, R06, R08.

**Files:** `packages/planner/src/validate.ts`, `packages/planner/src/mandate.ts`, `tests/planner/validation.test.ts`, `tests/planner/differential-vectors.json`.

**Action:** Convert selected portfolio targets into reviewable raw-unit lower/upper outcomes without floating-point authority. Validate each candidate independently from optimization code, including funding consistency, feasible outputs, nonce/expiry, route policies, zero fees, ownership and reference-policy requirements. Preserve the distinction between allocation preferences and on-chain signed bounds. Reject NaN/infinity, imprecise JSON numbers and untrusted extra fields. Produce human-readable reasons for rejected plans.

**Checks:** `pnpm exec vitest run tests/planner/validation.test.ts`. Positive: canonical valid plans survive encode/decode unchanged. Negative: a malicious solver's forged totals, relaxed target limits, altered recipient and wrong domain fail. Differential vectors match Rust acceptance/rejection once T09 is available.

**Done / failure:** UI and settlement builder consume validated typed data only. Divergent Rust/TypeScript results block integration; fix the contract rather than accepting whichever side is more permissive.

### T12 — Implement the three fair execution engines

**Phase / dependencies / owner / effort:** 3 / T11 / optimizer owner, reviewed by evaluation owner / 5–6 hours. **Requirements:** R08, R09, R20.

**Files:** `services/optimizer/independent.py`, `services/optimizer/fixed_netting.py`, `services/optimizer/cooperative.py`, `services/optimizer/test_engines.py`, `services/optimizer/README.md`.

**Action:** Move the verified reference model into deterministic engines sharing one scenario, mandate and cost representation. Fixed netting must use orders produced by the independent engine, not deliberately inferior orders. Cooperative optimization may change trades only inside the same approved feasible region. Expose solver status, feasibility residuals, iteration/time limits and seed. Reject non-convergence/infeasibility; never round a continuous solution into a violating executable plan. Retain the validated independent result as an honestly labelled fallback, not a fabricated cooperative success.

**Checks:** `python3 -m unittest discover -s services/optimizer -p 'test_engines.py'`. Positive: analytical cases and deterministic replay reproduce. Negative: infeasible bands, invalid cost functions, timeout, nonfinite solution and rounding-induced violations fail closed.

**Done / failure:** All three engines emit comparable validated proposals and explicit status. A solver failure cannot become a signable plan; investigate or present the feasible fallback with its actual label.

### T13 — Explain and allocate costs without hiding harmed participants

**Phase / dependencies / owner / effort:** 3 / T12 / economics/accounting owner, reviewed by independent economics reviewer / 3–4 hours. **Requirements:** R06, R08, R09, R20.

**Files:** `packages/planner/src/costs.ts`, `packages/planner/src/comparison.ts`, `tests/planner/cost-allocation.test.ts`, `docs/spec/cost-allocation.md`.

**Action:** Report per-owner and aggregate predicted external costs, internal transfer quantities, network/rent assumptions, turnover and target drift. Separate recoverable rent from trading cost and estimated execution cost from realized deltas. Define a deterministic disclosed residual cost allocation; enforce every owner's signed outputs regardless of aggregate savings. Show if a participant is worse than its baseline. Do not claim universal Pareto improvement, privacy or incentive compatibility without proof.

**Checks:** `pnpm exec vitest run tests/planner/cost-allocation.test.ts`. Positive: owner allocations sum to disclosed totals, with exact raw-unit reconciliation. Negative: hidden protocol fee, unallocated dust, negative unsupported rebates and aggregate savings masking a violated owner bound fail. Include a case with aggregate benefit but unequal participant outcomes.

**Done / failure:** Comparison and receipts distinguish estimate from realization and label all assumptions. If an allocation cannot satisfy every signed mandate, decline settlement instead of redistributing losses silently.

### T14 — Implement authenticated-reference policy with a labelled fixture path

**Phase / dependencies / owner / effort:** 3 / T00, T02, T04 / oracle owner, reviewed by security reviewer / 3–4 hours. **Requirements:** R05, R07, R13, R20.

**Files:** `programs/crossflow/src/oracle.rs`, `packages/oracle/src/policy.ts`, `packages/oracle/src/fixture.ts`, `tests/oracle/policy.test.ts`, `docs/spec/oracle-policy.md`.

**Action:** Separate source authentication, selected feed identity, exponent/range checks, source update time, allowed age, confidence policy and market-session behavior. Freeze numerical age/future-skew/confidence/exponent/deviation limits, supported market sessions, and the precise integer inequality constraining each internal stock/cash cross and any final-value guard. Test equality and one-unit-outside each boundary. An authenticated price must affect acceptance, not merely display. It cannot guarantee venue fills. Bind policy/version to the mandate. Implement a fixture oracle only for explicitly labelled test mode, with configured authority and no ability to pretend it is Pyth. Public devnet configuration exposes which mode is active and rejects policy/source substitution.

**Checks:** `pnpm exec vitest run tests/oracle/policy.test.ts`. Positive: valid data within every configured policy bound is accepted. Negative: wrong feed/source signer, future timestamps, stale underlying equity value, unsupported confidence interpretation, wrong exponent and fixture data submitted as Pyth reject.

**Done / failure:** Core settlement has a testable fail-closed reference guard even when R07 is excluded. Never accept a fresh transport timestamp as proof that the underlying stock price is fresh.

### T15 — Integrate real Pyth equity verification only if free access works

**Phase / dependencies / owner / effort:** 3 / T14 / oracle owner, reviewed by independent integration reviewer / 4–6 hours. **Requirements:** R07, R13, R17, R20. **Conditional:** may be EXCLUDED only with T14's labelled core path intact.

**Files:** `packages/oracle/src/pyth.ts`, `programs/crossflow/src/oracle_pyth.rs`, `tests/oracle/pyth-verification.test.ts`, `scripts/probe-pyth.ts`, `docs/evidence/pyth-integration.md`.

**Action:** Use the currently documented Pyth Pro Solana devnet path and actual entitled equity feed. Keep API keys server-side. Capture permitted samples without leaking credentials, distinguish source-update and message timestamps, and implement the exact Ed25519 instruction plus verifier-CPI flow required by the pinned SDK. Verify feed metadata and policy independently. Reserve final full-transaction feasibility for T17/T24; a verifier-only transaction does not prove the whole batch fits.

**Checks:** `pnpm exec vitest run tests/oracle/pyth-verification.test.ts`; `pnpm exec tsx scripts/probe-pyth.ts --cluster devnet`. Positive: authenticated entitled sample passes verification and affects the crossing guard. Negative: signature bit flip, altered payload, wrong feed, missing verification instruction and carried-forward stale equity value fail.

**Done / failure:** Record real devnet signature, data age and access expiry, or EXCLUDED with exact blocker. Never purchase access, expose a key, claim sponsorship for a fixture or let unavailable Pyth block the core demonstration.

### T16 — Compose residual execution with atomic settlement

**Phase / dependencies / owner / effort:** 3 / T09, T10 / adapter owner, reviewed by money-path reviewer / 4–6 hours. **Requirements:** R05, R06, R10, R13.

**Files:** `programs/crossflow/src/route.rs`, `packages/client/src/build-route.ts`, `tests/program/routed-batch.test.ts`.

**Action:** Allow only registered venue programs, pools, token accounts and instruction forms. Bound each debit, require exact measured net receipts, reload token balances after CPI and enforce final owner outcomes after all venue effects. Include venue reserve movement in the conservation boundary. Restrict signer privileges; a venue must not choose arbitrary destinations or dispatch arbitrary programs.

**Checks:** `pnpm exec vitest run tests/program/routed-batch.test.ts`. Positive: an internal cross plus residual swap reconciles every owner and pool delta. Negative: malicious venue output, excessive debit, changed accounts, low output and failure after an earlier transfer revert the whole batch, excluding transaction fees.

**Done / failure:** Routed settlement meets every T09 invariant. A malicious-adapter counterexample blocks integration; disable that route, fix and independently retest before enabling it.

### T17 — Attack the composed money path and measure the complete transaction

**Phase / dependencies / owner / effort:** 2 / T15 resolved, T16 / adversarial test owner, reviewed by independent security reviewer / 6–8 hours. **Requirements:** R01, R03–R07, R10, R12–R15.

**Files:** `tests/security/adversarial.test.ts`, `tests/security/properties.test.ts`, `scripts/measure-batch.ts`, `docs/evidence/security-matrix.md`.

**Action:** Exercise malicious solver, caller, oracle and venue combinations against the actual program. Generate reproducible bounded random portfolios, raw-unit boundary cases, account permutations and state sequences; retain minimized failing seeds. Cross-check an independent conservation model. Measure the exact full transaction with signatures, compute instructions, oracle proof, settlement, residual venue and receipts. Check real runtime/packet limits and headroom; address lookup tables do not increase compute or remove loaded-account limits.

**Checks:** `pnpm exec vitest run tests/security/adversarial.test.ts tests/security/properties.test.ts`; `pnpm exec tsx scripts/measure-batch.ts --full`. Positive: valid generated batches settle/reconcile. Negative: each attack category rejects without unauthorized asset movement; max+1 batch, oversized proof and compute exhaustion are handled. Test both fixture and real Pyth paths when enabled.

**Done / failure:** G2 evidence covers every money invariant and complete transaction fit. Zero unresolved critical/high findings. Never split a claimed atomic batch to hide capacity failure; revise architecture explicitly and repeat all affected checks.

### T18 — Give a user a clear selected-slice workflow early

**Phase / dependencies / owner / effort:** 4 / T06 / UI owner, reviewed by UX reviewer / 4–5 hours. **Requirements:** R01, R11, R20.

**Files:** `apps/web/src/routes/prepare.tsx`, `apps/web/src/components/PortfolioSlice.tsx`, `apps/web/src/network.ts`, `tests/ui/prepare.spec.ts`.

**Action:** Show devnet identity, test-asset labels, available versus selected balances, target bands and the funded-escrow explanation. Offer deterministic scenario loading without pretending fixtures are wallet-owned until minting/funding completes. Use exact display conversion and visible errors. A connected wallet is not an authorization. Give users a recovery route before asking them to lock assets.

**Checks:** `pnpm exec playwright test tests/ui/prepare.spec.ts`. Positive: a fresh user understands the selected slice and proceeds with valid values. Negative: wrong cluster, unsupported mint, excess precision, insufficient balance and invalid ranges block continuation with a specific explanation.

**Done / failure:** A reviewer follows preparation without developer instructions. Fix misleading custody or amount text before implementing the approval screen.

### T19 — Compare plans and approve the exact executable mandate

**Phase / dependencies / owner / effort:** 4 / T09, T13, T18, T32 / approval UI owner, reviewed by security/UX reviewer / 4–6 hours. **Requirements:** R03, R08, R09, R11, R20.

**Files:** `apps/web/src/routes/compare.tsx`, `apps/web/src/routes/approve.tsx`, `apps/web/src/transactions/fund.ts`, `tests/ui/approval.spec.ts`.

**Action:** Present three named approaches with per-owner outputs, drift, costs, assumptions and negative/no-benefit results. Render review amounts from the same validated object serialized into the transaction. Show max funding, final bounds, expiry, routes and oracle mode. Detect changed wallet, balance, plan hash or policy and require a refreshed review. Submit only the user's funding authorization; never store owner private keys server-side.

**Checks:** `pnpm exec playwright test tests/ui/approval.spec.ts`. Positive: approved values equal committed raw units. Negative: plan mutation, stale balance, declined wallet signature, malicious return data and wallet switch cannot fund the previously reviewed plan silently.

**Done / failure:** Wallet signing is intentional and mandate-exact. Any display/signature mismatch blocks release, even if settlement itself would enforce the altered values.

### T20 — Make finality, receipts and recovery understandable

**Phase / dependencies / owner / effort:** 4 / T07, T09, T18 / receipt UI owner, reviewed by recovery reviewer / 4–5 hours. **Requirements:** R04, R06, R11, R15.

**Files:** `apps/web/src/routes/intent.tsx`, `apps/web/src/routes/receipt.tsx`, `apps/web/src/transactions/status.ts`, `tests/ui/recovery.spec.ts`.

**Action:** Model awaiting signature, submitted, confirmation uncertain, settled, cancelled, expired and refundable states from chain evidence. Re-query signatures and intent state before retrying. Persist identifiers locally without credentials. Reconstruct actual raw balances/outputs and rent recovery; separate estimates from realized receipts. Link correct devnet Explorer URLs. Recovery needs the owner and chain, not an available optimizer/oracle.

**Checks:** `pnpm exec playwright test tests/ui/recovery.spec.ts`. Positive: refresh/reconnect restores state and cancellation returns deposits. Negative: dropped RPC response cannot produce false success or duplicate authorization; failed settlement shows charged network fees separately from reverted asset changes.

**Done / failure:** A user can resolve uncertainty and recover without developer intervention. Unknown state remains visibly unknown until reconciled; never equate browser timeout with on-chain failure.

### T21 — Run the held-out evaluation and decide what is supportable

**Phase / dependencies / owner / effort:** 3 / T13 / evaluation owner, reviewed independently from optimizer author / 4–5 hours. **Requirements:** R08, R09, R14, R20.

**Files:** `scripts/evaluate-economics.py`, `tests/economics/test_evaluation.py`, `docs/evidence/economic-results.json`, `docs/evidence/economic-report.md`.

**Action:** Run the precommitted held-out matrix once against frozen engines and cost conventions, preserving all outcomes. Report feasibility, target deviation, turnover, total/per-owner costs and C-versus-B incremental savings separately from B-versus-A. Include latency, fee and adverse-liquidity sensitivity and quantify assumptions. Explain that replayed equal-state comparisons differ from sequential live trades that change reserves. Do not tune on holdout and still call it untouched.

**Checks:** `python3 scripts/evaluate-economics.py --split heldout`; `python3 -m unittest discover -s tests/economics`. Positive: fresh execution reproduces result hashes/tolerances. Negative: changed split, omitted losing case, differing mandates and missing costs fail the report validator.

**Done / failure:** Every economic claim has a scenario/evidence pointer. If advantage disappears, remove unsupported claims and reopen the opportunity decision before polishing the pitch.

### T22 — Independently review money movement before integrated devnet use

**Phase / dependencies / owner / effort:** 2 / T17, T21, T32 / independent reviewer, fixes owned by original authors / 4–6 hours.
**Requirements:** R03–R06, R10, R12–R14, R20.

**Files:** `docs/reviews/money-path-review.md`, `docs/reviews/findings.json`, `tests/security/review-regressions.test.ts`.

**Action:** Review specs, actual code, privileges, account graph, economic comparisons and test counterexamples. Trace each invariant to enforcement and tests, including T32 service resource bounds, signer separation and status reconciliation. Examine admin/upgrades, cancellation liveness, nonce persistence, stale Pyth inputs, alias accounts and malicious CPI. Classify findings by impact/likelihood, assign owners, and independently verify repairs. Check licenses and absence of unacknowledged prior-art claims.

**Checks:** `pnpm run verify:task -- T22` runs the full money suite and findings validator. Positive: every invariant has evidence and fixed findings have regression tests. Negative: any open critical/high finding, stale review commit or missing attack category blocks the gate.

**Done / failure:** Independent review is current for the integrated money-path commit. This is a scoped engineering review, not an external audit certificate. Reopen review when affected code or authority policy changes.

### T23 — Prepare safe deployment, configuration and recovery tooling

**Phase / dependencies / owner / effort:** 4 / T06 / deployment owner, reviewed by release reviewer / 3–4 hours. **Requirements:** R01, R02, R14, R15, R17.

**Files:** `scripts/deploy-devnet.ts`, `scripts/check-deployment.ts`, `scripts/smoke-devnet.ts`, `docs/operations/deployment.md`, `tests/operations/network-guard.test.ts`.

**Action:** Separate deployment authority, venue setup and demo owner keys. Enforce RPC genesis, expected devnet program/config IDs and test-only mint registry before every write. Simulate before deployment/use where supported, retain verifiable build identifiers and initialize once with constrained authority. Document pause, owner refunds, compatible upgrade and incompatible redeployment procedures. Preserve old funded intents until recovered; never treat redeployment as a migration of escrow claims.

**Checks:** `pnpm exec vitest run tests/operations/network-guard.test.ts`; `pnpm exec tsx scripts/deploy-devnet.ts --dry-run`. Positive: authorized devnet plan is explicit. Negative: mainnet URL/genesis, wrong program, accidental production mint, repeated initialization and key leakage fail before writes.

**Done / failure:** Deployment runbook is reversible where possible and names irreversible actions. Dry-run success is not deployment evidence; public integrated deployment waits for T24 dependencies. After T06, a disposable isolated thin-slice devnet probe is permitted only under the master plan's scoped-review exception, with no shared funded intents and no integration claim for estimated components. Capture real transfer/recovery evidence and compare envelope measurements from T04; final composed proof remains T17/T24.

### T24 — Prove the complete workflow on public devnet

**Phase / dependencies / owner / effort:** 4 / T19, T20, T22, T23 / integration lead, reviewed by independent release reviewer / 4–6 hours. **Requirements:** R01, R04–R07, R10, R11, R14, R15.

**Files:** `docs/evidence/devnet-manifest.json`, `tests/e2e/devnet.spec.ts`, `scripts/devnet-scenarios.ts`, `docs/evidence/devnet-runs.md`.

**Action:** Deploy the reviewed build, initialize test assets/venue, and run fresh wallets through plan→fund→settle→receipt. Include a real residual route, rejected malicious plan, expiry/cancel recovery and no-match scenario. Record program/config/mint identities and transaction signatures. If Pyth is enabled, use its real verifier in the full settlement; if excluded, prominently show fixture mode. Reconcile measured token balances from chain, not logs alone.

**Checks:** `pnpm exec tsx scripts/check-deployment.ts`; `pnpm exec tsx scripts/devnet-scenarios.ts`; `pnpm exec playwright test tests/e2e/devnet.spec.ts`. Negative: deliberate below-minimum batch reverts every participant; wrong-cluster client refuses to sign.

**Done / failure:** G4 requires actual repeatable devnet evidence and supported transaction capacity. RPC/faucet failures invoke the recovery runbook; local success cannot be relabelled devnet success.

### T25 — Add a genuine DBC residual route only if it earns its place

**Phase / dependencies / owner / effort:** 4 / T24 / optional adapter owner, reviewed by venue/release reviewers / 4–6 hours maximum before cutoff. **Requirements:** R10, R18, R20.

**Files:** `packages/adapters/src/meteora-dbc.ts`, `tests/adapters/dbc-devnet.test.ts`, `docs/evidence/dbc-integration.md`.

**Action:** Verify current official devnet program identity and pinned SDK. Create a compatible test pool, prove buy/sell directions and fees, then integrate a residual order into the complete atomic batch. Explain the launch-curve use case and limitation honestly. No keeper/migration service or real token launch is required. Never claim a controlled venue or DLMM integration satisfies DBC.

**Checks:** `pnpm exec vitest run tests/adapters/dbc-devnet.test.ts` plus complete T17/T24 route regression. Positive: real pool/signature evidence and exact net deltas. Negative: incompatible mint, min-output failure and wrong program reject safely.

**Done / failure:** Not scheduled by default given the narrow critical-path reserve. Admit only after the core passes early enough to preserve the full implementation/review/regression timebox and release buffer. Retain only if useful, fully verified and before cutoff. Otherwise EXCLUDED, remove UI/sponsor claims and keep the proven core route. Technical integration alone does not guarantee sponsor eligibility.

### T26 — Rehearse operational failures and owner recovery

**Phase / dependencies / owner / effort:** 4 / T24 / resilience owner, reviewed by independent recovery reviewer / 3–4 hours. **Requirements:** R04, R07, R11, R13–R15.

**Files:** `tests/e2e/faults.spec.ts`, `scripts/inject-faults.ts`, `docs/operations/recovery-drills.md`.

**Action:** Interrupt solver, Pyth fetcher, RPC responses and browser sessions; exhaust test liquidity; let intents expire. Rehearse pause of new settlement while retaining owner refund authority. If any admitted asset can externally freeze, demonstrate cancellation and per-asset claim retention without requiring a blocked token transfer to unlock available assets; otherwise prove such assets are rejected. Verify resumption after the blocking condition clears.

**Checks:** `pnpm exec playwright test tests/e2e/faults.spec.ts`; local fault injection for deterministic races. Positive: users recover available deposits and reconnect to correct state. Negative: no service outage authorizes weaker price policy, new spend or alternate recipient.

**Done / failure:** Every drill records symptoms, diagnosis and recovery. If recovery requires secret backend intervention, fix the architecture; do not describe that path as owner-controlled.

### T27 — Polish the presentation without changing financial semantics

**Phase / dependencies / owner / effort:** 4 / T24 / UI owner, reviewed by unfamiliar UX reviewer / 3–4 hours. **Requirements:** R11, R16, R20.

**Files:** `apps/web/src/styles/`, `apps/web/src/components/Explainer.tsx`, `tests/ui/accessibility.spec.ts`, `docs/evidence/usability.md`.

**Action:** Make the problem, three comparisons, approval and result readable within minutes. Add keyboard/focus handling, contrast, non-color status cues, responsive layouts, helpful empty/error states and explicit test-asset/oracle labels. Explain funded escrow, bounds and recovery in plain language. Ensure tooltips are not the only disclosure location. Include no-benefit outcomes naturally.

**Checks:** `pnpm exec playwright test tests/ui/accessibility.spec.ts` plus T19/T20 regressions. Positive: an unfamiliar reviewer completes the path and explains its result. Negative: loading errors cannot appear as zero cost or success; long values and keyboard navigation preserve visibility.

**Done / failure:** No unexplained critical workflow step remains. Monetary display/encoding changes reopen T08/T19, even when introduced as visual polish.

### T28 — Run repeated bounded operations and measure reliability honestly

**Phase / dependencies / owner / effort:** 5 / T24, T26 / validation owner, reviewed by release reviewer / 3–5 hours. **Requirements:** R13–R15, R20.

**Files:** `scripts/soak.ts`, `tests/security/soak-properties.test.ts`, `docs/evidence/soak-report.json`, `docs/evidence/capacity-report.md`.

**Action:** Run seeded local sequences covering every lifecycle transition and repeated fresh devnet flows under free-service rate limits. Record count, seeds, failure categories, compute, serialized size, confirmation times and rent recovery. Include maximum supported batch plus max+1 rejection. Separate chain/RPC outages from application defects. Finite tests provide evidence, not proof of universal safety.

**Checks:** `pnpm exec tsx scripts/soak.ts --profile release`; `pnpm exec vitest run tests/security/soak-properties.test.ts`. Positive: every successful run reconciles and every failed run leaves permitted state. Negative: retained vault dust, unrecoverable intent or unknown transaction result fails the gate.

**Done / failure:** All planned cases have outcomes; safety failures are zero. Explain availability failures quantitatively and fix/retest deterministic defects instead of deleting inconvenient runs.

### T29 — Build the evidence-based project story and disclosures

**Phase / dependencies / owner / effort:** 5 / T21, T24 / documentation owner, reviewed by skeptical judge reviewer / 3–4 hours. **Requirements:** R09, R16, R18–R20.

**Files:** `README.md`, `docs/demo-script.md`, `docs/submission-draft.md`, `docs/claims-ledger.csv`, `docs/THIRD_PARTY_NOTICES.md`.

**Action:** Explain a real multi-strategy operator's problem, the extra cooperative adjustment beyond netting, the precise user workflow and reproducible results. Cite papers/prior implementations and distinguish reused code. Map every claim to evidence and a limitation. Disclose test assets, oracle mode, escrow/admin model, optional exclusions and absence of mainnet validation. Draft sponsor claims only for verified integrations; avoid guaranteed savings, real shareholder rights or production readiness.

**Checks:** `pnpm run verify:task -- T29` checks evidence links, claim status, source licenses and mandatory submission fields. Reviewer challenges each headline against actual results.

**Done / failure:** An unfamiliar judge can understand and verify the story. Unsupported sentences are removed or qualified; evidence is not retroactively invented to preserve a headline.

### T30 — Freeze and rehearse the actual release candidate

**Phase / dependencies / owner / effort:** 5 / T25 resolved, T27, T28, T29 / release lead, reviewed independently / 4–5 hours. **Requirements:** R02, R13–R16, R20.

**Files:** `docs/release-manifest.json`, `docs/release-checklist.md`, `docs/evidence/rehearsal.md`, `docs/local-demo-runbook.md`.

**Action:** Freeze the candidate commit/config, run from a fresh checkout/wallet, confirm public/local entry points and verify all enabled paths. Rehearse the timed demo including malicious rejection and recovery. Record a video from the actual build and retain local demo instructions plus screenshots for connectivity failures. Confirm secrets excluded, links public as intended, trial expiry covers the demo and no last-minute mutation invalidates evidence.

**Checks:** `pnpm run verify:release`; fresh-checkout build; full local regression; post-deploy smoke. Positive: release manifest matches executable build, program and demo. Negative: stale evidence, unreviewed money changes, missing licenses or false optional PASS blocks readiness.

**Done / failure:** G5 is satisfied by the internal readiness target. Any code/config change afterward reruns its affected gates; major money changes reopen independent review. Never trade correctness for a cosmetic last-minute addition.

### T31 — Deliver a submission-ready package and clear handoff

**Phase / dependencies / owner / effort:** 5 / T30 / submission owner, reviewed by user and release reviewer / 1–2 hours plus deadline buffer. **Requirements:** R14, R16, R17, R19, R20.

**Files:** `docs/submission-checklist.md`, `docs/submission-draft.md`, `docs/final-handoff.md`, `.planning/STATE.md`.

**Action:** Check the current official portal requirements, deadline and track wording again. Prepare exact title, description, repository/demo/video links, disclosures and evidence references. Give the user an inspectable final package and clear instructions for submission. This planning task authorizes neither publication nor portal submission; actual external actions require appropriate user authorization at execution. Track receipt/status only after a real submission response exists.

**Checks:** `pnpm run verify:submission` validates required fields, reachable intended links and release hashes; a human reviews the rendered submission. Negative: draft/private/broken links, mismatched video build, unverified sponsor integration and missing source disclosures fail.

**Done / failure:** Submission-ready artifacts and remaining human actions are explicit before the buffer expires. If submitted later with authorization, record the confirmation/time. Never mark “submitted” because a form was prepared.

### T32 — Connect optimization, funded intents and settlement into one bounded service

**Phase / dependencies / owner / effort:** 3 / T11, T12, T13, T16, T23 / integration service owner, reviewed by security and client reviewers / 4–6 hours. **Requirements:** R01, R03, R05, R08–R11, R13–R15, R17, R19, R20. **Execution note:** this late-added task ID executes in wave 8, before T19/T22; numerical IDs do not imply order.

**Files:** `services/api/src/server.ts`, `services/api/src/optimizer-runner.ts`, `services/api/src/intent-index.ts`, `services/api/src/batch-coordinator.ts`, `packages/client/src/api.ts`, `packages/client/src/submit-settlement.ts`, `tests/services/orchestration.test.ts`, `tests/services/resource-limits.test.ts`, `docs/spec/service-api.md`.

**Action:** Implement the missing application connection explicitly. `POST /plans` accepts only the versioned bounded portfolio schema, calls a fixed local numerical runner without shell interpolation, converts its result to canonical integer-string JSON and independently validates it through T11 before responding. Never expose arbitrary scripts, URLs, filesystem paths or executable commands. `GET /intents` discovers the configured devnet program's funded intents from chain state; caches are advisory. `POST /batches/prepare` reloads the actual funded mandates, recomputes/validates an eligible bounded batch, attaches the approved price and route inputs and builds the unsigned settlement transaction. The designated operator wallet reviews/signs/pays the devnet network fee and broadcasts through the guarded client; the service never receives user signing keys. Record the operator fee policy in all three economic baselines. Index only the configured program/asset domain, reject unknown status and propagate cancellation/expiry. The browser uses these APIs rather than hard-coded result fixtures. Reconcile submission signatures and state before retrying; one attempt ID cannot enqueue repeated settlement work. Chain replay protection remains the final authority. Treat all intents/strategies as publicly visible; no privacy claim.

Define actual limits in the committed service config: request bytes, three owners/three selected mints maximum, numerical time/iteration budget, concurrent jobs, per-client and global rate limits, chain-read timeout and at most three bounded retries. Numerical workers must be terminated/cleaned up on timeout. Server-only Pyth secrets and allowlisted price requests are mandatory if Pyth is enabled. Never add a cloud model/API dependency. Persistent recovery comes from chain state; process restart cannot lose the only record of escrow or generate a new owner authorization.

**Checks:** `pnpm exec vitest run tests/services/orchestration.test.ts tests/services/resource-limits.test.ts`. Positive: HTTP request → real numerical engine → independent integer validator → funded-intent reload → unsigned batch → operator signature → local-chain settlement → reconciled receipt completes without manually pasting outputs. Negative: oversized payload/asset list, numeric precision loss, malicious subprocess input, solver hang/nonfinite result, disconnected numerical process, unknown RPC URL, stale/cancelled intent, changed oracle mode, duplicate attempt, rate-limit flood, delayed send response and service restart fail safely or recover existing state. Verify no API key in responses/logs and no user private key in service storage. A fabricated index entry never becomes a signable batch.

**Done / failure:** A complete local program-backed service path and client contract exist with bounded resource behavior. T19 and T22 remain blocked until this wiring passes. An API that returns static scenario JSON does not meet acceptance. If a Python subprocess cannot be operated safely, use a documented local process transport with equivalent limits; do not bypass the independent validation boundary.

## Task closure and handoff template

Copy this into each task's `result.md`; all fields are required or explicitly not applicable:

1. **Identity:** task, owner, independent reviewer, start/end time, source commit and final tree hash.
2. **Scope:** requirements addressed, files changed, interface/schema changes, assumptions resolved, excluded conditional scope.
3. **Behavior:** what a user can now do; exact positive and rejection cases, including any boundary cases still unproved.
4. **Verification:** exact commands, exit statuses, selected/executed/skipped test counts, seeds, environments, expected/actual results and artifact links.
5. **Security/accounting:** invariants touched, asset deltas, authorization review, no-mainnet-write evidence and unresolved findings by severity.
6. **Operations:** deployment/config changes, key handling, costs actually incurred, RPC/API limits, remaining entitlement lifetime and recovery impact.
7. **Review:** reviewer findings and fixes, freshness relative to reviewed commit; independent versus self-review accurately labelled.
8. **Disposition:** DONE, REWORK, BLOCKED or allowed EXCLUDED, with reason. State next eligible task IDs and any dependency that must be reopened.

When handing off, read current files before editing; do not trust old summaries. Retain failing cases, do not rewrite another worker's changes to match a stale plan, and request integration-owner changes to shared contracts. Record scope decisions in the decision log. Update `.planning/STATE.md` only through the current integration lead.

## Requirement coverage audit

This table maps planned work, **not achieved compliance**. Mandatory requirements may be marked complete only when linked task evidence and the applicable master-plan gate pass.

| Requirement | Tasks |
|---|---|
| R01 Network boundaries | T00, T04, T17, T18, T23, T24, T32 |
| R02 Reproducibility/dependencies | T00, T04, T23, T30 |
| R03 Schema/authorization/replay | T02, T04, T05, T07, T09, T11, T17, T19, T22, T32 |
| R04 Escrow/recovery | T02, T05, T06, T07, T20, T22, T24, T26 |
| R05 Mandate enforcement | T02, T06, T09, T11, T14, T16, T17, T22, T24, T32 |
| R06 Conservation/rounding | T02, T05, T06, T08–T11, T13, T16, T17, T20, T22, T24 |
| R07 Conditional Pyth | T00, T14, T15, T17, T24, T26 |
| R08 Fair baselines | T01, T03, T11–T13, T19, T21, T32 |
| R09 Economic evaluation | T01, T03, T12, T13, T19, T21, T29, T32 |
| R10 Safe residual routing | T02, T10, T16, T17, T22, T24, T25, T32 |
| R11 End-to-end user workflow | T06, T18–T20, T24, T26, T27, T32 |
| R12 Asset semantics | T02, T05, T08, T17, T22 |
| R13 Security testing/review | T02, T04, T06–T09, T14–T17, T22, T26, T28, T30, T32 |
| R14 Evidence/gates | T00, T04, T17, T21–T24, T26, T28, T30, T31, T32 |
| R15 Deployment/recovery | T07, T17, T20, T23, T24, T26, T28, T30, T32 |
| R16 Demo/submission | T27, T29–T31 |
| R17 Zero-spend boundary | T00, T03, T04, T10, T15, T23, T31, T32 |
| R18 Conditional DBC | T25, T29 |
| R19 Coordination/handoff | T00, T04, T29, T31, T32 and every task closure |
| R20 Truthful claims | T01–T03, T10, T12–T15, T18, T19, T21, T22, T25, T27–T31, T32 |

The source audit also covers all six roadmap outcomes: G0→T00–T03; G1→T02/T04–T06; G2→T07–T09/T17/T22; G3→T10–T16/T21; G4→T18–T20/T23–T27; G5→T28–T31. Research constraints are assigned to preflight/capacity (T00/T04/T06/T23/T17), authenticated Pyth (T14/T15), extension/refund handling (T07/T08/T26), DBC (T25), economic validity (T01/T03/T12/T21), dependency legitimacy (T00/T04), and claim provenance (T29). Deferred product expansions are not implementation tasks.

## Invariant-to-execution coverage

Every listed test is planned, not already passing. T22 reviews all S01–S24; T30 checks evidence freshness. The following assignments identify primary implementation and targeted regression ownership.

| Invariant | Tasks | Planned primary tests / evidence |
|---|---|---|
| S01 Network | T00, T04, T18, T23, T32 | operations/network-guard; services/orchestration; devnet manifest |
| S02 Owner authority | T05, T07 | program/funding; program/lifecycle |
| S03 Immutable mandate | T02, T04, T09, T19 | spec/wire-vectors; program/atomic-batch; ui/approval |
| S04 Replay | T07, T09, T32 | program/lifecycle; program/atomic-batch; duplicate API attempts |
| S05 Expiry/cancellation | T07, T09, T32 | lifecycle boundary/races; refreshed funded-intent state |
| S06 Conservation/surplus | T08, T09, T16, T17 | assets-math; atomic-batch; routed-batch; independent properties |
| S07 Per-owner bounds | T09, T11, T16 | atomic-batch; planner/validation; routed-batch |
| S08 Arithmetic | T04, T08, T11 | amount-vectors; assets-math; differential vectors |
| S09 Dust | T08, T13, T17 | assets-math; cost-allocation; input permutation properties |
| S10 Account roles | T05, T09, T16, T17 | funding; atomic-batch; routed-batch; adversarial aliasing |
| S11 Atomic rollback | T06, T09, T16, T24 | thin-flow; atomic-batch; routed-batch; devnet negative transaction |
| S12 Independent recovery | T06, T07, T20, T26 | lifecycle; ui/recovery; blocked-asset and offline-service drills |
| S13 Authentic price | T09, T14, T15, T17 | actual settlement oracle composition; pyth-verification |
| S14 Price semantics | T09, T14, T15 | oracle/policy; stale underlying/equality boundaries inside settlement |
| S15 Route authority | T10, T16, T17, T25 | controlled-venue; routed-batch; optional dbc-devnet |
| S16 Asset changes | T05, T08, T17 | admission/extension/authority cases; stale semantics snapshot |
| S17 Secrets | T04, T15, T23, T32 | secret scan; built client inspection; API response/log tests |
| S18 Reconciled UI | T20, T24, T26, T32 | ui/recovery; e2e/devnet; faults; submission/status reconciliation |
| S19 Fair baselines | T01, T03, T12, T21 | reference arithmetic; engines; report validation |
| S20 Claim provenance | T13, T21, T29, T31 | cost-allocation; claims ledger; submission audit |
| S21 Individual outcomes | T03, T13, T19, T21 | unequal-benefit case; comparison UI; per-owner report |
| S22 Config/upgrade | T02, T07, T09, T22, T23 | actual config-change tests; outstanding-escrow deploy refusal |
| S23 Resource limits | T12, T17, T28, T32 | numerical timeout; max+1 batch; service resource-limits |
| S24 Artifact/capacity | T04, T06, T17, T23, T24, T28, T30 | early envelope probe; full size/compute; release/source/config manifest |
