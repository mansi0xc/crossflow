# Independent T09 security review

**Verdict: PASS for the scoped T09 gate**, after the reviewer's two medium findings were fixed
and re-run. Reviewer: a separate agent with no prior context in this conversation, given the
contract, the specification, the code and the evidence, and told to report rather than edit.
Review was **static**: source, specification, evidence and Anchor 1.1.2 codegen. The reviewer did
not execute the validator. Self-review is not counted as independent.

## What the reviewer confirmed

- No account alias, duplicate, reorder or substitution bypass: every owner state, intent, vault
  and recipient is re-derived from the stored owner/nonce/config and cross-checked against the
  stored `intent.vaults`/`intent.recipients`, not merely labelled.
- Per-mint conservation and closed-loop reconciliation hold: `sum(I_D) == sum(I_C)` is checked,
  and the post-transfer reload requires each vault to end exactly at its owner-attributed
  starting surplus and each recipient to gain exactly `O`.
- Signed per-asset bounds and the whole-slice value-loss guard are enforced on the derived and
  then the realised outputs; a donation cannot change `O`, become solver revenue or expand
  spending authority because transfers are signed only by the derived intent PDA.
- No new privilege exists: the instruction declares no signer, no admin path and no
  solver-chosen recipient.
- State is written last, after all CPIs and reloads, so any failure rolls back; double settle
  rejects.
- No panic path or unchecked arithmetic was found; the cited evidence numbers, error codes and
  `Intent` offsets match the code.

## Findings raised and how they were resolved

| # | Severity | Finding | Resolution |
|---|---|---|---|
| M1 | Medium | The local `buy-and-sell-same-stock` case was rejected by the strict cross-order rule before reaching the no-round-trip guard, so that guard was labelled as tested while unexercised. | Replaced with ascending tuples `(1, seller, buyer)` then `(1, buyer, seller)` and widened the participants' cash bounds so the round-trip rule is the rule that fires. Renamed to `round-trip-buy-and-sell-same-stock`. |
| M2 | Medium | Rust accepted a one-owner batch that the off-chain validator and the specification reject, creating a permissionless no-op state transition on a single funded intent. | `settle_batch` now requires `batch_count >= 2`; single-owner settlement stays on the owner-signed `settle_thin` path. |
| L1 | Low | Bytes appended after the declared `Vec<u8>` body were ignored by Anchor's argument decode. | Added the same exact top-level instruction check `create_and_fund` uses: the instructions sysvar must show this exact CrossFlow instruction with data length `12 + body.len()`, and the stack height must be transaction level. |
| L2 | Low | Rust capped intermediate debits at `MAX_POOL_AMOUNT` while the TS model caps at `MAX_AMOUNT`. | Accepted as no acceptance difference (`debit <= funding <= MAX_AMOUNT` is enforced in both); recorded here rather than changed. |
| L3 | Low | The `BatchSettled` event emitted three rows regardless of `batch_count`. | Event matrices are now truncated to the participating rows. |
| L4 | Low | The evidence checker recomputed the binary hash but never compared it, and the legacy-size capacity claim was prose only. | The checker now fails unless the built `.so` and the committed manifest match the recorded hashes, and the demo measures and records `legacy_encoded_bytes`. |
| L5 | Low | Several spec-required negatives had no local transcript case. | Added `output-below-owner-minimum`, `debit-exceeds-original-funding`, `round-trip-buy-and-sell-same-stock`, `substituted-vault-and-recipient`, `wrong-mint-rejected` and `trailing-instruction-bytes-rejected`. The matrix is now fourteen named target-program rejections. |

## What this review does not establish

- No devnet or public deployment, and no external residual route: T10/T16 are unimplemented and
  unreviewed here. T09 is internal crossings only.
- No independent execution of the transcript, the vitest suite or the Rust test suite; the
  reviewer reproduced the body hash and binary hash from source and read the rest.
- No formal verification, no third-party audit and no cross-language differential runner. The
  Rust/TypeScript agreement is by inspection against the frozen vectors, not by executing both
  on the same inputs.
- No analysis of the oracle publisher, config admin, funding path or recovery lifecycle except
  where the batch depends on their invariants.
- A pass here is a scoped engineering review, not a security guarantee.
