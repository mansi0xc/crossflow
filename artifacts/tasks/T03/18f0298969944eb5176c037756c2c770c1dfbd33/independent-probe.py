#!/usr/bin/env python3
"""Independent exact check of frozen TRAIN opposite-01; imports no evaluator code."""
from fractions import Fraction as Q
from itertools import product
import json
from pathlib import Path

root = Path('/Users/mansitibrewal/chronicles/crossflow')
suite = json.loads((root / 'research/economics/scenarios.json').read_text())
s = next(x for x in suite['scenarios'] if x['id'] == 'opposite-01' and x['split'] == 'train')
a, b, c = s['accounts']
p = s['assets'][0]['price_micro_usd_per_raw']
curve = s['cost_model']['external_by_asset']['STOCK_A']

def charge(lots):
    if not lots:
        return 0
    v = abs(lots) * p
    exact = (Q(v * (curve['half_spread_bps'] + curve['venue_fee_bps']), 10000)
             + Q(v * v * curve['impact_bps_at_depth'], 10000 * curve['depth_micro_usd'])
             + curve['fixed_order_fee_micro_usd'])
    return (exact.numerator + exact.denominator - 1) // exact.denominator

def owner_check(owner, x, fee):
    h = owner['initial_raw']['STOCK_A']
    target = owner['target_raw']['STOCK_A']
    e0 = abs(h - target) * p
    e1 = abs(x - target) * p
    t = abs(x - h) * p
    cash = owner['initial_raw']['CASH'] - (x - h) * p - fee
    stock_bounds = owner['final_bounds_raw']['STOCK_A']
    cash_bounds = owner['final_bounds_raw']['CASH']
    initial_value = owner['initial_raw']['CASH'] + h * p + owner['initial_raw']['STOCK_B'] * 20_000_000
    final_value = cash + x * p + owner['initial_raw']['STOCK_B'] * 20_000_000
    good = (stock_bounds['min'] <= x <= stock_bounds['max']
            and cash_bounds['min'] <= cash <= cash_bounds['max']
            and 10000 * e1 <= (10000 - owner['min_error_reduction_bps']) * e0
            and e1 <= owner['max_stock_error_micro_usd']
            and t <= owner['max_turnover_micro_usd']
            and fee <= owner['cost_debit_budget_micro_usd']
            and final_value * 10000 >= initial_value * 9800)
    return good, cash, e1, t

independent = []
for owner in (a, b):
    choices = []
    for x in range(owner['final_bounds_raw']['STOCK_A']['min'], owner['final_bounds_raw']['STOCK_A']['max'] + 1):
        fee = charge(x - owner['initial_raw']['STOCK_A'])
        good, cash, error, turn = owner_check(owner, x, fee)
        if good:
            choices.append((Q(fee) + Q(error, 2000), error, turn, x, fee, cash))
    independent.append(min(choices))
ax, bx = independent[0][3], independent[1][3]
assert (ax, bx) == (4, 7)
net_b = (ax - a['initial_raw']['STOCK_A']) + (bx - b['initial_raw']['STOCK_A'])
assert net_b == 1 and charge(net_b) == 16_200

network = Q(4 * 6000 * 150_000_000, 1_000_000_000)
retry = network * Q(100, 10000)
marked = sum(o['initial_raw']['CASH'] + o['initial_raw']['STOCK_A'] * p
             + o['initial_raw']['STOCK_B'] * 20_000_000 for o in (a, b, c))
waiting = Q(marked * 30, 3600 * 10000)
assert (network, retry, waiting) == (3600, 36, Q(7850, 3))

joint = []
for x, y in product(range(4, 7), range(5, 8)):
    net = (x - a['initial_raw']['STOCK_A']) + (y - b['initial_raw']['STOCK_A'])
    fee = charge(net)
    # Across this nine-point grid, the residual is 0 or one-sided, so its
    # single eligible owner bears its entire external charge.
    fa, fb = (fee if net > 0 else 0), (fee if net < 0 else 0)
    va, ca, ea, ta = owner_check(a, x, fa)
    vb, cb, eb, tb = owner_check(b, y, fb)
    if va and vb:
        joint.append((Q(fee) + Q(ea + eb, 2000) + network + retry + waiting,
                      ea + eb, ta + tb, x, y, fee, ca, cb))
best = min(joint)
assert len(joint) == 9
assert best[3:6] == (4, 6, 0)
assert best[6:8] == (960_000_000, 1_040_000_000)
assert charge(net_b) - best[5] == 16_200
assert Q(16_200) + network + retry + waiting == Q(67358, 3)
assert best[5] + network + retry + waiting == Q(18758, 3)
print('PASS: all 9 joint cases independently enumerated; A=(4,7), B residual=1, C=(4,6)')
print(f'B recurring={Q(67358,3)}; C recurring={Q(18758,3)}; B-C=16200 micro-USD')
