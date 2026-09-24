# Final handoff

## Where the project actually is

The devnet-scope product is **substantially built but not complete**, and no submission has been
made. What exists is a working, evidence-backed core: funded intents with signed raw bounds, an
atomic three-owner batch that crosses orders internally, a composed residual leg against a pinned
synthetic venue, owner-controlled recovery, a fair three-engine economic comparison with a
held-out result, and an isolated public-devnet probe.

What does not exist: the service and UI layers, any real venue, authenticated Pyth prices, and the
release package with a recorded demo.

## The decision a human must take

The economic evidence does **not** support the original cooperative-superiority hypothesis beyond
a narrow band: the cooperative gain is positive in four of six held-out scenarios and only 36 of
72 sensitivity points keep it positive. The internal-crossing mechanism is sound; the premium on
top of plain netting is not demonstrated to be robust.

Three honest options:

1. **Submit what is real**, with the claim narrowed to what the evidence supports and the missing
   layers named as missing. This is what `docs/submission-draft.md` is written for.
2. **Build the service and UI first** (T18–T20/T32) and submit a demonstrable product with the same
   narrowed economic claim.
3. **Re-frame the value proposition** around internal crossing alone, which is the part that holds
   up, and treat the cooperative premium as future work.

## Before any submission

- Re-read the portal's requirements and the deadline on the day.
- Re-run `verify:task T09/T10/T16` on the exact commit being submitted.
- Re-run `scripts/evaluate-economics.py --split holdout` and confirm the committed report is
  unchanged; if it changed, update every claim that quotes it.
- Record the demo from a clean checkout.
- Confirm no secret is in any artefact.

## State of the work

`.planning/TASKS.md` carries the task-by-task state, `.planning/GATES.md` the gate status, and
`artifacts/tasks/` the per-task check evidence. `.planning/T09-INDEPENDENT-REVIEW.md` and
`.planning/T16-INDEPENDENT-REVIEW.md` record what independent reviewers found and what was fixed.
