# Independent T02 re-review — PASS for normative specification acceptance

Reviewed 23 September 2026 by `t01_scenarios`, who authored the economic fixtures/reference but did not author T02. This review covers the five frozen `docs/spec` files exactly matching commit `191f090`, the current authoritative task graph and master execution contract, and the previous independent findings F1–F4. No source files were changed; no held-out performance, network activity, signing, or transactions occurred.

**Disposition: PASS for T02 specification acceptance.** F1–F4 are resolved. No unresolved blocking issue was found in the revised money semantics. This is not a runtime, deployment, security-audit, cross-language or capacity pass.

## Prior findings and resolution

**F1 — resolved.** `settlement-accounting.md` sections 1–5 require explicit paired stock/cash cross records and derive all I_D/I_C/R_D/R_C/D/C/O. There are no free debit/credit/beneficiary weights. Each cross enforces the committed integer reference band; aggregate whole-slice loss cannot replace it. External records fix each owner's actual input, consume exact measured X and allocate measured Y proportionally with deterministic residue. Each participant and the aggregate leg pass their external price bands. Recorded internal entries cancel per mint, external delta E accounts for the remainder, and recipient deltas equal O. The atomic algorithm requires batch balance Q=sum C and zero final batch residue, so unpaired cash subsidies cannot be legalized by an aggregate conservation claim.

Independently reproduced the $10 share/$11 cash counterexample: the buyer's $999 final reference value from $1,000 initially passes 200 bps total-slice protection, but the 100 bps cross band rejects the price. Reproduced both internal and external lower/upper equality, one cash raw unit outside, one stock raw unit outside, zero-deviation exactness and mixed-decimal vectors. Independently checked a dust example where aggregate external price is exact but a participant's rounded allocation violates its own band: per-owner validation correctly remains necessary.

**F2 — resolved.** Revised intent/accounting/threat documents consistently place the controlled venue ABI, fee/reserve model and policy binding in T10, real residual CPI integration in T16, the required fixture interface/guards in T14, and optional authenticated Pyth in T15. Mode 1 remains rejected until its admission gate. A Pyth exclusion does not waive route validation. Security-relevant route parameters missing from the existing policy require a versioned amendment before enabling routes.

**F3 — resolved.** T05 now depends on T04 and T14; T14 depends on T00/T02/T04 and T15 remains conditional after T14. Independent parsing of all 33 authoritative task cards found an acyclic graph, and every displayed dependency-wave row matches its computed level. Funding cannot bypass the fixture snapshot guard to run in an earlier wave.

**F4 — resolved.** `intent-contract.md`'s initialization paragraph pins expected initializer, initial admin, deployment identities and initial policy hash into the reviewed artifact/manifest. The expected initializer must sign; the initial admin and identities must match; initialization is one-time. A public deployment ID is explicitly not a capability. Alternate seeds cannot create caller-selected configs under the same artifact. Prefunded empty PDA handling must not relax these checks. Runtime attacker-first-initialization tests remain required.

## Reproduced checks

1. Ran `python3 docs/spec/check-wire-vectors.py`: PASS; 2 positive encodings, 35 byte mutations, 15 structured invalid inputs, 4 malformed byte encodings, 2 allocation vectors, 16 price-band vectors, 4 flow vectors and subsidy rejection.
2. Independently reconstructed the new **652-byte** policy preimage, including both newly committed u16 price caps, and matched the stored bytes and SHA-256. The provided checker also reproduced 605-byte canonical mandates and 177-byte funding bodies. These lengths are not full transaction sizes.
3. Independently evaluated all 16 price vectors using exact rational execution prices, without importing the author checker.
4. Independently reconstructed all four flow vectors: debits, credits, outputs, actual external net flows, proportional residual allocations and each owner's premium/shortfall identity matched. For every mint, sum(O−F)=E; each D was funded from F. The two-leg expected outputs matched the stored explicit hand result.
5. Independently checked the largest aggregate valuation-band bound remains below 2^128; runtime must still use checked arithmetic.
6. Confirmed all five source files are byte-identical to commit `191f090`; recorded their hashes.

Evidence:

- `/private/tmp/crossflow-t02-rereview-wire.log`
- `/private/tmp/crossflow-t02-rereview-probes.py`
- `/private/tmp/crossflow-t02-rereview-probes.log`

## Nonblocking documentation cleanup

- `.planning/TASKS.md` T32's prose execution note still says wave 8, while the updated wave table and actual dependency graph correctly put it in **wave 9**. Correct the note to avoid a stale handoff instruction; T19/T22 correctly remain downstream in wave 10.
- T09's action still calls the final-value guard “optional signed.” The accepted T02 v1 policy commits and requires the per-owner value-loss guard. Align the card wording with the mandatory T02 guard; no implementation may interpret that old adjective as permission to omit it.

These are localized task-card wording issues, not unresolved ambiguity in the revised normative contract or dependency graph. No weakening of acceptance is recommended.

## Remaining integration boundaries

T04 must implement the canonical bytes and strict request parsing independently in other languages, derive real addresses, measure complete transaction envelopes and preserve all specified authority checks. T05 onward must implement and adversarially test actual token transfers, rollback, cancellation/recovery, initializer binding and the per-record price constraints. T10/T16 must bind actual venue semantics and measured proceeds; future Pyth still requires real authenticity and capacity evidence.

The economics reference and executable flow allocation are different layers. Research's value-guard predicate check alone does not establish T02's new per-cross/external price bands, original-funding-only debits, contributor-based proceeds or full program admission. Any executable demonstration must convert and validate the **same** flow restrictions for A/B/C; unsuitable research cases must be labelled or rejected, not silently subsidized or granted weaker cooperative constraints.
