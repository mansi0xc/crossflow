# Release rehearsal (T30)

Candidate `9090fec` (tree `6968218`). Rehearsed on 25 September 2026 on an isolated local
validator plus the committed devnet identity.

## What was run

| Step | Outcome |
|---|---|
| Fresh workspace check | PASS — harness, tracked-secret scan, RPC destination guard, pinned versions, schema vectors |
| TypeScript suites | PASS — 117 tests across 16 files |
| Browser flow | PASS — 10 tests, including recovery with every service endpoint failing |
| Rust host tests | PASS — 30 tests across both programs |
| Held-out economics | PASS — the committed report reproduces byte-for-byte |
| Internal batch (T09) | PASS 7/7, 205,117 CU, 350 serialized bytes, 33 lookup entries |
| Controlled venue (T10) | PASS 7/7, measured output equal to the quoted output |
| Composed route (T16) | PASS 7/7, 340,091 CU, 451 bytes, 43 lookup entries, 128 bps realized deviation |
| Prepare / approval / recovery (T18–T20) | PASS 2/2, 3/3, 2/2 |
| Service (T32) | PASS 3/3 |
| Devnet identity | PASS — config `ENcnvW9b…Cs8D`, policy matches the manifest, zero outstanding claims |
| Devnet probe re-run on the current build | PASS — 161,316 CU, 33 lookup entries, seven rejections, cancel + per-asset withdraw + close returning exactly 5,000,000 |
| Release manifest | PASS — `verify:release` ties the commit, tree and artifact hashes together |

## What the rehearsal found and fixed

1. The devnet deployment identity did not follow the committed policy: a config account carries its
   policy for life, so changing the test mints while reusing the deployment id published against a
   stale on-chain policy. Identity is now derived from the policy, and replacement is refused while
   any claim intent is outstanding.
2. The devnet deploy step was being skipped when a program was already present. Because the program
   embeds its deployment manifest at compile time, that left the on-chain build behind the tested
   source — an S24 traceability gap.
3. Repeated probe cycles exhausted the asset fixture: immutable test mints cannot be topped up, so
   each run now creates a fresh set.

## Not rehearsed

The demo **video** has not been recorded, the browser flow has not been driven with the real Phantom
extension, and the composed route has never been deployed to devnet. A timed end-to-end demo run
remains the last rehearsal step.
