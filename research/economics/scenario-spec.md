# T01 — Frozen synthetic economic evaluation contract

Version 1, 22 September 2026. This is an input freeze, not an economic success report. No optimizer was run to select these inputs. All prices, fees, liquidity, delays, SOL conversion and rent figures are invented test assumptions. They are neither live quotes nor estimates of stock-market execution quality. Test tokens do not represent issuer-backed shares.

## Purpose and provenance

Test whether cooperative adjustment can improve a multi-strategy operator's cost/preference objective beyond netting the independently optimal fixed stock orders, while every account keeps the same mandate. The mathematical inspiration is the [cooperative transaction-cost paper](https://arxiv.org/html/2603.07881v1). This original discrete test design does not reproduce its continuous formulation, ADMM implementation, empirical calibration or results. No author code was copied. Fixtures are original project-authored synthetic inputs offered under CC0-1.0; implementation licensing remains a repository decision.

The dataset contains 20 hand-constructed cases: 12 training/development and 8 held-out cases, with 41 account reference portfolios. Five cases deliberately fail batch admission. Case count is not statistical representativeness or evidence of adoption. Assignment is explicit and frozen before optimization. The integer seed `22092026` is reserved for deterministic later sensitivity sampling, not a claim that these hand-written scenarios are random samples.

`split-manifest.json` commits the suite and each scenario with SHA-256 of UTF-8 JSON, sorted object keys, compact separators, `ensure_ascii=false`, integers only, array order unchanged. A Git commit plus the task's source manifest must freeze this document, checker and inputs **before T03 tuning starts**. A checksum is an integrity aid, not a tamper-proof experiment registry.

Only training cases may guide solver development and the early G0 decision. Held-out input structure and feasibility witnesses are checked now, but no held-out solver performance is computed. T03's early mechanism spike uses training cases; the later G3 evaluation runs held-out performance once after the algorithm/objective and reporting format freeze. Any debugging-driven re-evaluation is disclosed. Do not remove losses, infeasible cases, or adverse cases from the published denominator.

## Units, bounds and grid

Each scenario has STOCK_A, STOCK_B and CASH. Stocks use zero decimal whole-share units; cash uses six decimals, so one raw cash unit equals one micro-USD in this model. Reference prices are positive integer micro-USD per raw stock unit. A later six-decimal stock test mint maps one model share to 1,000,000 on-chain raw units, with the corresponding raw bounds multiplied identically. That conversion must be explicitly tested; it does not create fractional-share candidates in this frozen experiment.

The only stock candidate outputs are integers inside each account's inclusive stock bounds. Every interval has at most three points here, and the complete joint grid has at most 729 combinations (three accounts × two stock coordinates). Cash is derived by conservation and costs, not independently optimized. Exact enumeration in Python's standard library is practical; no numerical package is necessary for the T03 reference. Rejected-admission cases are not searched for a winning result.

For account i and stock a, let h be initial shares, x be final shares, q=x−h, p be the frozen reference price, and t be the target. Define:

- Stock tracking error `E_i(x) = sum_a p_a * abs(x_ia - t_ia)` in micro-USD. This is an L1 preference proxy, **not** covariance-based portfolio risk or a calibrated financial risk model.
- Stock turnover `T_i(x) = sum_a p_a * abs(q_ia)`, one-way traded stock notional. Cash is not counted again as a second turnover leg.
- Required progress: `10000 * E_i(x) <= (10000 - min_error_reduction_bps_i) * E_i(h)`.
- Additional hard limits: `E_i(x) <= max_stock_error_micro_usd`, `T_i(x) <= max_turnover_micro_usd`, nonnegative holdings, every final stock/cash raw bound, and the venue/deviation debit budget described below.

These conditions are identical for A, B and C and use the **original** reference price, never a price recomputed to make a result look feasible. A zero initial error requires zero final error under the progress rule. Track output-bound slack, tracking change and turnover per account. The funded slice is the entire portfolio in this experiment; no assumptions about outside wallet holdings are allowed.

Target preference penalty is `5/10000 * E_i(x)` micro-USD, kept as an exact rational number. Objective comparisons and overhead calculations use `fractions.Fraction` or equivalent exact arithmetic; rounding for display happens last. Preference penalty is displayed separately from execution costs and is never described as a paid fee.

## Three methods and tie-breaking

**A — Independent:** for each account, enumerate all stock outputs satisfying that same account's constraints, compute its real independent route cost and overhead, and minimize recurring modeled economic cost plus target preference penalty. The reference witness is **not** the independent solution. A must genuinely minimize this objective, not use a convenient hand-selected order. A no-trade feasible account executes no transaction and pays no execution/network/waiting costs.

