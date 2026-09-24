# Independent service and UI review (T32/T18–T20)

**Verdict: REWORK**, then all findings fixed and re-run. Reviewer: a separate agent with no prior
context, given the code, the tests, the spec and the evidence, and told to report rather than edit.
Review was **static**; the reviewer did not execute the suites.

No critical finding and no funds-integrity bypass: the independent planner is genuinely on the
`/batches/prepare` path, the service never holds or accepts a signing key, it returns an unsigned
transaction built from the validated plan, no secret reaches a response, log or bundle, and success
is shown only after confirmation.

## Findings raised and resolved

| # | Severity | Finding | Resolution |
|---|---|---|---|
| H1 | High | **Recovery was unreachable when the service was offline.** The intent list came only from the service, `refreshIntents` cleared it on any error, and the recovery screen was disabled when the list was empty — so a user holding a funded intent could not cancel or withdraw in exactly the outage the design advertises as supported. | The browser now enumerates the owner's intents **directly from chain** through the shared decoder (`packages/client/src/intents.ts`); the recovery route is gated on having a wallet, not on discovery, and a failed refresh no longer erases what is on screen. A regression test fails every service endpoint and asserts recovery still works. |
| M1 | Medium | The service sorted intents by **base58** string while the planner and the program require **raw byte** order, so roughly one in six valid funding sets was rejected with a misleading "plan rejected". | Ordering moved to the shared decoder, which sorts by raw owner bytes. The base58 sort is gone. |
| M2 | Medium | A synchronous throw inside the approve screen's mandate effect blanked the entire UI, because there was no error boundary and the effect ran before its inputs were resolvable. | The effect now returns early until every field is resolved, builds inside a promise chain that catches, and the app has a top-level error boundary that states nothing was signed and that reloading is safe. |
| L1 | Low | The compare screen's formatter claimed exactness but divided in floating point, and could print a malformed fraction. | BigInt long division, with the trailing zeros stripped. |
| L2 | Low | The discriminator checker's regex skipped generic instructions, so the two settlement instructions were never checked for completeness. | The pattern now matches generic parameters; the check reports 13 of 13 program instructions. |
| L3 | Low | The concurrency cap applied only to POST, so a burst of chain-reading GETs could 503 legitimate work, and rate buckets were never evicted. | The cap applies to every request and stale buckets are pruned. |
| L4 | Low | The commitment effect had no `catch`, and the expiry was recomputed on every render, so the displayed and signed expiry could differ. | Both fixed; the expiry is computed once. |
| L5 | Low | A malformed base58 `operator` surfaced as a 500 rather than a 400. | Addresses are validated before use. |
| L6 | Low | `signAndSend` confirmed against a freshly fetched blockhash rather than the transaction's own. | It now confirms against the blockhash the transaction was built with. |
| L7 | Low | The security matrix still said the service and UI did not exist. | Rows S17 and S18 now cite what enforces them and which tests exercise them. |

## What this review does NOT establish

No real Phantom extension flow, no browser-specific polyfill behaviour beyond the injected stub, no
hosting, TLS, proxy or multi-tenancy posture (the service is a loopback, single-deployment,
unauthenticated local tool by design), nothing about the on-chain money path beyond the layouts the
new surface decodes, no audit and no formal verification. The reviewer did not run any suite; the
fixes were re-verified separately.
