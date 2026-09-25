# CrossFlow economic evaluation

Split: **holdout** · frozen suite `f8ce9388d0280a9faa92327d9f341fc9f265f22cc271f25f4d106ae60d7b59e7` · schema 1

All values are integer micro-USD from the frozen exact-rational model. Method A is
independent execution, B is fixed-order netting of A's own orders, C is cooperative joint
adjustment. `netting` is A minus B; `cooperative` is B minus C and is only attributed when
both baselines execute nonzero trades.

## Headline

- scenarios evaluated: **8**
- scenarios where all three methods are feasible: **6**
- scenarios rejected before search (mandate/oracle): **2**
- scenarios where a cooperative trading saving is attributable: **6**
- netting gain (micro-USD): median 46025, min -5155280, max 762373/3, positive 4, negative 2
- cooperative gain (micro-USD): median 16200, min 0, max 50800, positive 4, negative 0
- holds under every declared sensitivity point: **True** (40 of 40 points at risk kept the gain)

## Per scenario

| scenario | category | A/B/C status | netting gain | cooperative gain | eligible |
|---|---|---|---|---|---|
| opposite-02 | opposite_flow | ok/ok/ok | 159391 | 16200 | True |
| all-buy-02 | all_buy | ok/ok/ok | -16252/3 | 0 | True |
| asymmetric-02 | asymmetric | ok/ok/ok | 233623/3 | 50800 | True |
| tight-02 | tight_bands | ok/ok/ok | 762373/3 | 0 | True |
| high-fee-02 | high_network_fees | ok/ok/ok | 85055/6 | 16200 | True |
| noise-02 | price_disturbance | rejected/rejected/rejected | — | — | None |
| confidence-02 | wide_confidence | rejected/rejected/rejected | — | — | None |
| slow-02 | waiting_and_retry | ok/ok/ok | -5155280 | 16200 | True |

## Sensitivity (declared before the run)

