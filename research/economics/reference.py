#!/usr/bin/env python3
"""Exact, training-only CrossFlow economic reference. Python standard library."""
import argparse
import copy
from fractions import Fraction as F
import hashlib
from itertools import product
import json
from pathlib import Path

STOCKS = ('STOCK_A', 'STOCK_B')
ASSETS = STOCKS + ('CASH',)
M = 1_000_000


def canonical(x):
    return json.dumps(x, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def sha(x):
    return hashlib.sha256(canonical(x)).hexdigest()


def ceil(x):
    return -(-x.numerator // x.denominator)


def apportion(total, weights):
    """Integer largest remainder, ascending owner ID on equal remainder."""
    if total < 0 or any(v < 0 for v in weights.values()):
        raise ValueError('nonnegative allocation required')
    denominator = sum(weights.values())
    if not denominator:
        if total:
            raise ValueError('positive allocation without contributors')
        return {k: 0 for k in weights}
    shares = {k: F(total * v, denominator) for k, v in weights.items()}
    result = {k: v.numerator // v.denominator for k, v in shares.items()}
    ranking = sorted(weights, key=lambda k: (-(shares[k] - result[k]), k))
    for k in ranking[:total - sum(result.values())]:
        result[k] += 1
    return result


def venue_charge(notional, curve):
    if notional == 0:
        return 0
    return ceil(F(notional * (curve['half_spread_bps'] + curve['venue_fee_bps']), 10000)
                + F(notional**2 * curve['impact_bps_at_depth'], 10000 * curve['depth_micro_usd'])
                + curve['fixed_order_fee_micro_usd'])


def prices(s):
    return {a['id']: a['price_micro_usd_per_raw'] for a in s['assets']}


def grid(a, step=1):
    return [dict(zip(STOCKS, p)) for p in product(*(range(a['final_bounds_raw'][k]['min'], a['final_bounds_raw'][k]['max'] + 1, step) for k in STOCKS))]


def stock_metrics(a, x, p):
    before = sum(abs(a['initial_raw'][k] - a['target_raw'][k]) * p[k] for k in STOCKS)
    after = sum(abs(x[k] - a['target_raw'][k]) * p[k] for k in STOCKS)
    turnover = sum(abs(x[k] - a['initial_raw'][k]) * p[k] for k in STOCKS)
    return before, after, turnover


def admission_reasons(s):
    p = s['price_observation']
    reasons = []
    if p['observation_unix'] > p['as_of_unix']:
        reasons.append('future_price')
    if p['as_of_unix'] - p['observation_unix'] > p['max_age_seconds']:
        reasons.append('stale_price')
    if p['confidence_bps'] > p['max_confidence_bps']:
        reasons.append('wide_confidence')
    if any(abs(v) > p['max_price_deviation_bps'] for v in p['execution_price_shock_bps'].values()):
        reasons.append('price_deviation')
    if len(s['accounts']) < s['batch_min_participants']:
        reasons.append('insufficient_participation')
    for a in s['accounts']:
        minimum_turnover = sum(max(0, a['final_bounds_raw'][k]['min'] - a['initial_raw'][k], a['initial_raw'][k] - a['final_bounds_raw'][k]['max']) * prices(s)[k] for k in STOCKS)
        required_progress = F(stock_metrics(a, a['initial_raw'], prices(s))[0] * a['min_error_reduction_bps'], 10000)
        if max(minimum_turnover, required_progress) > a['max_turnover_micro_usd']:
            reasons.append('infeasible_mandate')
            break
    return sorted(reasons)


def policy_guard(a, final, p):
    # p here is per model raw unit; this exactly cancels the common 10^9
    # factor in T02's whole-token p * 10^(9-decimals) value normalization.
    before = sum(a['initial_raw'][k] * p[k] for k in ASSETS)
    after = sum(final[k] * p[k] for k in ASSETS)
    return {'passes': after * 10000 >= before * 9800,
            'funded_value_micro_usd': before, 'output_value_micro_usd': after,
            'loss_micro_usd': before - after, 'max_loss_bps': 200,
            'integer_slack': after * 10000 - before * 9800}


def evaluate(s, outputs, mode, enforce_policy=False):
    """Price a fixed stock-output matrix without changing any mandate."""
    if mode not in ('independent', 'batch'):
        raise ValueError('unknown route mode')
    accounts = sorted(s['accounts'], key=lambda a: a['id'])
    p = prices(s)
    q = {a['id']: {k: outputs[a['id']][k] - a['initial_raw'][k] for k in STOCKS} for a in accounts}
    external = {a['id']: {k: 0 for k in STOCKS} for a in accounts}
    fees = {a['id']: 0 for a in accounts}
    deltas = {a['id']: {k: 0 for k in STOCKS} for a in accounts}
    orders = []
    active = {i for i in q if any(q[i].values())}
    for k in STOCKS:
        execution_price = F(p[k] * (10000 + s['price_observation']['execution_price_shock_bps'][k]), 10000)
        if execution_price.denominator != 1:
            raise ValueError('noninteger execution price outside frozen convention')
        execution_price = int(execution_price)
        groups = [{i: q[i][k]} for i in q] if mode == 'independent' else [{i: q[i][k] for i in q}]
        for group in groups:
            net = sum(group.values())
            if not net:
                continue
            direction = 1 if net > 0 else -1
            eligible = {i: abs(v) if v * direction > 0 else 0 for i, v in group.items()}
            lots = apportion(abs(net), eligible)
            charge = venue_charge(abs(net) * execution_price, s['cost_model']['external_by_asset'][k])
            allocated_fees = apportion(charge, lots)
            for i in lots:
                external[i][k] += direction * lots[i]
                fees[i] += allocated_fees[i]
                deltas[i][k] += direction * lots[i] * (execution_price - p[k])
            orders.append({'asset': k, 'signed_quantity_raw': net, 'execution_price_micro_usd_per_raw': execution_price, 'venue_cost_micro_usd': charge, 'owner_lots': {i: direction*v for i, v in lots.items()}, 'owner_fee_micro_usd': allocated_fees})
    n = s['cost_model']['network']
    fee_lamports = n['lamports_per_signature'] * n['signatures_per_transaction'] + n['priority_lamports_per_transaction']
    fee_micro = F(fee_lamports * n['sol_price_micro_usd'], 1_000_000_000)
    wait = s['cost_model']['waiting']
    rows = []
    for a in accounts:
        i = a['id']; initial = a['initial_raw']
        final = dict(outputs[i])
        final['CASH'] = initial['CASH'] - sum(q[i][k] * p[k] for k in STOCKS) - fees[i] - sum(deltas[i].values())
        before_error, error, turnover = stock_metrics(a, final, p)
        if mode == 'independent':
            tx_count = F(n['independent_transactions_per_active_owner'] if i in active else 0)
            seconds = wait['independent_seconds'] if i in active else 0
        elif active:
            tx_count = n['batch_funding_transactions_per_owner'] + n['batch_cleanup_transactions_per_owner'] + F(n['batch_settlement_transactions'], len(accounts))
            seconds = wait['batch_seconds']
        else:
            tx_count = F(0); seconds = 0
        network = tx_count * fee_micro
        retry = network * F(n['retry_probability_bps'], 10000)
        waiting = F(sum(initial[k] * p[k] for k in ASSETS) * wait['opportunity_bps_per_hour'] * seconds, 10000 * 3600)
        preference = F(error * 5, 10000)
        recurring = fees[i] + sum(deltas[i].values()) + network + retry + waiting
        failures = []
        if any(final[k] < 0 for k in ASSETS): failures.append('negative_holdings')
        if any(not a['final_bounds_raw'][k]['min'] <= final[k] <= a['final_bounds_raw'][k]['max'] for k in ASSETS): failures.append('output_bounds')
        if error > a['max_stock_error_micro_usd']: failures.append('tracking_error')
        if error * 10000 > before_error * (10000 - a['min_error_reduction_bps']): failures.append('required_progress')
        if turnover > a['max_turnover_micro_usd']: failures.append('turnover')
        adverse_debit = fees[i] + sum(max(0, v) for v in deltas[i].values())
        if adverse_debit > a['cost_debit_budget_micro_usd']: failures.append('cost_budget')
        guard = policy_guard(a, final, p)
        if enforce_policy and not guard['passes']: failures.append('value_loss_guard')
        rows.append({'id':i, 'initial_raw':dict(initial), 'final_raw':final, 'trades_raw':q[i], 'external_raw':external[i], 'internal_raw':{k:q[i][k]-external[i][k] for k in STOCKS}, 'venue_cost_micro_usd':fees[i], 'price_difference_micro_usd':sum(deltas[i].values()), 'price_difference_by_asset':deltas[i], 'network_micro_usd':network, 'expected_retry_micro_usd':retry, 'waiting_micro_usd':waiting, 'preference_micro_usd':preference, 'recurring_micro_usd':recurring, 'objective_micro_usd':recurring+preference, 'before_error_micro_usd':before_error, 'after_error_micro_usd':error, 'turnover_micro_usd':turnover, 'transactions_allocated':tx_count, 'adverse_debit_micro_usd':adverse_debit, 'value_guard':guard, 'failures':failures,
                     'slacks':{'bounds':{k:{'min':final[k]-a['final_bounds_raw'][k]['min'],'max':a['final_bounds_raw'][k]['max']-final[k]} for k in ASSETS},'tracking_micro_usd':a['max_stock_error_micro_usd']-error,'progress_integer':before_error*(10000-a['min_error_reduction_bps'])-error*10000,'turnover_micro_usd':a['max_turnover_micro_usd']-turnover,'cost_budget_micro_usd':a['cost_debit_budget_micro_usd']-adverse_debit}})
    totals = {key:sum(row[key] for row in rows) for key in ('venue_cost_micro_usd','price_difference_micro_usd','network_micro_usd','expected_retry_micro_usd','waiting_micro_usd','preference_micro_usd','recurring_micro_usd','objective_micro_usd','after_error_micro_usd','turnover_micro_usd','transactions_allocated')}
    rent = s['cost_model']['recoverable_rent']
    totals['upfront_recoverable_rent_lamports'] = (len(accounts)*rent['lamports_per_owner']+rent['lamports_batch_shared']) if mode == 'batch' and active else 0
    result = {'mode':mode,'feasible':not any(row['failures'] for row in rows),'policy_enforced':enforce_policy,'accounts':rows,'external_orders':orders,'totals':totals,'mandate_sha256':sha(s),'noop':not active}
    return result


def independent_check(s, result):
    """Validate result ledger directly, without calling evaluate/stock_metrics.

    Authoritative input is the unchanged scenario, not planner-produced slacks.
    This independently checks constraints/accounting, not a second optimizer.
    """
    p = {x['id']: x['price_micro_usd_per_raw'] for x in s['assets']}
    errors = []
    if result['mandate_sha256'] != sha(s): errors.append('changed_mandate')
    if result['mode'] not in ('independent', 'batch'): errors.append('mode')
    src = {a['id']:a for a in s['accounts']}
    if {r['id'] for r in result['accounts']} != set(src) or len(result['accounts']) != len(src): return ['owner_set']
    actual_feasible = True
    for r in result['accounts']:
        a=src[r['id']]; x=r['final_raw']; h=a['initial_raw']
        changes={k:x[k]-h[k] for k in STOCKS}
        error=sum(abs(x[k]-a['target_raw'][k])*p[k] for k in STOCKS)
        initial_error=sum(abs(h[k]-a['target_raw'][k])*p[k] for k in STOCKS)
        turnover=sum(abs(changes[k])*p[k] for k in STOCKS)
        valid=all(x[k]>=0 and a['final_bounds_raw'][k]['min']<=x[k]<=a['final_bounds_raw'][k]['max'] for k in ASSETS)
        valid &= error<=a['max_stock_error_micro_usd'] and turnover<=a['max_turnover_micro_usd']
        valid &= error*10000<=initial_error*(10000-a['min_error_reduction_bps'])
        valid &= r['venue_cost_micro_usd']+sum(max(0,v) for v in r['price_difference_by_asset'].values())<=a['cost_debit_budget_micro_usd']
        if result['policy_enforced']:
            valid &= sum(x[k]*p[k] for k in ASSETS)*10000>=sum(h[k]*p[k] for k in ASSETS)*9800
        actual_feasible &= valid
        if x['CASH']+sum(changes[k]*p[k] for k in STOCKS)+r['venue_cost_micro_usd']+r['price_difference_micro_usd']!=h['CASH']: errors.append('cash_conservation/'+r['id'])
        if r['initial_raw']!=h: errors.append('initial_state')
        if changes!=r['trades_raw']: errors.append('trade_identity')
        expected_owner_fee=sum(o['owner_fee_micro_usd'].get(r['id'],0) for o in result['external_orders'])
        expected_owner_external={k:sum(o['owner_lots'].get(r['id'],0) for o in result['external_orders'] if o['asset']==k) for k in STOCKS}
        expected_delta={k:sum(o['owner_lots'].get(r['id'],0)*(o['execution_price_micro_usd_per_raw']-p[k]) for o in result['external_orders'] if o['asset']==k) for k in STOCKS}
        if expected_owner_fee!=r['venue_cost_micro_usd'] or expected_owner_external!=r['external_raw']: errors.append('owner_allocation')
        if expected_delta!=r['price_difference_by_asset'] or sum(expected_delta.values())!=r['price_difference_micro_usd']: errors.append('price_difference')
        if any(r['internal_raw'][k]+r['external_raw'][k]!=changes[k] for k in STOCKS): errors.append('owner_stock_identity')
        n=s['cost_model']['network']; w=s['cost_model']['waiting']
        any_active=any(any(rr['trades_raw'].values()) for rr in result['accounts'])
        own_active=any(changes.values())
        if result['mode']=='independent':
            tx=F(n['independent_transactions_per_active_owner'] if own_active else 0)
            seconds=w['independent_seconds'] if own_active else 0
        else:
            tx=F(n['batch_funding_transactions_per_owner']+n['batch_cleanup_transactions_per_owner'])+F(n['batch_settlement_transactions'],len(src)) if any_active else F(0)
            seconds=w['batch_seconds'] if any_active else 0
        network=tx*F((n['lamports_per_signature']*n['signatures_per_transaction']+n['priority_lamports_per_transaction'])*n['sol_price_micro_usd'],10**9)
        waiting=F(sum(h[k]*p[k] for k in ASSETS)*w['opportunity_bps_per_hour']*seconds,3600*10000)
        if r['network_micro_usd']!=network or r['waiting_micro_usd']!=waiting or r['expected_retry_micro_usd']!=network*F(n['retry_probability_bps'],10000): errors.append('overhead')
        if error!=r['after_error_micro_usd'] or turnover!=r['turnover_micro_usd']: errors.append('metrics')
        if r['recurring_micro_usd']!=sum(r[k] for k in ('venue_cost_micro_usd','price_difference_micro_usd','network_micro_usd','expected_retry_micro_usd','waiting_micro_usd')): errors.append('recurring_total')
        if r['objective_micro_usd']!=r['recurring_micro_usd']+F(error,2000): errors.append('objective')
    if bool(actual_feasible)!=result['feasible']: errors.append('feasibility_claim')
    for k in STOCKS:
        internal=sum(r['internal_raw'][k] for r in result['accounts'])
        route=sum(o['signed_quantity_raw'] for o in result['external_orders'] if o['asset']==k)
        if internal!=0 or route!=sum(r['trades_raw'][k] for r in result['accounts']): errors.append('stock_conservation/'+k)
    for order in result['external_orders']:
        expected_price=F(p[order['asset']]*(10000+s['price_observation']['execution_price_shock_bps'][order['asset']]),10000)
        if order['execution_price_micro_usd_per_raw']!=expected_price: errors.append('execution_price')
        curve=s['cost_model']['external_by_asset'][order['asset']]
        value=abs(order['signed_quantity_raw'])*order['execution_price_micro_usd_per_raw']
        charge=F(value,10000)*(curve['half_spread_bps']+curve['venue_fee_bps'])+F(value*value,10000*curve['depth_micro_usd'])*curve['impact_bps_at_depth']+curve['fixed_order_fee_micro_usd']
        charge=(charge.numerator+charge.denominator-1)//charge.denominator
        if charge!=order['venue_cost_micro_usd'] or sum(order['owner_fee_micro_usd'].values())!=charge: errors.append('venue_charge')
        if sum(order['owner_lots'].values())!=order['signed_quantity_raw']: errors.append('route_lots')
    for key in ('venue_cost_micro_usd','price_difference_micro_usd','network_micro_usd','expected_retry_micro_usd','waiting_micro_usd','preference_micro_usd','recurring_micro_usd','objective_micro_usd','after_error_micro_usd','turnover_micro_usd','transactions_allocated'):
        if result['totals'][key]!=sum(r[key] for r in result['accounts']): errors.append('aggregate/'+key)
    if sum(o['venue_cost_micro_usd'] for o in result['external_orders'])!=result['totals']['venue_cost_micro_usd']: errors.append('venue_total')
    expected_cash_delta=-sum(o['signed_quantity_raw']*o['execution_price_micro_usd_per_raw']+o['venue_cost_micro_usd'] for o in result['external_orders'])
    if sum(r['final_raw']['CASH']-r['initial_raw']['CASH'] for r in result['accounts'])!=expected_cash_delta: errors.append('aggregate_cash_conservation')
    return errors


def ranking(result):
    t=result['totals']
    return (t['objective_micro_usd'],t['after_error_micro_usd'],t['turnover_micro_usd'],tuple(r['final_raw'][k] for r in result['accounts'] for k in STOCKS))


def solve(s, enforce_policy=False, grid_step=1):
    if type(grid_step) is not int or grid_step < 1: raise ValueError('positive integer grid step required')
    reasons=admission_reasons(s)
    if reasons: return {'status':'rejected','reasons':reasons,'methods':{},'grid_candidates_evaluated':0}
    accounts=sorted(s['accounts'],key=lambda a:a['id'])
    joint_count=1
    for a in accounts: joint_count*=len(grid(a,grid_step))
    if joint_count>729: raise ValueError('frozen enumeration cap exceeded')
    a_outputs={}; independent_count=0
    for a in accounts:
        one=copy.deepcopy(s); one['accounts']=[a]
        candidates=[]
        for x in grid(a,grid_step):
            independent_count+=1
            r=evaluate(one,{a['id']:x},'independent',enforce_policy)
            if r['feasible']: candidates.append(r)
        if not candidates: return {'status':'infeasible','reasons':['independent_no_feasible_plan'],'methods':{},'grid_candidates_evaluated':independent_count}
        selected=min(candidates,key=ranking)
        a_outputs[a['id']]={k:selected['accounts'][0]['final_raw'][k] for k in STOCKS}
    A=evaluate(s,a_outputs,'independent',enforce_policy)
    B=evaluate(s,a_outputs,'batch',enforce_policy)
    cooperative=[]
    for xs in product(*(grid(a,grid_step) for a in accounts)):
        r=evaluate(s,{a['id']:x for a,x in zip(accounts,xs)},'batch',enforce_policy)
        if r['feasible']: cooperative.append(r)
    methods={'A':A,'B':B}
    if cooperative: methods['C']=min(cooperative,key=ranking)
    for r in methods.values():
        errors=independent_check(s,r)
        if errors: raise AssertionError('independent ledger check failed: '+str(errors))
    result={'status':'ok' if 'C' in methods else 'infeasible','reasons':[] if 'C' in methods else ['cooperative_no_feasible_plan'],'methods':methods,'grid_candidates_evaluated':independent_count+joint_count,'joint_candidates':joint_count,'feasible_joint_candidates':len(cooperative),'grid_step_raw':grid_step}
    if B['feasible'] and 'C' in methods:
        C=methods['C']
        result['comparison']={'A_minus_B_recurring_micro_usd':A['totals']['recurring_micro_usd']-B['totals']['recurring_micro_usd'],'B_minus_C_recurring_micro_usd':B['totals']['recurring_micro_usd']-C['totals']['recurring_micro_usd'],'B_minus_C_objective_micro_usd':B['totals']['objective_micro_usd']-C['totals']['objective_micro_usd'],'A_minus_C_recurring_micro_usd':A['totals']['recurring_micro_usd']-C['totals']['recurring_micro_usd'],'valid_baselines':True}
    else: result['comparison']={'valid_baselines':False,'reason':'infeasible B or C; no comparative savings claim'}
    return result


def audit_comparison(s, solved):
    """Reject altered mandates, repaired B orders and deliberately weaker A."""
    errors=[]
    if solved['status']!='ok': return errors
    methods=solved['methods']
    for name,r in methods.items(): errors.extend(name+'/'+e for e in independent_check(s,r))
    A,B,C=(methods[k] for k in ('A','B','C'))
    if A['mode']!='independent' or B['mode']!='batch' or C['mode']!='batch': errors.append('baseline_mode')
    if any(a['trades_raw']!=b['trades_raw'] for a,b in zip(A['accounts'],B['accounts'])): errors.append('B_changed_A_orders')
    if not A['feasible'] or not C['feasible']: errors.append('invalid_method')
    for source,row in zip(sorted(s['accounts'],key=lambda a:a['id']),A['accounts']):
        one=copy.deepcopy(s); one['accounts']=[source]
        outputs={source['id']:{k:row['final_raw'][k] for k in STOCKS}}
        chosen=evaluate(one,outputs,'independent',A['policy_enforced'])
        for x in grid(source,solved.get('grid_step_raw',1)):
            alternative=evaluate(one,{source['id']:x},'independent',A['policy_enforced'])
            if alternative['feasible'] and ranking(alternative)<ranking(chosen):
                errors.append('A_not_independently_optimal/'+source['id']); break
    if B['feasible'] and ranking(C)>ranking(B): errors.append('C_worse_than_feasible_B')
    return errors


def encode(x):
    if isinstance(x,F): return {'numerator':x.numerator,'denominator':x.denominator}
    if isinstance(x,dict): return {k:encode(v) for k,v in x.items()}
    if isinstance(x,list): return [encode(v) for v in x]
    return x


def load_training(root):
    data=json.loads((root/'research/economics/scenarios.json').read_text())
    manifest=json.loads((root/'research/economics/split-manifest.json').read_text())
    if sha(data)!=manifest['suite_sha256']: raise ValueError('frozen suite hash mismatch')
    train=set(manifest['train_ids']); holdout=set(manifest['holdout_ids'])
    if train&holdout: raise ValueError('overlapping split')
    selected=[s for s in data['scenarios'] if s['id'] in train]
    if len(selected)!=len(train) or any(s['split']!='train' for s in selected): raise ValueError('train split mismatch')
    if any(sha(s)!=manifest['scenario_sha256'][s['id']] for s in selected): raise ValueError('training fixture mismatch')
    return selected, manifest


def run_training(root):
    training,manifest=load_training(root)
    runs=[]
    for s in training:
        actual=admission_reasons(s)
        if actual!=sorted(s['expected_rejection_reasons']): raise AssertionError('admission mismatch: '+s['id'])
        research=solve(s)
        policy=solve(s,True)
        for output in (research,policy):
            if audit_comparison(s,output): raise AssertionError('comparison audit: '+str(audit_comparison(s,output)))
        witness={a['id']:policy_guard(a,a['reference']['final_raw'],prices(s)) for a in s['accounts']}
        runs.append({'id':s['id'],'category':s['category'],'scenario_sha256':sha(s),'research':research,'t02_policy_subset':policy,'reference_witness_value_guards':witness})
    # Fixed declared sensitivity grid on training opposite-01 only, no tuning or
    # replacement of the frozen suite. All perturbations and losses retained.
    base=next(s for s in training if s['id']=='opposite-01')
    sensitivity=[]
    for label,field,values in [('priority_lamports','priority_lamports_per_transaction',[0,1000,100000,1000000]),('batch_wait_seconds','batch_seconds',[0,30,300,1800]),('price_shock_bps','STOCK_A',[-100,-50,0,50,100])]:
        for value in values:
            s=copy.deepcopy(base)
            if label=='priority_lamports': s['cost_model']['network'][field]=value
            elif label=='batch_wait_seconds': s['cost_model']['waiting'][field]=value
            else: s['price_observation']['execution_price_shock_bps'][field]=value
            sensitivity.append({'parameter':label,'value':value,'input_sha256':sha(s),'result':solve(s,True)})
    scale_sensitivity=[]
    for scale in (1,10,100,1000):
        scenario=copy.deepcopy(base)
        for account in scenario['accounts']:
            for k in ASSETS:
                account['initial_raw'][k]*=scale
                account['final_bounds_raw'][k]['min']*=scale
                account['final_bounds_raw'][k]['max']*=scale
                account['reference']['final_raw'][k]*=scale
            for k in STOCKS: account['target_raw'][k]*=scale
            for k in ('max_stock_error_micro_usd','max_turnover_micro_usd','cost_debit_budget_micro_usd'): account[k]*=scale
            account['reference']['cost_debit_micro_usd']*=scale
        for curve in scenario['cost_model']['external_by_asset'].values(): curve['depth_micro_usd']*=scale
        output=solve(scenario,True,grid_step=scale)
        if audit_comparison(scenario,output): raise AssertionError('scale comparison audit')
        scale_sensitivity.append({'factor':scale,'classification':'post-freeze exploratory, not frozen-suite evidence','grid_step_raw':scale,'liquidity_depth_scales_with_portfolio':True,'input_sha256':sha(scenario),'result':output})
    return {'schema_version':1,'scope':'training only; held-out performance not evaluated','input_freeze_commit':'9614341','suite_sha256':manifest['suite_sha256'],'training_ids':[s['id'] for s in training],'heldout_runs':0,'numeric_policy':'exact rational micro-USD; integer token/cash outputs','policy_guard_status':'T02 staged specification under review; predicate exercised, not deployed proof','runs':runs,'sensitivity':sensitivity,'post_freeze_scale_sensitivity':scale_sensitivity}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-root',type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument('--output',type=Path,default=Path(__file__).with_name('reference-results.json'))
    args=parser.parse_args()
    result=run_training(args.input_root)
    args.output.write_text(json.dumps(encode(result),indent=2)+'\n')
    print(json.dumps({'status':'PASS','training_runs':len(result['runs']),'heldout_runs':0,'sensitivity_runs':len(result['sensitivity']),'exploratory_scale_runs':len(result['post_freeze_scale_sensitivity']),'output':str(args.output)}))

if __name__=='__main__': main()
