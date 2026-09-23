# T11 independent protocol review

Reviewed 23 September 2026 against the T11 card, T02 intent and settlement specifications, `packages/planner/src/mandate.ts`, `packages/planner/src/validate.ts`, `tests/planner/validation.test.ts` and the candidate differential vectors. No project files were changed. `corepack pnpm@10.17.1 exec vitest run tests/planner/validation.test.ts` passed 15/15 tests.

## Disposition

**PASS for a pure, solver-independent proposal validator; conditional for integration.** I found no high-risk arithmetic, conservation, owner-index, recipient, domain, price-band or forged-total bypass in the reviewed function. This is not an on-chain security pass: an authenticated chain/oracle context loader and Rust acceptance/rejection differential have not yet been supplied.

The $10 stock / $11 internal-cash counterexample is rejected at the individual cross by `priceBand` (validate.ts:42-47, 207-229), independently of the whole-portfolio 200 bps loss rule. Exact 0.99× and 1.01× boundaries pass, and a one-cash-raw-unit violation fails in tests. No solver-supplied D/C/O or recipient field is accepted: all debits/credits derive from typed crosses and residual inputs, then `D<=F`, signed final bounds, per-owner value guard, and per-mint conservation are checked (validate.ts:195-306). Residual allocations use exact bigint largest remainder, exclude zero-input owners, reject positive input with zero output, and check each participant's actual-price estimate against the band (validate.ts:119-129, 235-265). A route quote is explicitly labelled `quote_dependent` and `requires_onchain_acceptance`; it is not a guarantee of measured CPI proceeds.

Owner order is enforced on canonical lower-case 32-byte hex keys; owner wallet curve, canonical ATA, exact mandate/policy hashes, genesis, nonce/status agreement, expiry, fixture feed/timestamp/confidence and funded-vault lower bounds are checked (mandate.ts:84-103; validate.ts:138-190). Unknown fields and JSON numbers are rejected. The fixed settlement body encodes bounded u64 values and bounded record counts; it is not claimed as a whole Solana transaction.

The `parsePolicy` helper shallow-copies the policy and retains its `route_vaults` array, but `validateCandidatePlan` synchronously `structuredClone`s both context and plan before its first `await` (validate.ts:132-144). The retained array belongs to this private clone, so later caller mutation of the original input cannot change this validator's policy. This safety property belongs to the wrapper; any future direct async use of `parsePolicy` must snapshot or freeze its caller-owned input separately.

## Follow-up hardening

- **P3 resolved after review:** `proRata` now compares canonical lowercase 32-byte owner hex keys with ordinal `<`/`>`, equivalent to raw byte order, and the frozen tie vector asserts the one-unit residual goes to the lower key. Focused tests remain 15/15 PASS and TypeScript typechecking PASS.

## Required integration gates

1. **Trusted context:** The function explicitly accepts a declarative `contextInput` and cannot authenticate actual RPC account ownership/PDA identities, signer authority, fixture-publisher signature, batch-pool zero state, venue executable/ATA roles, or measured CPI balances. T32's loader and the Rust program must supply and enforce these independently. Never assemble `contextInput` from client/solver fields. In particular, `stored_status`, `stored_mandate_hash`, `booked_funding`, `vault_balances`, snapshot publisher and `technical_probe` must reflect authenticated state and service policy, not request claims (validate.ts:132-186).
2. **Rust differential:** `tests/planner/differential-vectors.json` is explicitly TS-only expected data. The T11 card requires matching Rust acceptance/rejection after T09. This remains open and blocks claiming cross-language or on-chain equivalence. Include the $10/$11 case, per-owner residual rounding boundary, fee/price bands, sorted owners and body decoding.
3. **Route execution:** `estimated_outputs` is an untrusted quote excluded from the 194-byte instruction body. T16 must recompute pro-rata allocations and all owner bounds/bands against measured actual Y after CPI, with atomic rollback; T11's returned `outputs` are proposal estimates only (validate.ts:242-306).
4. **Parsing:** This object-level validator cannot detect duplicate textual JSON keys already collapsed by `JSON.parse`. The API boundary should reject duplicate keys or use a typed construction path before invoking T11.

These are explicit scope limits or minor hardening, not evidence that the current pure function accepts an invalid price or money flow. Do not present the 15 TypeScript tests as Rust differential, live oracle authentication, or a deployed settlement audit.


This review is provisional for the pure proposal component. T11 task completion remains open until a trusted chain-state loader, consumer integration and Rust differential are available.
