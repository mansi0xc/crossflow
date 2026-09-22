# Independent T01 / T02 foundation review

Reviewer: independent foundation_review agent. Reviewed 23 September 2026 against the repository AGENTS.md, master execution plan and T01/T02/T05/T14 task contracts. Source files were frozen staged copies, not in-progress worker output. No source edits, package installs, optimization, network access, signatures or transactions were performed.

## Disposition

- **T01 PASS for input/scenario freeze.** T03 may begin on training inputs after commit freeze. This is not an economic opportunity pass, optimizer validation, or executable proposal certification. Held-out performance remains unobserved.
- **T02 REWORK / BLOCKED for normative specification acceptance.** Resolve F1 and reconcile F2–F4 before implementation depends on these semantics. Encoding checks passing do not settle the missing money semantics.

## Checks and evidence

T01 standalone checker passed: 20 scenarios, 12 train, 8 held-out, 41 supplied reference portfolios, five expected admission rejections; suite hash `f8ce9388d0280a9faa92327d9f341fc9f265f22cc271f25f4d106ae60d7b59e7`. All 20 supplied adversarial tests passed. Independently recomputed suite/scenario hashes, complete disjoint split, and all 41 reference value/cash conservation equations. The independent checks examine supplied witnesses only and do not enumerate any scenario's candidate portfolios.

T02 supplied checker passed: two encoding positives, 35 byte-mutation hashes, 15 structured invalid inputs, four malformed byte inputs, two allocation vectors. Independently reconstructed 648-byte policy, 605-byte mandate, and 177-byte compact funding-body preimages from the normative field tables, matching bytes and hashes without importing the generator. Independently reproduced all 35 mutation hashes. Eight additional malformed numeric representations were rejected. 2,480 small allocation cases passed conservation, nonnegativity, zero-weight exclusion, and permutation invariance. These are encoding/reference arithmetic checks; runtime ownership, real PDA/ATA derivation, transactions and cross-language implementations remain untested.

Evidence paths:

- `/private/tmp/crossflow-foundation-source-hashes.json`: exact SHA-256 of all ten reviewed source files.
- `/private/tmp/crossflow-review-probes.py`: independent reproduction script.
- `/private/tmp/crossflow-foundation-independent-probes.log`
- `/private/tmp/crossflow-foundation-t01-check.log`
- `/private/tmp/crossflow-foundation-t01-tests.log`
- `/private/tmp/crossflow-foundation-t02-check.log`

## Findings

### F1 — HIGH — Internal stock/cash cross-price constraint is absent

Locations: `docs/spec/settlement-accounting.md:17` (generic pool intake/route/distribution), `:55` (snapshot movement), `:61` (whole-portfolio loss); `docs/spec/intent-contract.md:91` (D/W settlement boundary). The master settlement contract and task T14 explicitly require an exact integer inequality for each internal stock/cash cross. The proposed algorithm accepts any D/weights distribution satisfying output bounds and a 200bps total portfolio value-loss guard. Snapshot movement only constrains p versus deposit p0; neither condition binds the price of a particular internal exchange.

Reproduction without a runtime program: buyer funds $1,000 cash; seller funds $1,000 cash plus one $10-reference share. Choose broad output bounds. Buyer ends with $989 and one share; seller ends with $1,011. Conservation holds, buyer loss is only 10bps of its slice and seller gains; both pass 200bps value protection and unchanged snapshots. Yet that internal share exchanged at $11, 10% above reference. Broad raw bounds and value guards therefore cannot establish the promised per-cross protection.

Required fix: specify enforceable internal cross records/quantities and exact checked integer stock-versus-cash inequalities, bind those records to D/C and measured transfer conservation, and add equality/one-unit failure vectors. If intentionally replacing per-cross protection with only whole-slice protection, first make an explicit reviewed master/task/R05 scope amendment and remove all per-cross claims. Do not silently treat the value guard as equivalent.

### F2 — MEDIUM — Venue and Pyth gates point to the wrong tasks

Locations: `docs/spec/intent-contract.md:40`, `:99`, `:103`; `docs/spec/settlement-accounting.md:17`, `:19`, `:63`; `docs/spec/threat-model.md:10`, final gate paragraph. T15 is conditional Pyth access/integration in the authoritative ledger, not the controlled venue. T10 builds the controlled venue and T16 integrates residual execution. The specification repeatedly assigns ABI/fee admission to T15, while future Pyth is described as T14-only. A permissible Pyth exclusion must not accidentally exclude mandatory route review.

