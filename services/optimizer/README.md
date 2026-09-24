# CrossFlow execution engines (T12)

Three deterministic engines that turn one frozen scenario into three comparable proposals:

| Engine | Module | What it may do |
|---|---|---|
| A — independent | `independent.py` | Optimize and price each account alone under its own mandate |
| B — fixed netting | `fixed_netting.py` | Net A's independently chosen orders and route the residual. May not change an order |
| C — cooperative | `cooperative.py` | Choose all accounts jointly inside the same approved feasible region |

The numeric model is **not** reimplemented here. `shared.py` loads the frozen T03 reference at
`research/economics/reference.py` and reuses its `evaluate`, `apportion`, `venue_charge`,
`grid`, `ranking` and — critically — its `independent_check`. Every ledger an engine returns is
re-validated by that checker, and a ledger the checker rejects is never reported as executable
(`status = "ledger_mismatch"`).

## The engine boundary

`Proposal` is the only output shape. It carries:

- `method` — `A`, `B` or `C`;
- `status` — `ok`, `ok_bounded`, `rejected`, `infeasible`, `budget_exhausted`, `no_fixed_orders`,
  `no_baseline`, `baseline_modified` or `ledger_mismatch`;
- `feasible` and `ledger` — a plan is only executable when both are set;
- `reasons` — why nothing executable exists;
- `candidates_evaluated` and `budget_exhausted` — the search budget actually consumed;
- `scenario_sha256` — the exact input the proposal is bound to;
- `ledger_errors` — the independent checker's verdict.

`Budget` limits **evaluations, not wall-clock time**, so a replay on another machine consumes the
same budget and returns the same answer. There is no convergence threshold to tune and no
continuous relaxation to round: candidates come from the frozen integer grid, so a plan either
satisfies every mandate exactly or is not emitted.

## Fail-closed rules

- An inadmissible scenario (`rejected`), an inverted bound or a negative cost curve produces no
  ledger at all.
- B refuses to price anything except A's exact orders; if the stock outcomes differ it returns
  `baseline_modified` rather than a quietly different baseline.
- C is seeded with B's outcome, so it can never be worse than a feasible B, and it reports
  `ok_bounded` (not `ok`) whenever the joint space was not fully explored.
- C reports `budget_exhausted` with no ledger when nothing feasible was found inside the budget,
  instead of returning a partially searched answer as if it had converged.

## Comparison attribution

`cooperative.compare()` keeps the two effects apart: `netting_gain_micro_usd` is A minus B, and
`cooperative_gain_micro_usd` is B minus C **only** when both baselines execute nonzero trades.
When either is a no-op, the raw difference is still reported as
`cooperative_raw_difference_micro_usd` but the attributed gain is `0` and `attribution` says why.
A no-op baseline is never presented as a cooperative trading saving.

## Running the checks

```sh
python3 -m unittest discover -s services/optimizer -p 'test_engines.py'
```

The suite asserts that every frozen scenario reports its declared admission result, that all
three ledgers pass `independent_check` and expose non-negative residuals, that B never rewrites A,
that C is never worse than a feasible B, that a replay under the same budget is byte-identical,
and that budget exhaustion, inverted bounds and negative cost curves fail closed.

Scope: training fixtures only. Held-out evaluation is T21 and has not been run here.
