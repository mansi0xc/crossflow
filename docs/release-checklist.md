# Release checklist

Candidate: `9090fec` (tree `6968218`). Run `corepack pnpm@10.17.1 verify:release` to re-check the
manifest against this tree; it fails on a changed artifact or a stale commit rather than warning.

## Gate results

| Check | Command | Result |
|---|---|---|
| Workspace, secrets, schema vectors | `check:workspace` | PASS |
| TypeScript suites | `exec vitest run` | PASS — 117 tests, 16 files |
| Browser flow | `test:ui` | PASS — 10 tests |
| Rust host tests | `cargo test -p crossflow -p test-venue --lib` | PASS — 30 tests |
| Economics | `scripts/evaluate-economics.py --split holdout` | PASS, report reproduces |
| Internal batch | `verify:task -- T09` | PASS 7/7 |
| Controlled venue | `verify:task -- T10` | PASS 7/7 |
| Composed route | `verify:task -- T16` | PASS 7/7 |
| Prepare screen | `verify:task -- T18` | PASS 2/2 |
| Approval | `verify:task -- T19` | PASS 3/3 |
| Recovery | `verify:task -- T20` | PASS 2/2 |
| Service | `verify:task -- T32` | PASS 4/4, including the live end-to-end run |
| Devnet identity | `exec tsx scripts/check-deployment.ts` | PASS, policy matches, zero claims |
| Release manifest | `verify:release` | PASS |

## Review status

| Surface | Review | Outcome |
|---|---|---|
| Internal batch settlement | `.planning/T09-INDEPENDENT-REVIEW.md` | PASS after fixes (2 medium, 5 low) |
| Composed residual route | `.planning/T16-INDEPENDENT-REVIEW.md` | PASS after fixes (3 medium, 6 low) |
| Service and UI | `.planning/T32-INDEPENDENT-REVIEW.md` | REWORK → all fixed (1 high, 2 medium, 7 low) |
| Consolidated money path | `docs/reviews/money-path-review.md` | findings and regressions tracked |

No critical or high finding is open. Every fixed finding has a regression test.

## Blocking items for submission

- [ ] A recorded demo video (script: `docs/demo-script.md`).
- [ ] A decision on the narrowed economic claim — see `docs/final-handoff.md`.
- [ ] The portal's requirements and deadline re-read on the day.
- [ ] No public artefact has been published, and nothing has been submitted.

## Not claimed

Winning, production readiness, security certification, issuer-backed assets, universal savings, or
exact reproduction on another machine's validator.
