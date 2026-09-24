# Final handoff

## Where the project actually is

The devnet-scope product is **substantially built but not complete**, and no submission has been
made. What exists is a working, evidence-backed core: funded intents with signed raw bounds, an
atomic three-owner batch that crosses orders internally, a composed residual leg against a pinned
synthetic venue, owner-controlled recovery, a fair three-engine economic comparison with a
held-out result, and an isolated public-devnet probe.

A bounded local service and a review → compare → approve → recover UI now exist and passed an
independent review, which found one high defect — recovery was unreachable when the service was
offline — and nine lower ones, all fixed.

What does not exist: any real venue, authenticated Pyth prices, a recorded demo, a devnet run of
the current build, and any hosting.

## The decision a human must take

The economic evidence does **not** support the original cooperative-superiority hypothesis beyond
a narrow band: the cooperative gain is positive in four of six held-out scenarios and only 36 of
72 sensitivity points keep it positive. The internal-crossing mechanism is sound; the premium on
top of plain netting is not demonstrated to be robust.

Three honest options:

1. **Submit what is real**, with the claim narrowed to what the evidence supports and the missing
   layers named as missing. This is what `docs/submission-draft.md` is written for.
2. **Record the demo and submit** — the product surface now exists, so the remaining gap is
   presentation (T30/T31) rather than build.
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