Required fix: use T10 for concrete controlled venue ABI/fee/reserve definition, T16 for integrated routing, and distinguish T14 oracle interface from T15 conditional authenticated Pyth integration. Preserve versioned policy amendment if route identity fields cannot bind security-relevant venue parameters.

### F3 — MEDIUM — Funding oracle requirement changes the dependency graph

Location: `docs/spec/intent-contract.md:69` requires funding to authenticate a fresh snapshot with the settlement oracle guard. Authoritative T05 currently depends only on T04, while T14 (oracle interface) runs in the same wave and depends on T02/T04. Implementing T05 as planned would fund before its required guard exists.

Required fix: add T14 to T05 dependencies and update waves/schedule, or explicitly sequence a separately reviewed minimal fixture guard before T05. Do not implement funding by bypassing the new normative requirement. This is a graph reconciliation, not grounds to delay optional Pyth access.

### F4 — MEDIUM — Config initialization authority is not frozen in the new contract

Location: `docs/spec/intent-contract.md:15`. Admin policy mutation is carefully constrained, but the paragraph does not say who can create the first config or appoint its admin. T05 explicitly requires the expected initializer embedded in the reviewed deployment artifact, preventing a first-caller takeover. The new random deployment_id must not be mistaken for a secret authorization token.

Required fix: state the exact initializer signer source/binding, one-time initialization, expected initial deployment/config identities, and attacker-first-initialization rejection; preserve the master/T05 obligation. This can be documentation-only now, with runtime tests later.

## Integration conditions and nonblocking observations

1. **Research feasibility is not protocol feasibility.** T01 `scenario-spec.md:17` explicitly converts one model share to 1,000,000 raw units of a later six-decimal stock mint, while cash remains six decimals. This is a sound explicit unit boundary, pending T04 conversion vectors. The all-zero case is a no-op and must never be funded, consistent with T02 rejecting a zero funded slice.
2. **Value guard is stricter than some supplied reference witnesses.** T01 tiny-01/a reference starts at 25,000,000 micro-USD and ends at 23,000,000 (full conservative cost reserve): 800bps loss. It passes T01's stated research constraints but fails T02's 200bps guard. This is not measured execution cost or a held-out finding. Preserve the case; explicitly label research-only witnesses and apply final protocol guards identically to A/B/C before claiming deployable economics. Never weaken the guard only for C or assume a witness is an executable plan.
3. **Separate distinct price rules.** T01's 100bps execution-price disturbance admission is a research cost assumption. T02's 500bps funding-to-current-reference movement guard concerns a different quantity. They cannot substitute for each other. T01 stock progress, turnover, cash debit reserve and tracking error are independent planner checks, while opaque optimization hashes do not enforce them on-chain. UI must clearly separate these from the raw-output and protocol price/value guarantees.
4. **Costs and settlement accounting are intentionally different layers.** Research allocates integer share residuals and micro-USD venue cost by largest remainder; T02 allocates actual raw pool proceeds by submitted weights. An executable adapter must reconcile its actual output allocation with the research proposal and all owner bounds; cannot call these identical algorithms. The documents already warn about this boundary.
5. Ordinary JSON loaders do not detect duplicate textual object keys before parsing; the T02 semantic checker rejects unknown fields and malformed values but is not a hardened application request parser. T04 strict request parsing should reject duplicate keys or accept only typed constructed objects; do not broaden the current encoding-checker claim.
6. Fixtures, synthetic public keys, pending Pyth, runtime tests and transaction capacity are honestly labelled. Do not call 605/177-byte preimage sizes full Solana transaction sizes. No issue found with the explicit u128 maximum proof or checked-amount cap in this limited review.

## Re-review gate

Review revised F1 money semantics against the master contract and reproduce new independent boundary/counterexample checks. Confirm F2/F3/F4 reconciliation in authoritative docs/task graph. Re-run changed vectors/tests and hash revised sources. T01 stays frozen unless a separately recorded pre-performance amendment changes its research contract; later executable-proposal restrictions must be disclosed, not silently retrofitted into a winning result.