**B — Fixed-order netting:** retain every stock output/order chosen by A unchanged. Cross those orders and route aggregate residuals under the exact same venue curves as C. Recompute cash, fees and every feasibility condition; savings must never be assumed to leave cash valid. If B's post-cost cash/allocation violates an account's limits, report B infeasible and exclude that case from any claim of C beating a valid B. Do not silently repair B stock orders, omit its costs, or choose a weaker A.

**C — Cooperative:** enumerate the same joint stock-output grid and choose a feasible joint result minimizing summed recurring economic cost plus the same per-account preference penalty. Bounds, targets, progress, prices, fees and debit budgets are immutable. Funding/settlement overhead is identical for B and C. A larger deviation, turnover or particular owner's cost is visible even if aggregate objective improves. The model does not guarantee a Pareto improvement for every owner.

Tie-breaking for A and C: lower total stock tracking error, then lower stock turnover, then lexicographically lower stock output vector ordered by account ID and STOCK_A/STOCK_B. These are exact comparisons, without epsilon rounding. B has no second optimization. Report A−B crossing savings and B−C adjustment savings separately, with preference/objective changes alongside costs. G0 needs a strict **total recurring cost** improvement against a valid B after overhead, not merely lower preference penalty or a reported objective advantage.

A batch containing no stock trades and no required unmet progress is a no-op: skip funding/settlement and return zero execution/overhead cost. Do not count avoiding an unnecessary transaction as cooperative trading savings. If any stock order exists, B/C count all included participating accounts' funding costs, including an unchanged account in the declared batch. The no-op account cannot be silently removed from only one method.

## External curves, reference matching and allocation

For a nonzero external stock order with absolute notional V in micro-USD at its execution price, charge:

`venue_cost(V) = ceil(V*(half_spread_bps+venue_fee_bps)/10000 + V^2*impact_bps_at_depth/(10000*depth_micro_usd) + fixed_order_fee_micro_usd)`.

Zero orders cost zero. `depth_micro_usd` must be positive. The quadratic term means impact at notional=depth equals the declared impact bps; this is a synthetic convex curve, not an AMM implementation or stock exchange quote. A pays the same curve separately on each account/stock external order. B/C pay once per stock on the net residual; unmatched total volume is not incorrectly charged as residual volume. Internal crossing uses the frozen reference price and zero internal/protocol fee.

For each stock, compute signed net residual Q=sum_i q_i. If Q=0, no external shares or venue charge exist. Otherwise allocate abs(Q) integer external share lots among accounts trading in Q's direction, proportionally to abs(q_i), using largest remainder: floor each ideal allocation, award remaining units in descending fractional-remainder order, with account-ID ascending as the tie-break. Opposite-side accounts receive no residual lots. This allocation must sum exactly to abs(Q); an account's allocated residual cannot exceed its order. The remaining shares cross internally. Then allocate the integer micro-USD venue charge proportionally to these integer external lots using the same largest-remainder rule. This is a declared allocation rule, not a claim of universal fairness.

Price disturbances use `p_exec = p_ref * (10000 + execution_price_shock_bps)/10000`. Frozen prices/shocks produce integer micro-USD prices. Internal crosses stay at p_ref. Each residual owner's signed external price difference is `signed_residual_lots_i * (p_exec - p_ref)`. A applies the same formula to its whole order. This value may be negative (a favorable cash adjustment). Per-owner cash is:

`cash_final = cash_initial - sum_a(q_ia*p_ref_a) - allocated_venue_cost_i - sum_a(external_price_difference_ia)`.

The sum of all per-owner cash changes must reconcile with actual external stock proceeds/debits and venue charges. No hypothetical preference, waiting or network cost is deducted from token cash. Require `allocated_venue_cost_i + sum_a(max(0, external_price_difference_ia)) <= cost_debit_budget_micro_usd_i`; favorable price changes do not conceal a fee-budget overrun. Check all final cash bounds afterwards. Report signed execution-price difference separately from spread/impact/fee costs and total execution shortfall versus reference. When comparing methods in disturbance cases, include the signed price difference in their economic cost rather than hiding it.

Largest-remainder micro-USD allocation is deterministic accounting for the economic reference. On-chain stock/cash rounding and authorization are separately frozen in T02/T04 and must be reconciled before using these numbers as an executable proposal. T01 is not an implementation of a residual venue.

## Complete overhead assumptions

All overhead values in JSON are synthetic knobs and must be shown in reports. They are not current Solana fee/rent quotes.

