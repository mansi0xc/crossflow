# Independent routed-settlement review (T16)

**Verdict: PASS for the scoped route gate**, after the reviewer's three medium findings were fixed
and re-run. Reviewer: a separate agent with no prior context, given the specification, the code,
the off-chain models and the evidence, and told to report rather than edit. Review was **static**;
the reviewer did not run the validator or the suites.

## Confirmed sound

- **Authority separation.** CrossFlow's batch PDA is re-derived and is the only account granted
  signer privileges (via `invoke_signed`); the venue independently requires that signer and derives
  the caller's source and destination as that signer's own canonical ATAs, so venue output can only
  return to CrossFlow's own pool. The venue program, pool and per-mint vaults all come from the
  committed policy.
- **Conservation.** The pool reconciliation is stronger than the explicit debit/credit equality:
  intake moves exactly `ΣD` and the route consumes exactly `ΣR_D`, so the post-route input pool
  necessarily equals `ΣI_C`, and any over-draw or phantom credit breaks the equality. Start-empty,
  exact reconciliation and end-empty together make pool donations unspendable.
- **Bands and bounds on realized amounts.** The per-cross band, the per-owner external band, the
  aggregate external band and the whole-slice value-loss guard are all applied after the CPI, to
  measured values; the third pool must not move.
- **The internal-only path did not regress functionally** — and it now shares the same loader.

## Findings raised and resolved

| # | Severity | Finding | Resolution |
|---|---|---|---|
| M1 | Medium | The on-chain residual decoder read a fixed three weights regardless of `batch_count`, while the spec and the canonical encoder use `batch_count`. A two-owner routed body produced by the shipped client could not be decoded, and a hand-crafted one would pass a non-debited phantom weight into the allocation. | The decoder now reads exactly `batch_count` weights. Unit tests cover a two-owner residual and a truncated one. |
| M2 | Medium | `load_group` was **not** shared with `settle_batch` (which still held an inline copy), and the "shared" loader passed a substitute value where the mint mint-authority and freeze-authority checks belong — making the routed path validate mints *more weakly* than the internal path. | `settle_batch` now calls `load_group`; the loader reads the real `COption` tags at offsets 0..4 and 46..50 and fails closed on a short mint account. |
| M3 | Medium | The evidence checker "independently" compared two fields the generator wrote together, never asserted the payout array length, and read the committed policy from decoded JSON rather than the recorded bytes. | The checker now recomputes the venue quote from the recorded reserves and the committed fee, rebuilds the expected payout per owner from funding, the cross and the residual, re-hashes `policy_bytes_hex`, and rebuilds the canonical instruction body to reproduce the recorded hash. |
| L1 | Low | `RoutePolicy.pool_authority` was parsed but never used. | The admitted route vaults are now derived from `pool_authority`, so the field is load-bearing. |
| L2 | Low | The spec quoted compute numbers that the committed evidence did not contain. | The spec now quotes the measured values (205,117 CU internal, 330,095 CU composed). |
| L3 | Low | A client guard that could never fire. | Replaced with real alias assertions for the pools and venue vaults. |
| L4 | Low | An unguarded `data[44]` read in the shared loader. | Length-checked before indexing. |
| L5 | Low | The spec asked for venue vault delta reconciliation; the handler only re-read the output pool. | The handler now re-reads both pinned venue vaults and requires them to move by exactly the typed input and the measured output. |
| L6 | Low | Pool/vault aliasing was enforced off-chain only. | The handler now rejects any pool that collides with an intent vault, a recipient or a venue vault. |

## What this review does not establish

No devnet deployment of the routed path, no real venue (not Meteora, not Jupiter, not an AMM), no
Pyth, no UI or service analysis, no execution of the suites or the checker, no formal verification
and no third-party audit. A pass here is a scoped engineering review of the composed instruction.