| scenario | parameter | value | netting gain | cooperative gain |
|---|---|---|---|---|
| opposite-02 | external_fee_multiplier_bps | 5000 | 79541 | 8200 |
| opposite-02 | external_fee_multiplier_bps | 10000 | 159391 | 16200 |
| opposite-02 | external_fee_multiplier_bps | 20000 | 309089 | 31200 |
| opposite-02 | batch_extra_wait_seconds | 0 | 161191 | 16200 |
| opposite-02 | batch_extra_wait_seconds | 60 | 157591 | 16200 |
| opposite-02 | batch_extra_wait_seconds | 300 | 143191 | 16200 |
| opposite-02 | batch_extra_wait_seconds | 3600 | -54809 | 16200 |
| opposite-02 | liquidity_depth_multiplier_bps | 2500 | 195391 | 16800 |
| opposite-02 | liquidity_depth_multiplier_bps | 10000 | 159391 | 16200 |
| opposite-02 | liquidity_depth_multiplier_bps | 40000 | 150391 | 16050 |
| all-buy-02 | external_fee_multiplier_bps | 5000 | -5342 | 0 |
| all-buy-02 | external_fee_multiplier_bps | 10000 | -5418 | 0 |
| all-buy-02 | external_fee_multiplier_bps | 20000 | -5569 | 0 |
| all-buy-02 | batch_extra_wait_seconds | 0 | -3709 | 0 |
| all-buy-02 | batch_extra_wait_seconds | 60 | -7126 | 0 |
| all-buy-02 | batch_extra_wait_seconds | 300 | -20793 | 0 |
| all-buy-02 | batch_extra_wait_seconds | 3600 | -208709 | 0 |
| all-buy-02 | liquidity_depth_multiplier_bps | 2500 | -19818 | 0 |
| all-buy-02 | liquidity_depth_multiplier_bps | 10000 | -5418 | 0 |
| all-buy-02 | liquidity_depth_multiplier_bps | 40000 | -1818 | 0 |
| asymmetric-02 | external_fee_multiplier_bps | 5000 | 45950 | 34800 |
| asymmetric-02 | external_fee_multiplier_bps | 10000 | 77874 | 50800 |
| asymmetric-02 | external_fee_multiplier_bps | 20000 | 137722 | 80800 |
| asymmetric-02 | batch_extra_wait_seconds | 0 | 83291 | 50800 |
| asymmetric-02 | batch_extra_wait_seconds | 60 | 72457 | 50800 |
| asymmetric-02 | batch_extra_wait_seconds | 300 | 29124 | 50800 |
| asymmetric-02 | batch_extra_wait_seconds | 3600 | -566709 | 50800 |
| asymmetric-02 | liquidity_depth_multiplier_bps | 2500 | 147474 | 113200 |
| asymmetric-02 | liquidity_depth_multiplier_bps | 10000 | 77874 | 50800 |
| asymmetric-02 | liquidity_depth_multiplier_bps | 40000 | 60474 | 35200 |
| tight-02 | external_fee_multiplier_bps | 5000 | 126200 | 0 |
| tight-02 | external_fee_multiplier_bps | 10000 | 254124 | 0 |
| tight-02 | external_fee_multiplier_bps | 20000 | 493972 | 0 |
| tight-02 | batch_extra_wait_seconds | 0 | 255891 | 0 |
| tight-02 | batch_extra_wait_seconds | 60 | 252357 | 0 |
| tight-02 | batch_extra_wait_seconds | 300 | 238224 | 0 |
| tight-02 | batch_extra_wait_seconds | 3600 | 43891 | 0 |
| tight-02 | liquidity_depth_multiplier_bps | 2500 | 292524 | 0 |
| tight-02 | liquidity_depth_multiplier_bps | 10000 | 254124 | 0 |
| tight-02 | liquidity_depth_multiplier_bps | 40000 | 244524 | 0 |
| high-fee-02 | external_fee_multiplier_bps | 5000 | 5750 | 8200 |
| high-fee-02 | external_fee_multiplier_bps | 10000 | 14175 | 16200 |
| high-fee-02 | external_fee_multiplier_bps | 20000 | 29025 | 31200 |
| high-fee-02 | batch_extra_wait_seconds | 0 | 15892 | 16200 |
| high-fee-02 | batch_extra_wait_seconds | 60 | 12459 | 16200 |
| high-fee-02 | batch_extra_wait_seconds | 300 | -1275 | 16200 |
| high-fee-02 | batch_extra_wait_seconds | 3600 | -190108 | 16200 |
| high-fee-02 | liquidity_depth_multiplier_bps | 2500 | 16575 | 16800 |
| high-fee-02 | liquidity_depth_multiplier_bps | 10000 | 14175 | 16200 |
| high-fee-02 | liquidity_depth_multiplier_bps | 40000 | 13575 | 16050 |
| noise-02 | external_fee_multiplier_bps | 5000 | — | — |
| noise-02 | external_fee_multiplier_bps | 10000 | — | — |
| noise-02 | external_fee_multiplier_bps | 20000 | — | — |
| noise-02 | batch_extra_wait_seconds | 0 | — | — |
| noise-02 | batch_extra_wait_seconds | 60 | — | — |
| noise-02 | batch_extra_wait_seconds | 300 | — | — |
| noise-02 | batch_extra_wait_seconds | 3600 | — | — |
| noise-02 | liquidity_depth_multiplier_bps | 2500 | — | — |
| noise-02 | liquidity_depth_multiplier_bps | 10000 | — | — |
| noise-02 | liquidity_depth_multiplier_bps | 40000 | — | — |
| confidence-02 | external_fee_multiplier_bps | 5000 | — | — |
| confidence-02 | external_fee_multiplier_bps | 10000 | — | — |
| confidence-02 | external_fee_multiplier_bps | 20000 | — | — |
| confidence-02 | batch_extra_wait_seconds | 0 | — | — |
| confidence-02 | batch_extra_wait_seconds | 60 | — | — |
| confidence-02 | batch_extra_wait_seconds | 300 | — | — |
| confidence-02 | batch_extra_wait_seconds | 3600 | — | — |
| confidence-02 | liquidity_depth_multiplier_bps | 2500 | — | — |
| confidence-02 | liquidity_depth_multiplier_bps | 10000 | — | — |
| confidence-02 | liquidity_depth_multiplier_bps | 40000 | — | — |
| slow-02 | external_fee_multiplier_bps | 5000 | -5203190 | 8200 |
| slow-02 | external_fee_multiplier_bps | 10000 | -5155280 | 16200 |
| slow-02 | external_fee_multiplier_bps | 20000 | -5065460 | 31200 |
| slow-02 | batch_extra_wait_seconds | 0 | 94720 | 16200 |
| slow-02 | batch_extra_wait_seconds | 60 | -255280 | 16200 |
| slow-02 | batch_extra_wait_seconds | 300 | -1655280 | 16200 |
| slow-02 | batch_extra_wait_seconds | 3600 | -20905280 | 16200 |
| slow-02 | liquidity_depth_multiplier_bps | 2500 | -5140880 | 16800 |
| slow-02 | liquidity_depth_multiplier_bps | 10000 | -5155280 | 16200 |
| slow-02 | liquidity_depth_multiplier_bps | 40000 | -5158880 | 16050 |

## What this does and does not show

- It measures a **modeled** comparison under one frozen cost convention on synthetic
  scenarios. It is not realized trading, not live liquidity and not a backtest of real
  fills. Equal-state comparison differs from sequential live trades that move reserves.
- The cooperative engine explores the frozen integer grid only; `ok_bounded` rows did not
  exhaust their space, so their optimality is bounded, not proven.
- Reordered payments, network fees and recoverable rent are reported separately from
  trading cost; one-time rent is a deposit, not a recurring saving.
- A negative or zero cooperative gain is reported as such and is not replaced by a
  different counterfactual.
