# CrossFlow requirements

All statuses below are PLANNED. Passing a plan review does not satisfy implementation requirements.

| ID | Requirement / acceptance boundary |
|---|---|
| R01 | Local development and devnet execution only; reject wrong genesis, program/config identity, wallet network and transaction destinations before signing and deployment. |
| R02 | Reproducible pinned toolchain and dependencies; fresh-checkout install/build/test; secret hygiene and licenses recorded. |
| R03 | Typed, versioned intent/plan/receipt schema with raw integer amounts, mint/program/decimals identities, canonical hashing, domain separation, expiry and replay protection. |
| R04 | Per-owner per-intent funded vaults, exact funding, cancellation/expiry recovery and rent recovery; recipient ownership verified. |
| R05 | Atomic bounded batch settlement enforcing every signed output bound, authenticated reference guard and approved route policy; solver/admin cannot steal or relax mandates. |
| R06 | Per-mint conservation, deterministic rounding/dust accounting, checked arithmetic, zero unauthorized residual balances and no cross-owner subsidies hidden in settlement. |
| R07 | Pyth authenticated selected-equity prices on devnet, entitlement/freshness/feed identity/session behavior verified, only if free access passes; otherwise explicitly test-oracle mode and no sponsor integration claim. |
| R08 | Fair independent, fixed-order-netting and cooperative-adjustment baselines with identical initial portfolios, target/risk constraints and cost conventions. |
| R09 | Independent economic evaluation on committed train/held-out scenarios, cost sensitivity, per-user outcomes and no-match/adverse cases; no cherry-picked guaranteed savings. |
| R10 | Safe residual adapter with allowlisted programs/accounts, exact net deltas, minimum output, bounded slippage/price impact and full revert on route failure. Core can use labelled controlled venue. |
| R11 | Target: three-wallet/two-stock/test-cash workflow with clear plan comparison, wallet approval, finality/retry states, explorer proof and recovery screens. A capacity fallback requires a documented amendment and rerun of economic/demo gates; minimum two independently constrained portfolios and one stock plus cash. Never mark the original capacity passed based on a smaller demo. |
| R12 | Asset registry fails closed for mint/decimal/program/authority/extension changes. Advanced Token-2022 features are gated independently and excluded unless tested. |
| R13 | Threat-driven unit/integration/property/adversarial tests; independent money-path review; no unresolved critical/high issue at integration/release gates. |
| R14 | CI plus task, merge, schema-change, deployment, soak and release gates; artifacts identify commit, cluster, config, seed, inputs and expected/actual results. |
| R15 | Deploy/redeploy/recovery procedure, key segregation, simulation, compute/size limits, initialization guards and reproducible release manifest. |
| R16 | Evidence-backed demo and submission kit: working link or local runbook, video, source/license record, architecture, novelty, economics, limitations and verified requirement checklist. |
| R17 | Cost ledger defaults to zero monetary spend; no paid-service fallback without separate explicit user authorization. |
| R18 | Optional genuine Meteora DBC devnet residual route only after core/security gates; measured incremental value, exact program/pool/config proof and separate qualification caveat. |
| R19 | Human-readable execution state and agent handoff records, bounded independent work ownership, dependency graph and change/review process. |
| R20 | Truthful privacy/custody/production-readiness claims; no private-order, production liquidity, issuer ownership or universal savings claim unsupported by evidence. |

Mandatory: R01–R06, R08–R17, R19–R20. R07 is a conditional integration; core fail-closed oracle behavior remains mandatory with a labelled fixture. R18 is optional. A conditional requirement may be explicitly excluded at its access/cut gate; it must never be recorded as passed without evidence.
