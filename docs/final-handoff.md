# Final handoff

## Where the project actually is

The devnet-scope product is **built, verified and reviewed**, and no submission has been made. What
exists is a working core with evidence behind every claim: funded intents with signed raw-unit
bounds, an atomic three-owner batch that crosses orders internally, a composed residual leg against
a pinned synthetic venue, owner-controlled recovery that works with the service offline, a fair
three-engine economic comparison with a held-out result, a bounded local service an operator can
drive end to end over HTTP, a browser flow that is keyboard-operable and meets WCAG AA contrast,
exact per-owner cost attribution, and an isolated public-devnet probe whose on-chain policy matches
the committed manifest.

Three independent reviews are recorded — internal batch settlement, composed residual route, and the
service/UI surface — with every finding closed. The service/UI review returned **REWORK** and its
high finding was real: recovery was unreachable when the service was offline, which is precisely the
outage recovery exists for.

What does not exist: any real venue, authenticated Pyth prices, a recorded demo video, any hosting,
an adversarial runtime matrix against the deployed instruction in a single run, and an
unfamiliar-user review — which T27's own acceptance test requires and which only a human can do.

## The decision a human must take

The economic evidence does **not** support the original cooperative-superiority hypothesis beyond a
narrow band: the cooperative gain is positive in only four of six held-out scenarios and 36 of 72
sensitivity points. The internal-crossing mechanism is sound; the premium on top of plain netting is
not demonstrated to be robust.

Three honest options:

1. **Submit what is real**, with the claim narrowed to internal crossing and every absent layer
   named as absent. `docs/submission-draft.md` is written for this.
2. **Record the demo and submit.** The product surface exists; the remaining gap is presentation
   rather than build.
3. **Re-frame the value proposition** around internal crossing alone, which is the part that holds
   up, and treat the cooperative premium as future work.

## Before any submission

- Re-read the portal's requirements and the deadline on the day.
- Run `corepack pnpm@10.17.1 verify:release` on the exact commit. It fails on a changed artifact, a
  stale commit, a missing cited evidence file, or an unsupported check result.
- Run `corepack pnpm@10.17.1 verify:task -- <TASK>` for every task the submission cites. Each binds
  its sources, logs and artifact hashes, so a claim cannot outlive the code behind it.
- Run `corepack pnpm@10.17.1 verify:submission`, which follows every evidence pointer and refuses a
  claims ledger containing only flattering entries.
- Re-run `scripts/evaluate-economics.py --split holdout` and confirm the committed report is
  unchanged; if it changed, update every claim that quotes it.
- Record the demo from a clean checkout, and confirm no secret appears in any artefact.

## Known gaps, stated plainly

| Gap | Consequence |
|---|---|
| No audit and no formal verification | Every review here is a scoped engineering review, not a certificate |
| No real venue and no Pyth | The residual leg and the prices are synthetic, and labelled as such |
| Nothing published and no video | The submission does not exist yet |
| No unfamiliar-user or screen-reader review | T27's acceptance test is not satisfied |
| No single-run adversarial matrix against the deployed program | Coverage is spread across named rejections plus the property and soak suites |
| Retained devnet upgrade authority | A real trust assumption, disclosed in `docs/operations/deployment.md` |

## State of the work

- `.planning/TASKS.md` — task-by-task state; `.planning/GATES.md` — gate status.
- `artifacts/tasks/<TASK>/<tree>/` — the per-task check evidence; `verification/tasks/<TASK>.json`
  — the commands each check runs.
- Independent reviews: `.planning/T09-INDEPENDENT-REVIEW.md`, `T16-INDEPENDENT-REVIEW.md`,
  `T32-INDEPENDENT-REVIEW.md`, consolidated in `docs/reviews/money-path-review.md`.
- Reproduce any local runtime run from a checkout with `scripts/local-runs/` and `CROSSFLOW_RUN_DIR`.
- Measured capacity and its sources: `docs/evidence/capacity-report.md`.