- Per-transaction network fee in lamports is `signatures_per_transaction * lamports_per_signature + priority_lamports_per_transaction`. Convert to micro-USD with `sol_price_micro_usd / 1_000_000_000` as an exact rational.
- A uses `independent_transactions_per_active_owner` for every nonzero-trading account. B/C use `N * batch_funding_transactions_per_owner + batch_settlement_transactions + N * batch_cleanup_transactions_per_owner`. Here cleanup is zero because the assumed successful settlement closes disposable accounts in the same transaction. If implementation cannot do that, amend/re-evaluate transparently before making deployment-based cost claims.
- One bounded retry is permitted. Expected extra failed-transaction network cost is base network cost times `retry_probability_bps/10000`. A failed attempt incurs no venue swap cost because rollback is assumed; it can still incur a network fee. This is an expected-cost sensitivity model, not a guarantee the eventual workflow succeeds or a license to retry forever.
- Waiting opportunity cost is `initial marked portfolio value * opportunity_bps_per_hour/10000 * waiting_seconds/3600`, separately for every participating account; A uses its independent delay, B/C use batch delay. It is a scenario assumption and is charged once for the coordination window, which includes the one-retry allowance. A zero-trade account outside a batch incurs no delay cost. No hidden additional waiting cost is invented or silently omitted.
- Shared successful and expected failed settlement transaction costs are divided equally across declared batch participants as exact rational economic overhead. Each owner's funding/cleanup fees stay with that owner. Separate upfront recoverable rent is `N*lamports_per_owner + lamports_batch_shared` for B/C, never presented as a recurring fee or savings. A uses existing token accounts in this comparison and has zero new escrow rent; both report their prerequisite SOL separately.
- Total recurring modeled economic cost equals venue charges + signed external price difference + successful network fees + expected failed-attempt network fees + waiting opportunity cost. Total objective additionally includes target preference penalty. Protocol fee is zero. Baseline A/B/C use the same conversion, fee and delay parameters.

Network fees use the local wallet's SOL, not fixture CASH. Waiting/preference are valuation estimates and do not move tokens. These distinctions are mandatory in reference output and the eventual UI. If actual deployment transaction counts differ, amend assumptions and report before/after results; do not use a false lower count to retain a benefit.

## Coverage and expected results

Training IDs: opposite-01, all-buy-01, no-overlap-01, asymmetric-01, tight-01, infeasible-01, expensive-01, noise-01, tiny-01, zero-01, stale-01, single-01.

Held-out IDs: opposite-02, all-buy-02, asymmetric-02, tight-02, high-fee-02, noise-02, confidence-02, slow-02.

The opposing-flow example is an opportunity **candidate**, not a promised win. Exact stock bounds in tight cases leave no cooperative degrees of freedom. Disjoint exact orders cannot cross. All-buy, high fees, tiny accounts, one dominant account and slow coordination may have no benefit or lose. Infeasible-01 requires stock progress with zero turnover and is intentionally rejected. Zero-01 is separately a valid zero-holdings/no-trade optimum. Stale reference, wide confidence, beyond-guard disturbance and insufficient participants are explicit expected admission rejections; do not count their lack of trades as savings. No external market hours, real equity liquidity or real-time source authenticity is inferred from these fixtures.

Each hand-written reference puts stocks at their exact target and debits the full declared **venue/adverse-price reserve** from cash. It is a feasibility witness at conservative cash-debit endpoints, not a predicted execution, baseline, optimizer result or actual fee quote. The checker tests stock bounds, error/progress, turnover, fee reserve, nonnegative balances and cash conservation. It also checks the zero-debit cash endpoint. For feasible stock outputs, all intermediate nonnegative debits up to that reserve fit the same cash envelope. Beneficial execution-price credits can exceed this interval and still need actual cash-upper-bound validation in T03. References in rejected price/participation cases can be arithmetically feasible while admission remains rejected. The intentionally impossible reference names `turnover` as its expected failure.

## Checks, freeze and amendment procedure

Run from the repository root:

```
python3 scripts/check-scenarios.py
python3 -m unittest discover -s tests/economics -v
```

The checker does not import an optimizer, search the grid or compute held-out performance. Positive validation requires a disjoint complete split, reproducible hashes, complete costs, labelled synthetic provenance, all categories and correct reference/admission outcomes. Adversarial tests mutate overlapping splits, missing costs, impossible ranges, unlabelled synthetic provenance, no-op progress bypass, fee conservation, hashes, duplicate identities, malformed numeric values, guards, zero depth and rent classification.

Preserve a failed input and the validation error before a correction. Amendments before performance inspection record the reason, affected IDs and old/new hashes in the manifest and task evidence. Changes after inspecting performance require an explicit new suite version, retained old results, rationale and independent review; keep the existing held-out result as part of the disclosure. Neither an amendment nor a passing schema check proves economics. T03 must independently calculate all three methods, actual post-cost feasibility, exact objective optimality, conservation and per-account outcomes. G3 must report all cases, cost/preference ranges and negative results, alongside uncertainty sensitivities.
