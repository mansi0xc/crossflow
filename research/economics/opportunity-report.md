# T03 — Training-only economic mechanism result

**Research G0 technical criterion: satisfied by the reference calculation, pending independent review. Winning economic case: unproven.** The smallest frozen example saves **$0.0162 (1.62 cents)** beyond fixed-order netting after the declared overhead. That is 72.15% of a very small $0.022453 modeled baseline cost, not a compelling commercial saving by itself. Price changes of ±50 bps erase that incremental advantage in the disclosed sensitivity test. No held-out performance was evaluated.

This report is a synthetic mathematical experiment. It does not establish live equity liquidity, Pyth integration, executable transactions, product demand, willingness to pay or hackathon competitiveness. All costs, prices and liquidity are invented assumptions from T01. No fixture was changed to obtain a positive result. The original suite was frozen in commit `9614341`; canonical suite SHA-256 is `f8ce9388d0280a9faa92327d9f341fc9f265f22cc271f25f4d106ae60d7b59e7`.

## Method and scope

The reference independently implements a discrete version of the idea motivated by the [cooperative transaction-cost paper](https://arxiv.org/html/2603.07881v1), with each owner's target preference penalty and hard constraints included. It copies no paper code and does not reproduce the paper's continuous optimization, ADMM method or empirical results.

Exact enumeration minimizes the frozen objective: recurring execution costs, successful/expected-failed network fees, waiting valuation, and a 5 bps penalty on dollar stock-target error. A independently optimizes each owner. B retains A's stock orders exactly and recomputes net execution, allocated costs and cash. C jointly optimizes the same feasible mandates. Tie-breaking is lower target error, lower turnover and then the frozen lexicographic output rule. Fractions retain exact rational micro-USD; stock and cash outputs are integers. Preference and waiting are not token debits; only actual modeled venue charges and external price differences alter cash.

Twelve frozen training cases were evaluated under both research constraints and the provisional T02 200 bps value-loss guard. The eight held-out cases were not optimized, scored or used for tuning. Three training cases were rejected before search; nine were admitted. The input loader filters by the training manifest before evaluation and validates the frozen hash. Reference feasibility witnesses are not used as baseline orders or charged as if their full debit reserves were actual venue costs.

The ledger checker is separate from the pricing/enumeration function and does not import T01's checker. It recomputes output constraints, cash and stock conservation, objective components, fees and network/waiting overhead from unchanged input. Hand-calculated monetary expectations and deliberate weakened-baseline/loosened-mandate/no-op attacks supplement those checks. This is independent arithmetic within one implementation task; external review is still required.

## Frozen training results

Amounts below are recurring modeled micro-USD converted to test dollars and rounded to six decimals. Positive A−C means batching costs less than independent execution. Positive B−C isolates the cooperative-adjustment benefit. A rejected case has no savings result.

| Training case | A independent | B fixed netting | C cooperative | B−C | A−C |
|---|---:|---:|---:|---:|---:|
| opposite-01 | $0.113818 | $0.022453 | $0.006253 | $0.016200 | $0.107565 |
| all-buy-01 | $0.113818 | $0.120194 | $0.120194 | $0 | **−$0.006376** |
| no-overlap-01 | $0.181018 | $0.183594 | $0.183594 | $0 | **−$0.002576** |
| asymmetric-01 | $0.653818 | $0.534010 | $0.484010 | $0.050000 | $0.169808 |
| tight-01 | $0.147018 | $0.020677 | $0.020677 | $0 | $0.126341 |
| infeasible-01 | Rejected: required trade with zero turnover | — | — | — | — |
| expensive-01 | $0.888818 | $0.080477 | $0.004477 | $0.076000 | $0.884341 |
| noise-01 | $0.073155 | −$0.054207 | −$0.054207 | $0 | $0.127362 |
| tiny-01 | $0.034218 | $0.002777 | $0.002777 | $0 | $0.031441 |
| zero-01 | $0 | $0 | $0 | $0 | $0 |
| stale-01 | Rejected: stale reference | — | — | — | — |
| single-01 | Rejected: insufficient batch participants | — | — | — | — |

Among nine admitted cases, incremental B−C recurring savings are positive in **3**, zero in **6**, and negative in **0**. Median incremental saving is **$0**, range **$0–$0.076**. Against A, C wins in six, loses in two, and ties in one. These are descriptive counts from hand-selected synthetic cases, not a success rate for a market population. Three rejected cases remain in the twelve-case report rather than disappearing from the denominator.

The three positive B−C cases are opposite-01 ($0.0162, 72.15% of B), asymmetric-01 ($0.05, 9.36%), and expensive-01 ($0.076, 94.44%). The high relative percentages have tiny denominators and must always be presented with absolute dollars. Cost ratios are not meaningful for zero or negative shortfall baselines; those cases receive no percentage.

`noise-01` has negative B/C execution shortfall because its deterministic execution price favors residual sellers relative to the fixed snapshot. That is **not negative network/venue fees, guaranteed profit or predictive trading alpha**. Every method sees the identical deterministic shock. Knowing that future execution price while optimizing is a scenario-analysis assumption that would not hold in live trading; robust uncertainty optimization is not implemented. Spread/impact/fees, signed price differences and overhead remain separately available in the raw report.

## Hand-checkable mechanism: opposite-01

At $10 per STOCK_A, owner a starts with 0 shares and targets 5 inside [4,6]; owner b starts with 10 and targets 6 inside [5,7]. Owner c holds two STOCK_B shares and no changing stock order. Each initially holds $1,000 cash. Required progress, exact stock/cash ranges, turnover and fee budgets are identical across methods.

Independent optimum A buys four shares for a and sells three for b. The venue charges are $0.0642 and $0.0478 respectively, derived from the exact frozen spread/venue/impact/fixed fee expression. Their target-error penalties add $0.005 each. B crosses three shares and routes the remaining one-share purchase, costing $0.0162. C buys four for a and sells four for b: the stock orders cross completely, while b moves closer to its target. This is changed trading within unchanged mandates, not a zero-trade trick.

Batch network fees are four transactions × $0.0009 = $0.0036; one bounded retry's expected fees add $0.000036. Thirty seconds of assumed waiting on $3,140 of initial marked assets adds $0.0026166667. Thus B recurring cost is exactly `67358/3` micro-USD, C is `18758/3`, and B−C is exactly **16,200 micro-USD**. B preference penalty is $0.01; C is $0.005. Total objective improvement B−C is **$0.0212**, separately from the **$0.0162** recurring-cost improvement.

| Owner | A final STOCK_A / CASH | B final STOCK_A / CASH | C final STOCK_A / CASH | A / B / C recurring cost | A / B / C target error |
|---|---|---|---|---|---|
| a | 4 / $959.935800 | 4 / $959.983800 | 4 / $960.000000 | $0.065109 / $0.018245 / $0.002045 | $10 / $10 / $10 |
| b | 7 / $1,029.952200 | 7 / $1,030.000000 | 6 / $1,040.000000 | $0.048709 / $0.002129 / $0.002129 | $10 / $10 / $0 |
| c | 0 / $1,000.000000 | 0 / $1,000.000000 | 0 / $1,000.000000 | $0 / $0.002079 / $0.002079 | $0 / $0 / $0 |

Owner c's unchanged two STOCK_B shares are present in all methods and omitted from the table for readability. C's stock turnover is $80 versus $70 for A/B; that extra permitted $10 trade improves b's target position and removes the external residual. It is disclosed, not counted as free equivalence. Owner c pays coordination overhead despite doing nothing and is worse off than under A. Aggregate savings are **not** a guarantee that every owner benefits. The scoped operator managing their own strategy accounts may accept that tradeoff; independent third-party participation would require a more careful incentive/allocation policy.

B/C also require an assumed **0.011 SOL recoverable upfront deposit** for this three-owner batch, shown separately from recurring cost. It is a synthetic rent placeholder, not an actual program account-rent measurement. The actual deployment's transactions, compute/priority fees, rent and any real oracle verification must replace these assumptions before claiming live savings.

## Guarded executable-policy subset

The provisional T02 predicate, still under review when this experiment was run, is evaluated per owner at the same current reference snapshot: `VO*10000 >= VF*(10000-200)`. Values use T02's whole-token price/decimal normalization; its common scale cancels exactly to the model's per-raw-unit micro-USD values. Venue execution price is **not** substituted for the authenticated reference snapshot. Every actual A/B/C solution in all nine admitted training cases passes this extra loss predicate; re-enumerating with the predicate enforced returns the same reported optima.

That is only **predicate compatibility**, not an on-chain execution proof. T02's account identities, amount caps, mint/adapter restrictions, reference movement/freshness/authentication, funding and runtime checks are separate implementation obligations. This report does not declare any scenario deployed or fully executable.

The hand feasibility witnesses for **both tiny-01 owners** debit their entire $2 reserve and violate the 200 bps value-loss guard (8% loss on a's $25, about 5.71% on b's $35). Those witnesses are **research-only, not executable-policy fixtures**. The optimized tiny-01 outputs charge their actual much smaller venue costs and pass the loss predicate. Do not send the conservative reference witnesses to settlement. Raw results include both classifications explicitly; neither the rejection nor the actual-output distinction is hidden.

## Fee, delay and disturbance sensitivity

The following thirteen perturbations of training `opposite-01` are declared scenario sensitivities, not replacements for frozen inputs or extra independent observations. All retain the same A/B/C mandates and provisional value-loss predicate. These tests change one parameter at a time, keeping the full result, including unfavorable outcomes.

| Parameter | Value | B−C recurring saving | A−C recurring saving |
|---|---:|---:|---:|
| Priority lamports per transaction | 0 | $0.016200 | $0.107868 |
| Priority lamports per transaction | 1,000 (base) | $0.016200 | $0.107565 |
| Priority lamports per transaction | 100,000 | $0.016200 | $0.077568 |
| Priority lamports per transaction | 1,000,000 | $0.016200 | **−$0.195132** |
| Batch wait seconds | 0 | $0.016200 | $0.110182 |
| Batch wait seconds | 30 (base) | $0.016200 | $0.107565 |
| Batch wait seconds | 300 | $0.016200 | $0.084015 |
| Batch wait seconds | 1,800 | $0.016200 | **−$0.046818** |
| STOCK_A execution shock | −100 bps | **$0** | $0.092722 |
| STOCK_A execution shock | −50 bps | **$0** | $0.093244 |
| STOCK_A execution shock | 0 bps | $0.016200 | $0.107565 |
| STOCK_A execution shock | +50 bps | **$0** | $0.125246 |
| STOCK_A execution shock | +100 bps | **$0** | $0.125926 |

B and C share the same batching overhead, so changing that overhead does not alter their difference in this example; it can still make both worse than A. Shock cases give A the same known price disturbance as C, allowing its independently optimal orders to change. When ordinary fixed-order netting already captures that adjustment, the incremental advantage vanishes. A product cannot reasonably promise a cooperative saving in every price state.

Pyth-specific access/verification costs and actual adapter compute are not calibrated here. Their eventual measured effect could consume or exceed a 1.62-cent gain. Current results must not be presented as a proof that any oracle or venue integration is economically worth its extra transactions/compute.

## Post-freeze exploratory scale check

At the coordinator's request after the first frozen result, an explicitly exploratory scale experiment multiplies holdings, cash, targets, bounds, turnover/error budgets, debit reserves **and synthetic venue depth** by the same factor. Stock prices stay fixed. The share-lot grid grows by that factor, preserving the normalized candidate set. This is exact optimization on that coarser declared grid, **not** on every integer share at the larger size. Fixed order fees, network fees and transaction counts stay fixed; waiting valuation scales with portfolio value.

| Scale | Initial marked batch value | Incremental B−C modeled saving |
|---:|---:|---:|
| 1× | $3,140 | $0.0162 |
| 10× | $31,400 | $0.1530 |
| 100× | $314,000 | $1.5210 |
| 1,000× | $3,140,000 | $15.2010 |

These are **post-freeze synthetic illustrations**, not added train cases, held-out results, market evidence or a forecast for a million-dollar account. Scaling liquidity alongside portfolio size is a strong assumption; a live venue need not supply it. The scale experiment does not remove shock fragility, establish transaction capacity, or justify a price customers would pay.

## Product interpretation and next gate

The first plausible operator is someone rebalancing multiple strategies on a schedule, with genuine opposing desired trades and flexibility inside existing mandates. That operator could value transparent execution, a reproducible comparison and enforceable recovery even when ordinary netting captures most of the savings. This is a hypothesis, not an interview result.

A cadence assumption must come from a user's actual strategy process: daily, weekly and event-driven adjustments have different overlap, waiting tolerance and dollar costs. Do not multiply a synthetic per-batch saving by an invented daily frequency to produce an annual customer benefit. We have not established whether such an operator uses tokenized equities on Solana, pays these venue costs, or would accept the coordination burden. No customers, payment intent or recommendation propensity have been validated.

The technical G0 result supports building the thin authorization/settlement/recovery slice and validating real integration costs. It does **not** yet support a broad superiority or commercial ROI pitch. Before G3, retain the strong A/B comparison, independently review this calculation, freeze the implementation, evaluate the untouched held-out set once, measure the actual devnet transaction envelope, and report negative cases. If meaningful absolute savings fail to survive measured overhead and uncertainty, narrow the narrative to controlled multi-strategy execution/netting rather than promising a revolutionary cost advantage. No optional feature should conceal that unresolved product question.

## Reproduction and evidence

From the integrated repository root:

```
python3 research/economics/reference.py
python3 -m unittest research/economics/test_reference.py
```

`reference-results.json` contains every training method's input hash, raw outputs, costs, preference, residual orders, owner allocations, constraint slacks, guard results and grid counts, plus all thirteen sensitivities and four labelled exploratory scales. Fractions are stored as exact numerator/denominator objects. Results are deterministic and contain no wall-clock timestamp. The generator never evaluates a held-out ID.

The test suite checks hand monetary calculations; genuine independent optima; A-order preservation in B; no-op progress rejection; separate valid zero portfolios; cash/stock conservation; exact rounding; post-fee cash infeasibility; deliberately weakened A, loosened mandates and altered B; stale/insufficient/infeasible cases; fee/deviation budget; per-owner 200 bps boundary; uniform shocks; expensive network/wait losses; and original input immutability. Passing these tests is not a security audit or a deployed-money-path test.
