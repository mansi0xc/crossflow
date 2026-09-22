# Independent T03 economics review

Reviewed 23 September 2026 against `AGENTS.md`, T03 in `.planning/TASKS.md`, the G0 economic contract in `CROSSFLOW-EXECUTION-PLAN.md`, frozen T01 commit `9614341`, and `.planning/T01-T02-FOUNDATION-REVIEW.md`. Source reviewed: four frozen files in `/private/tmp/crossflow-t03-stage/research/economics`. I did not inspect or compute held-out performance, edit project sources, install dependencies, access the network, or sign a transaction.

## Disposition

**T03 PASS for the narrow G0 economic mechanism criterion after rework.** Frozen training `opposite-01` demonstrates a strict 16,200 micro-USD ($0.0162) recurring cost reduction by C versus a *valid fixed-order* B, after the same declared batch overhead, with A/B/C under unchanged mandates. The no-benefit control is present. This is a mathematical feasibility result, **not** a commercial win, robust market saving, executable protocol proof, or approval of the still-disputed T02 contract. The reported median incremental training saving is $0; the example loses its incremental advantage under both tested ±50 bps price shocks. These limits are accurately disclosed.

An initial **HIGH reporting defect was found and repaired before this pass**: elective C=no-trade could appear as cooperative trading savings against an active B. The revised result retains the real raw cost difference but labels it skipped execution, sets attributable cooperative trading saving to zero, and makes G0 false. The frozen T01 suite and held-out inputs were not changed.

## Independent calculation and checks

The standalone `/private/tmp/crossflow-t03-independent-probe.py` imports no evaluator code. It uses only the frozen `opposite-01` input and independently checks each owner's stock/error/progress/turnover/cash/debit/value bounds, recalculates the exact venue curve, enumerates all three buyer and three seller outputs, applies the declared batch network/retry/waiting assumptions, and ranks the nine joint results.

- A chooses a=4 shares and b=7 shares, i.e. +4/−3 orders. Their separate venue charges are 64,200 and 47,800 micro-USD, and both miss their targets by one $10 share.
- B preserves those orders, crosses three shares, routes one external buy, and pays 16,200 micro-USD venue cost. Batch overhead is exactly 3,600 network + 36 expected retry + 7,850/3 waiting = 18,758/3 micro-USD.
- C chooses a=4, b=6, crossing four shares with zero residual venue cost. It is tied on total objective with a=5,b=5, then wins the stated lower-turnover tie break. Its recurring cost is 18,758/3 versus B's 67,358/3 micro-USD; B−C is exactly 16,200. C's target error is one share lower and stock turnover $10 higher, both within the same mandates.
- Owner a's C cash is 960,000,000 micro-USD; b's is 1,040,000,000. Their cash and share changes conserve the internal trade at the $10 reference price. The unchanged c account is correctly charged coordination overhead in B/C.

I reran all **30** T03 tests successfully. I independently regenerated `reference-results.json` to `/private/tmp/crossflow-t03-independent-reproduction.json`: it is byte-identical, with 12 training runs, 13 declared sensitivities, four explicitly post-freeze scale illustrations, and `heldout_runs=0`. The raw report and code make exact rational costs, signed execution-price differences, fee allocation, recoverable rent, per-owner outcomes and failed-admission cases visible. B receives A's fixed stock orders, while C enumerates the same joint grid; no training output exceeds the 729-candidate cap. The report keeps A−B crossing benefit distinct from B−C adjustment benefit and identifies cases where batching loses to A.

## Rework verification

Reproduction on a *mutated training copy only*: allow a's STOCK_A minimum 0 and b's maximum 10; for all accounts set minimum error reduction to 0 and maximum stock error to 100,000,000; zero each venue spread/fee/impact rate while retaining its 1,000 micro-USD fixed fee; set batch wait to 100,000 seconds. A trades +5/−4; B executes; C elects no trade. The raw B−C recurring difference is `78541724/9` micro-USD. The revised output now says `execution_attribution=skipped_execution_no_cooperative_trading`, `cooperative_trading_benefit_eligible=false`, `incremental_cooperative_trading_savings_micro_usd=0`, and `G0_incremental_cost_criterion_pass=false`. A regression test reproduces this mutation and rejects falsified positive attribution. This closes the defect without suppressing the raw difference.

## Remaining limits and downstream conditions

1. The 200 bps T02 value predicate passes actual optimized training outputs, but T02's F1–F4 normative issues from the foundation review are independent blockers to program implementation. This review makes no on-chain enforceability claim.
2. The `opposite-01` saving is tiny in absolute terms and disappears in the disclosed shock sensitivities. Post-freeze scaling also scales synthetic liquidity depth and uses a coarser share grid; it is an illustration, not evidence of real capital scalability or willingness to pay.
3. The generic checker independently validates arithmetic and feasibility, while the evaluator's enumeration and this standalone probe establish optimality only for the inspected small example. G3 still needs its frozen implementation, independent feasible-result audit, complete held-out report, actual devnet transaction/route costs, and honest negative-case reporting. Consumers must use `incremental_cooperative_trading_savings_micro_usd` together with eligibility/attribution for a trading benefit claim; raw B−C differences are not automatically cooperative savings.

Reviewed frozen source SHA-256:

- `reference.py`: `fd6d7c8734dd26fcad396a35398cdbc6e072a07a1bda244dd2ab035a9b4f69d7`
- `test_reference.py`: `69705790d685b5c5fd2ecf4c9f5ceb1a758c0bd11a1dd85fdd3fa09f847adb04`
- `reference-results.json`: `51a7973598d3a664f335a93faa3ef01b6ad75fa52992f6b9fe8a413037a1ab7c`
- `opportunity-report.md`: `fe56ffae734440e264e039d783895b085c2215a9713f83e45553b40dd916dfae`
