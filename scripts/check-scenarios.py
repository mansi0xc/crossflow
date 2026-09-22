#!/usr/bin/env python3
"""Validate the frozen economics inputs, not optimizer performance (stdlib only)."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

STOCKS = ('STOCK_A', 'STOCK_B')
ASSETS = STOCKS + ('CASH',)
REQUIRED_CATEGORIES = {'opposite_flow', 'all_buy', 'no_overlap', 'asymmetric',
    'tight_bands', 'no_feasible_trades', 'expensive_liquidity', 'price_disturbance',
    'tiny_portfolios', 'zero_holdings', 'expired_price', 'insufficient_participation',
    'high_network_fees', 'wide_confidence', 'waiting_and_retry'}

class ValidationError(ValueError):
    pass

def require(condition, message):
    if not condition:
        raise ValidationError(message)

def integer(value, label, minimum=0, maximum=None):
    require(type(value) is int, label + ': integer required (booleans disallowed)')
    require(value >= minimum, label + ': below minimum')
    require(maximum is None or value <= maximum, label + ': above maximum')

def keys(obj, expected, label):
    require(isinstance(obj, dict), label + ': object required')
    require(set(obj) == set(expected), label + ': unexpected or missing keys')

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def no_floats(value):
    if isinstance(value, dict):
        for v in value.values():
            no_floats(v)
    elif isinstance(value, list):
        for v in value:
            no_floats(v)
    else:
        require(value is None or type(value) in (str, int, bool), 'floating/non-JSON scalar forbidden')

def reference_failures(account, prices):
    """Independent arithmetic for a supplied final portfolio, no optimizer import."""
    initial, final = account['initial_raw'], account['reference']['final_raw']
    fee = account['reference']['cost_debit_micro_usd']
    failures = []
    if any(not account['final_bounds_raw'][a]['min'] <= final[a] <= account['final_bounds_raw'][a]['max'] for a in ASSETS):
        failures.append('output_bounds')
    if any(final[a] < 0 for a in ASSETS):
        failures.append('negative_holdings')
    if not 0 <= fee <= account['cost_debit_budget_micro_usd']:
        failures.append('cost_budget')
    expected_cash = initial['CASH'] - sum((final[a] - initial[a]) * prices[a] for a in STOCKS) - fee
    if final['CASH'] != expected_cash:
        failures.append('cash_conservation')
    before = sum(abs(initial[a] - account['target_raw'][a]) * prices[a] for a in STOCKS)
    after = sum(abs(final[a] - account['target_raw'][a]) * prices[a] for a in STOCKS)
    if after > account['max_stock_error_micro_usd']:
        failures.append('tracking_error')
    if 10000 * after > (10000 - account['min_error_reduction_bps']) * before:
        failures.append('required_progress')
    turnover = sum(abs(final[a] - initial[a]) * prices[a] for a in STOCKS)
    if turnover > account['max_turnover_micro_usd']:
        failures.append('turnover')
    return sorted(failures)

def provably_infeasible(account, prices):
    # Necessary lower bounds suffice for the deliberately infeasible frozen case.
    lower_turnover = sum(max(account['final_bounds_raw'][a]['min'] - account['initial_raw'][a],
                             account['initial_raw'][a] - account['final_bounds_raw'][a]['max'], 0) * prices[a] for a in STOCKS)
    initial_error = sum(abs(account['initial_raw'][a] - account['target_raw'][a]) * prices[a] for a in STOCKS)
    progress_lower = (initial_error * account['min_error_reduction_bps'] + 9999) // 10000
    return max(lower_turnover, progress_lower) > account['max_turnover_micro_usd']

def validate_cost(cost):
    keys(cost, ('external_by_asset', 'internal_fee_bps', 'protocol_fee_bps', 'network', 'waiting', 'recoverable_rent'), 'cost_model')
    keys(cost['external_by_asset'], STOCKS, 'external curves')
    for asset, curve in cost['external_by_asset'].items():
        keys(curve, ('half_spread_bps', 'venue_fee_bps', 'impact_bps_at_depth', 'depth_micro_usd', 'fixed_order_fee_micro_usd'), asset + ' curve')
        for k, v in curve.items():
            integer(v, k, minimum=1 if k == 'depth_micro_usd' else 0)
    require(cost['internal_fee_bps'] == 0 and type(cost['internal_fee_bps']) is int, 'internal fees must be explicit zero')
    require(cost['protocol_fee_bps'] == 0 and type(cost['protocol_fee_bps']) is int, 'protocol fee must be explicit zero')
    network_fields = ('sol_price_micro_usd', 'lamports_per_signature', 'priority_lamports_per_transaction', 'signatures_per_transaction', 'independent_transactions_per_active_owner', 'batch_funding_transactions_per_owner', 'batch_settlement_transactions', 'batch_cleanup_transactions_per_owner', 'retry_probability_bps', 'max_retries')
    keys(cost['network'], network_fields, 'network costs')
    for k, v in cost['network'].items():
        integer(v, k)
    for k in ('sol_price_micro_usd', 'signatures_per_transaction', 'independent_transactions_per_active_owner', 'batch_funding_transactions_per_owner', 'batch_settlement_transactions'):
        require(cost['network'][k] > 0, k + ' must be positive')
    integer(cost['network']['retry_probability_bps'], 'retry probability', maximum=10000)
    require(cost['network']['max_retries'] == 1, 'v1 expected retry model permits exactly one bounded retry')
    keys(cost['waiting'], ('independent_seconds', 'batch_seconds', 'opportunity_bps_per_hour'), 'waiting costs')
    for k, v in cost['waiting'].items():
        integer(v, k)
    keys(cost['recoverable_rent'], ('lamports_per_owner', 'lamports_batch_shared', 'treatment'), 'rent')
    integer(cost['recoverable_rent']['lamports_per_owner'], 'owner rent')
    integer(cost['recoverable_rent']['lamports_batch_shared'], 'batch rent')
    require(cost['recoverable_rent']['treatment'] == 'upfront_deposit_excluded_from_recurring_cost_report_separately', 'rent disclosure required')

def validate_scenario(s):
    keys(s, ('id', 'category', 'split', 'provenance', 'assets', 'accounts', 'cost_model', 'price_observation', 'batch_min_participants', 'expected_admission', 'expected_rejection_reasons', 'expected_qualitative_case'), 'scenario')
    require(isinstance(s['id'], str) and s['id'], 'nonempty scenario ID required')
    require(s['split'] in ('train', 'holdout'), 'invalid split')
    require(isinstance(s['expected_qualitative_case'], str) and s['expected_qualitative_case'], 'qualitative expectation required')
    keys(s['provenance'], ('kind', 'license', 'source', 'is_market_evidence'), 'provenance')
    require(s['provenance']['kind'] == 'synthetic', 'synthetic provenance label required')
    require(s['provenance']['is_market_evidence'] is False, 'synthetic fixture must not claim market evidence')
    require(s['provenance']['license'] == 'CC0-1.0' and bool(s['provenance']['source']), 'provenance/license required')
    require(type(s['assets']) is list and len(s['assets']) == 3, 'three asset definitions required')
    require([a['id'] for a in s['assets']] == list(ASSETS), 'ordered unique asset identities required')
    prices = {}
    for a in s['assets']:
        keys(a, ('id', 'decimals', 'price_micro_usd_per_raw', 'provenance'), 'asset')
        integer(a['decimals'], 'decimals', maximum=9)
        integer(a['price_micro_usd_per_raw'], 'price', minimum=1)
        require(a['provenance'] == 'synthetic_fixture_not_issuer_backed', 'asset fixture disclosure required')
        prices[a['id']] = a['price_micro_usd_per_raw']
    require(s['assets'][0]['decimals'] == s['assets'][1]['decimals'] == 0 and s['assets'][2]['decimals'] == 6 and prices['CASH'] == 1, 'v1 unit convention changed')
    require(type(s['accounts']) is list and 1 <= len(s['accounts']) <= 3, 'one to three accounts required')
    require(len(set(a['id'] for a in s['accounts'])) == len(s['accounts']), 'duplicate account ID')
    for a in s['accounts']:
        keys(a, ('id', 'initial_raw', 'target_raw', 'final_bounds_raw', 'min_error_reduction_bps', 'max_stock_error_micro_usd', 'max_turnover_micro_usd', 'cost_debit_budget_micro_usd', 'reference'), 'account')
        require(isinstance(a['id'], str) and a['id'], 'nonempty account ID required')
        keys(a['initial_raw'], ASSETS, 'initial amounts')
        keys(a['target_raw'], STOCKS, 'targets')
        keys(a['final_bounds_raw'], ASSETS, 'bounds')
        for k, v in a['initial_raw'].items(): integer(v, k + ' initial')
        for k, v in a['target_raw'].items(): integer(v, k + ' target')
        for k, b in a['final_bounds_raw'].items():
            keys(b, ('min', 'max'), k + ' bound')
            integer(b['min'], k + ' min'); integer(b['max'], k + ' max')
            require(b['min'] <= b['max'], 'impossible target range')
            if k in STOCKS:
                require(b['min'] <= a['target_raw'][k] <= b['max'], 'target outside permitted range')
        integer(a['min_error_reduction_bps'], 'progress', maximum=10000)
        for k in ('max_stock_error_micro_usd', 'max_turnover_micro_usd', 'cost_debit_budget_micro_usd'): integer(a[k], k)
        r = a['reference']
        keys(r, ('final_raw', 'cost_debit_micro_usd', 'expected_feasible', 'expected_failures'), 'reference')
        keys(r['final_raw'], ASSETS, 'reference outputs')
        for k, v in r['final_raw'].items(): integer(v, k + ' final', minimum=-(2**63))
        integer(r['cost_debit_micro_usd'], 'reference fee')
        require(r['cost_debit_micro_usd'] == a['cost_debit_budget_micro_usd'], 'reference must exercise the full debit reserve')
        require(type(r['expected_feasible']) is bool, 'expected feasibility must be boolean')
        require(type(r['expected_failures']) is list and len(set(r['expected_failures'])) == len(r['expected_failures']), 'unique expected failures required')
        failures = reference_failures(a, prices)
        require(failures == sorted(r['expected_failures']), s['id'] + '/' + a['id'] + ': unexpected reference failures ' + str(failures))
        require(r['expected_feasible'] == (not failures), 'reference expectation inconsistent')
        # The hand witness charges the entire fee reserve; verify every smaller
        # nonnegative venue charge also remains in the cash envelope endpoints.
        if r['expected_feasible']:
            upper_cash = r['final_raw']['CASH'] + r['cost_debit_micro_usd']
            require(upper_cash <= a['final_bounds_raw']['CASH']['max'], 'zero-fee reference exceeds cash upper bound')
    validate_cost(s['cost_model'])
    p = s['price_observation']
    keys(p, ('as_of_unix', 'observation_unix', 'max_age_seconds', 'confidence_bps', 'max_confidence_bps', 'execution_price_shock_bps', 'max_price_deviation_bps'), 'price observation')
    for k, v in p.items():
        if k != 'execution_price_shock_bps': integer(v, k)
    keys(p['execution_price_shock_bps'], STOCKS, 'price shocks')
    for v in p['execution_price_shock_bps'].values(): integer(v, 'shock', minimum=-9999, maximum=10000)
    require(p['observation_unix'] <= p['as_of_unix'], 'future reference forbidden')
    integer(s['batch_min_participants'], 'batch size', minimum=2, maximum=3)
    reasons = []
    if p['as_of_unix'] - p['observation_unix'] > p['max_age_seconds']: reasons.append('stale_price')
    if p['confidence_bps'] > p['max_confidence_bps']: reasons.append('wide_confidence')
    if any(abs(v) > p['max_price_deviation_bps'] for v in p['execution_price_shock_bps'].values()): reasons.append('price_deviation')
    if len(s['accounts']) < s['batch_min_participants']: reasons.append('insufficient_participation')
    if any(provably_infeasible(a, prices) for a in s['accounts']): reasons.append('infeasible_mandate')
    require(sorted(reasons) == sorted(s['expected_rejection_reasons']), 'admission rejection reasons differ')
    require(s['expected_admission'] == ('reject' if reasons else 'accept'), 'admission expectation differs')
    if s['expected_admission'] == 'accept': require(all(a['reference']['expected_feasible'] for a in s['accounts']), 'accepted case lacks feasible reference')

def validate(data, manifest):
    no_floats(data); no_floats(manifest)
    keys(data, ('schema_version', 'suite_id', 'seed', 'created_before_optimizer', 'generation', 'evaluation_contract', 'scenarios'), 'suite')
    require(data['schema_version'] == 1 and type(data['schema_version']) is int, 'schema version must be 1')
    integer(data['seed'], 'seed')
    require(data['created_before_optimizer'] is True, 'freeze must precede tuning')
    require(type(data['scenarios']) is list and data['scenarios'], 'scenario list required')
    ids = [s['id'] for s in data['scenarios']]
    require(len(set(ids)) == len(ids), 'duplicate scenario IDs')
    require(REQUIRED_CATEGORIES <= {s['category'] for s in data['scenarios']}, 'missing representative category')
    evaluation = data['evaluation_contract']
    require(evaluation == {'objective':'recurring_execution_cost_plus_stock_target_penalty','tracking_penalty_bps':5,'tie_break':['stock_target_error_micro_usd','stock_turnover_micro_usd','lexicographic_final_stock_raw_by_account_id'],'stock_grid_step_raw':1,'max_joint_grid_candidates':729,'shared_cost_allocation':'integer_residual_lots_then_fee_largest_remainder_by_account_id','bounds_after_venue_costs':True,'reject_infeasible_baselines':True}, 'v1 evaluation contract changed')
    for s in data['scenarios']:
        validate_scenario(s)
        candidates = 1
        for a in s['accounts']:
            for stock in STOCKS:
                b = a['final_bounds_raw'][stock]
                candidates *= b['max'] - b['min'] + 1
        require(candidates <= evaluation['max_joint_grid_candidates'], 'exact enumeration budget exceeded')
    keys(manifest, ('schema_version', 'suite_id', 'seed', 'canonicalization', 'suite_sha256', 'train_ids', 'holdout_ids', 'scenario_sha256', 'frozen_before_optimizer_tuning', 'amendments'), 'manifest')
    require(manifest['schema_version'] == 1 and type(manifest['schema_version']) is int, 'manifest schema version must be 1')
    require(manifest['suite_id'] == data['suite_id'] and manifest['seed'] == data['seed'], 'manifest suite/seed mismatch')
    require(manifest['frozen_before_optimizer_tuning'] is True, 'manifest freeze required')
    train, holdout = manifest['train_ids'], manifest['holdout_ids']
    require(type(train) is list and type(holdout) is list and train and holdout, 'both split lists required')
    require(len(train) == len(set(train)) and len(holdout) == len(set(holdout)), 'duplicate IDs within split')
    require(not set(train) & set(holdout), 'overlapping train/holdout IDs')
    require(set(train) | set(holdout) == set(ids), 'split does not partition scenarios')
    for s in data['scenarios']:
        require(s['id'] in (train if s['split'] == 'train' else holdout), 'split label mismatch')
    require(manifest['suite_sha256'] == digest(data), 'suite hash mismatch')
    require(manifest['scenario_sha256'] == {s['id']: digest(s) for s in data['scenarios']}, 'scenario hash mismatch')
    require(type(manifest['amendments']) is list, 'amendment log required')
    return {'status':'PASS','scenarios':len(ids),'train':len(train),'holdout':len(holdout),'references':sum(len(s['accounts']) for s in data['scenarios']),'expected_rejections':sum(s['expected_admission']=='reject' for s in data['scenarios']),'suite_sha256':digest(data),'optimizer_runs':0}

def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenarios', type=Path, default=root/'research/economics/scenarios.json')
    parser.add_argument('--manifest', type=Path, default=root/'research/economics/split-manifest.json')
    args = parser.parse_args()
    try:
        result = validate(json.loads(args.scenarios.read_text()), json.loads(args.manifest.read_text()))
    except (ValidationError, KeyError, TypeError, ValueError, OSError) as exc:
        print('FAIL: ' + str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0

if __name__ == '__main__':
    sys.exit(main())
