# Gate status

Updated 24 September 2026. PASS applies only to the stated gate acceptance, not overall product readiness.

| Gate | Status | Evidence and limit |
|---|---|---|
| G0 feasibility | PASS, late | T00 preflight compatibility and funded devnet wallet; T01 frozen scenarios; T03 independently reviewed strict C-versus-B saving in one synthetic training case with a no-benefit control. Pyth access deferred by user and fixture prices labelled. Absolute saving is $0.0162, median training improvement $0 and sensitivity is adverse; commercial significance unproven. |
| G1 local walking slice | PASS (local scope) | T05 funding, T06 thin settle/reject/recover and T07 lifecycle/config all passed source-bound checks and independent review; G1 was closed at `ad6413e`. Local validator transcript only. |
| G2 settlement safety | PARTIAL, OPEN | T08 asset admission, exact raw amounts, deterministic dust and old-vault recovery passed review. T09 internal three-owner atomic batch passed fourteen negative cases and an independent review, with both medium findings fixed. Still open: T10/T16 composed residual route, T17 adversarial and capacity measurement for the full oracle-plus-route transaction, T22 independent money-path review of the integrated commit. No devnet or external-route evidence exists. |
| G3 economics and integration truth | NOT STARTED | Held-out set untouched; T12/T13 engines and comparison absent; real route/oracle integration absent. |
| G4 devnet workflow | NOT STARTED | No product deployment. |
| G5 submission readiness | NOT STARTED | No release package. |
