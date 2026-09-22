# CrossFlow project contract

Status: selected by the user on 22 September 2026; execution planning only. No application has been implemented or security validation completed.

## Product

CrossFlow helps one stock-portfolio operator rebalance several independently constrained strategy accounts together. It compares independent execution, ordinary fixed-order netting, and cooperative adjustment within the same approved target ranges. Compatible trades cross internally; remaining orders use a bounded execution adapter. Users see their own proposed outcome and approve a funded intent. A Solana program enforces that approval or reverts the whole bounded batch.

The initial demonstration is three strategy wallets, two explicitly labelled test stocks and test cash. These are devnet fixtures, not shares or issuer-backed assets. Matching orders alone is not the claimed innovation. The differentiator must be demonstrated incremental benefit from cooperative portfolio adjustment against a strong fixed-order-netting baseline, with identical constraints and disclosed costs.

## Decisions

- Devnet-only deployments and transactions; local validator for tests. Public read-only mainnet data is permitted. No mainnet signing, funding, deployment or swaps.
- Main competition first. Meaningful authenticated Pyth integration is conditional on free suitable equity access. Meteora DBC is optional and cuttable; no other sponsor scope is assumed.
- Zero new spending without the user's explicit approval. Paid data, RPC, hosting and signing services are not dependencies. No purchases or sponsor outreach is authorized by this planning task.
- User plus Codex, with independent AI workers available. Scope is bounded by reliable validation and deadline, not assumptions about team size.
- Official published deadline previously checked: 25 September 2026 16:00 ET, equivalent to 26 September 2026 01:30 IST. Recheck at execution start. Internal submission-ready target: 25 September 19:30 IST.
- All-or-nothing fills only. One active intent per strategy wallet in the demo. Fixed small asset allowlist. No leverage, lending, shorting, cross-chain bridge, private-order claim, tax optimization or unrestricted custody.
- Each intent fully funds its selected portfolio slice in per-intent program-controlled token vaults. Bounds apply to this selected slice, not other assets in the wallet. Settlement outputs go only to owner-controlled allowlisted recipient accounts. Atomic settle or owner recovery; no partial-fill state in version one. Cancellation changes authorization state independently of transfers; per-asset owner withdrawals preserve recovery of unblocked assets and retain any blocked claim.
- At signing, user approves exact raw-unit input funding and lower/upper final-output bounds for every selected mint, expiry, nonce, permitted route policy and reference-price policy. Target bands are converted into a concrete reviewed mandate; they do not authorize arbitrary solver transactions. Solver is untrusted.
- Protocol fees are zero for the demo; disclose network/rent costs separately. Funding/closing rent recovery is part of the implementation.
- Basic SPL token fixtures are the mandatory asset path. Token-2022 extensions are supported only after explicit capability tests; unsupported extensions fail closed. No silent claim of issuer compatibility.
- An honestly labelled controlled devnet residual venue is an acceptable core fallback. It is not a Jupiter, Meteora or issuer integration. No hosted Jupiter devnet capability is assumed.

## Planning method

Use the GSD research → executable task planning → independent plan checking method, adapted to a whole-project plan because this repository currently contains research only. Bootstrap project context instead of asking the user to repeat settled discovery questions. Do not auto-start implementation after planning.

## Success

A new viewer understands the problem and workflow, can inspect an actual devnet atomic settlement and rejected invalid settlement, sees reproducible fair economic comparisons including no-benefit cases, and can distinguish implemented features, optional integrations and future work. Winning is an objective, not a promised outcome.
