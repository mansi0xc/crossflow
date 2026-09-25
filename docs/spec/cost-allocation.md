# Cost disclosure and allocation (T13)

The batch is only worth running if an owner can see what it cost that owner and confirm nothing was
concealed. This note defines the one cost model the project admits, the rule that splits cost
between owners, and the cases in which the system declines rather than rebalances.

## The cost model

`CostModel` in `packages/planner/src/costs.ts` is closed: a field the model does not name is
rejected as an **undisclosed** cost. Every field is a decimal string; there are no floats anywhere
in this path.

| Field | Meaning |
|---|---|
| `protocol_fee_bps` | Must be `0`. The specification fixes protocol fees at zero, so a non-zero value is a fee no settlement path could pay — a hidden cost — and it is refused rather than reported. |
| `venue_fee_bps` | Residual venue fee, applied to the external leg only. |
| `base_fee_micro_usd_per_transaction` / `priority_fee_micro_usd_per_transaction` | Network fees, priced per transaction. |
| `base_fee_lamports_per_transaction` | The same fee in lamports, kept separately so a lamport figure is never silently converted. |
| `recoverable_rent_lamports` | Rent returned when accounts close. **Reported, never charged as cost.** |
| `irrecoverable_rent_lamports` | Rent that is not returned. Charged. |
| `sol_price_micro_usd` | Conversion for the two lamport figures, stated because it is an assumption. |
| `basis` | `ESTIMATED` before execution, `REALIZED` when reconciled from chain. The two are never mixed in one report. |

## The allocation rule

1. **Venue cost** is split in proportion to each owner's *external input value*. An owner that
   contributed nothing to the external leg pays nothing for it.
2. **Network fees and rent** are split by transaction count, because that is what drives them.
3. **The remainder.** Integer division does not always divide. Any remainder is assigned by largest
   fractional share, ties broken by ascending owner bytes. It is never left unallocated and never
   quietly dropped.
4. **Reconciliation is an assertion, not a summary.** The per-owner allocations must sum to the
   disclosed totals exactly, in the same transaction that produces them. If they do not, the
   report is not produced at all.

Raw units remain the authority throughout: the raw external input and output are echoed untouched,
and micro-USD figures exist only for disclosure.

## Comparison and refusal

`compareApproaches` compares the three approaches under identical starting holdings, prices and
bounds, and attributes cost before comparing. It **declines** — returning a reason instead of a
recommendation — when:

- the selected approach is not executable (for example, no route inside the committed band);
- any owner's signed bound would be violated; or
- any owner would end up worse than its baseline.

The third case is the one that matters. An aggregate saving is never accepted as an excuse for a
harmed participant: the comparison reports the harmed owners by name, sets `pareto_over_baseline`
false, and returns a `declined_reason`.

## What this does not claim

Pareto improvement is reported only when it is demonstrated for the specific comparison, never as a
general property of the mechanism. No privacy or incentive-compatibility claim is made. The figures
are modelled micro-USD under one frozen cost convention — not realized fills, not a backtest, and
not a promise about any other machine, venue or market.
