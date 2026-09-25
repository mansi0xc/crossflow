"""T03 monetary/model checks, using hand-calculated expected results."""
import copy
from fractions import Fraction as F
import importlib.util
import json
import os
from pathlib import Path
import unittest

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('reference', HERE/'reference.py')
r=importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
ROOT=Path(os.environ.get('CROSSFLOW_ECONOMICS_INPUT_ROOT',str(HERE.parents[1])))
TRAIN,_=r.load_training(ROOT)
BY_ID={s['id']:s for s in TRAIN}

class ExactReferenceTests(unittest.TestCase):
    def fixture(self,name='opposite-01'): return copy.deepcopy(BY_ID[name])

    def test_whole_training_split_no_heldout(self):
        self.assertEqual(len(TRAIN),12)
        self.assertTrue(all(s['split']=='train' for s in TRAIN))
        self.assertNotIn('opposite-02',BY_ID)

    def test_hand_external_curve(self):
        curve=self.fixture()['cost_model']['external_by_asset']['STOCK_A']
        # $40: spread .04 + venue .02 + impact .0032 + fixed .001.
        self.assertEqual(r.venue_charge(40_000_000,curve),64_200)
        self.assertEqual(r.venue_charge(30_000_000,curve),47_800)
        self.assertEqual(r.venue_charge(10_000_000,curve),16_200)
        self.assertEqual(r.venue_charge(0,curve),0)

    def test_hand_independent_optimum_not_reference_witness(self):
        out=r.solve(self.fixture())['methods']['A']
        self.assertEqual([x['final_raw']['STOCK_A'] for x in out['accounts']],[4,7,0])
        self.assertEqual(out['totals']['venue_cost_micro_usd'],112_000)
        self.assertEqual(out['totals']['recurring_micro_usd'],F(113_818))
        self.assertEqual(out['totals']['objective_micro_usd'],F(123_818))

    def test_hand_cooperative_and_fixed_netting(self):
        solved=r.solve(self.fixture()); b=solved['methods']['B']; c=solved['methods']['C']
        self.assertEqual([x['final_raw']['STOCK_A'] for x in b['accounts']],[4,7,0])
        self.assertEqual([x['final_raw']['STOCK_A'] for x in c['accounts']],[4,6,0])
        self.assertEqual(b['totals']['venue_cost_micro_usd'],16_200)
        self.assertEqual(c['totals']['venue_cost_micro_usd'],0)
        # Two fundings and one shared settlement = three .0009 USD transactions, split across the
        # two participants (the third account trades nothing and is charged nothing); plus 1%
        # expected retries and the wait. The idle account's own funding is disclosed as an operator
        # subsidy, never dropped: 3 * 900 = 2700 network, 1% = 27 retry, 1750 wait.
        self.assertEqual(c['totals']['network_micro_usd'],2700)
        self.assertEqual(c['totals']['expected_retry_micro_usd'],27)
        self.assertEqual(c['totals']['waiting_micro_usd'],1750)
        self.assertEqual(c['totals']['recurring_micro_usd'],4477)
        self.assertEqual(c['totals']['operator_subsidy_micro_usd'],900)
        self.assertEqual(c['totals']['funded_lifecycle_transactions'],4)
        self.assertEqual(solved['comparison']['incremental_cooperative_trading_savings_micro_usd'],16_200)
        self.assertEqual(solved['comparison']['B_minus_C_raw_objective_difference_micro_usd'],21_200)

    def test_no_trade_cannot_fake_required_progress(self):
        s=self.fixture(); outputs={a['id']:{k:a['initial_raw'][k] for k in r.STOCKS} for a in s['accounts']}
        out=r.evaluate(s,outputs,'batch')
        self.assertFalse(out['feasible'])
        self.assertIn('required_progress',out['accounts'][0]['failures'])

    def test_zero_portfolio_noop_has_no_fake_overhead(self):
        out=r.solve(self.fixture('zero-01'))
        for x in out['methods'].values():
            self.assertTrue(x['noop']); self.assertEqual(x['totals']['recurring_micro_usd'],0)
            self.assertEqual(x['totals']['upfront_recoverable_rent_lamports'],0)

    def test_skipped_execution_is_not_cooperative_trading_savings(self):
        # Exact independent-review reproduction, mutated TRAIN copy only.
        s=self.fixture()
        s['accounts'][0]['final_bounds_raw']['STOCK_A']['min']=0
        s['accounts'][1]['final_bounds_raw']['STOCK_A']['max']=10
        for account in s['accounts']:
            account['min_error_reduction_bps']=0
            account['max_stock_error_micro_usd']=100_000_000
        for curve in s['cost_model']['external_by_asset'].values():
            for field in ('half_spread_bps','venue_fee_bps','impact_bps_at_depth'): curve[field]=0
        s['cost_model']['waiting']['batch_seconds']=100_000
        output=r.solve(s)
        self.assertFalse(output['methods']['B']['noop'])
        self.assertTrue(output['methods']['C']['noop'])
        comparison=output['comparison']
        # The raw difference is defined as the full lifecycle cost difference (owner-borne cost plus
        # any operator subsidy), so assert the definition rather than a brittle constant.
        def _full(m):
            t=output['methods'][m]['totals']
            return t['recurring_micro_usd']+t.get('operator_subsidy_micro_usd',0)
        self.assertEqual(comparison['B_minus_C_raw_recurring_difference_micro_usd'],_full('B')-_full('C'))
        self.assertGreater(comparison['B_minus_C_raw_objective_difference_micro_usd'],0)
        self.assertEqual(comparison['execution_attribution'],'skipped_execution_no_cooperative_trading')
        self.assertEqual(comparison['incremental_cooperative_trading_savings_micro_usd'],0)
        self.assertFalse(comparison['cooperative_trading_benefit_eligible'])
        self.assertFalse(comparison['G0_incremental_cost_criterion_pass'])
        self.assertEqual(r.audit_comparison(s,output),[])
        comparison['incremental_cooperative_trading_savings_micro_usd']=comparison['B_minus_C_raw_recurring_difference_micro_usd']
        self.assertIn('false_cooperative_attribution',r.audit_comparison(s,output))

    def test_independent_infeasibility_even_without_admission_shortcut(self):
        s=self.fixture(); s['accounts'][0]['final_bounds_raw']['CASH']={'min':2000*r.M,'max':2001*r.M}
        out=r.solve(s)
        self.assertEqual(out['status'],'infeasible')
        self.assertEqual(out['reasons'],['independent_no_feasible_plan'])

    def test_zero_turnover_required_progress_rejected(self):
        out=r.solve(self.fixture('infeasible-01'))
        self.assertEqual(out['reasons'],['infeasible_mandate'])
        self.assertEqual(out['grid_candidates_evaluated'],0)

    def test_stale_and_single_rejected(self):
        self.assertEqual(r.solve(self.fixture('stale-01'))['reasons'],['stale_price'])
        self.assertEqual(r.solve(self.fixture('single-01'))['reasons'],['insufficient_participation'])

    def test_no_overlap_control_batch_loses(self):
        out=r.solve(self.fixture('no-overlap-01'))
        self.assertEqual(out['comparison']['incremental_cooperative_trading_savings_micro_usd'],0)
        self.assertLess(out['comparison']['A_minus_C_recurring_micro_usd'],0)

    def test_tight_bands_no_adjustment_advantage(self):
        self.assertEqual(r.solve(self.fixture('tight-01'))['comparison']['incremental_cooperative_trading_savings_micro_usd'],0)

    def test_looser_mandate_rejected_by_original_claim_audit(self):
        original=self.fixture(); weaker=copy.deepcopy(original)
        weaker['accounts'][0]['final_bounds_raw']['STOCK_A']['min']=0
        weaker['accounts'][0]['min_error_reduction_bps']=0
        output=r.solve(weaker)
        self.assertTrue(any('changed_mandate' in x for x in r.audit_comparison(original,output)))

    def test_weakened_independent_baseline_detected(self):
        s=self.fixture(); output=r.solve(s)
        target={a['id']:dict(a['target_raw']) for a in s['accounts']}
        output['methods']['A']=r.evaluate(s,target,'independent')
        output['methods']['B']=r.evaluate(s,target,'batch')
        self.assertTrue(any('A_not_independently_optimal' in x for x in r.audit_comparison(s,output)))

    def test_B_cannot_reoptimize_A_orders(self):
        s=self.fixture(); output=r.solve(s)
        output['methods']['B']=copy.deepcopy(output['methods']['C'])
        self.assertIn('B_changed_A_orders',r.audit_comparison(s,output))

    def test_B_must_recheck_post_fee_cash(self):
        s=self.fixture(); standard=r.solve(s)
        a=next(x for x in s['accounts'] if x['id']=='b')
        Arow=next(x for x in standard['methods']['A']['accounts'] if x['id']=='b')
        a['final_bounds_raw']['CASH']['max']=Arow['final_raw']['CASH']
        outputs={x['id']:{k:x['final_raw'][k] for k in r.STOCKS} for x in standard['methods']['A']['accounts']}
        self.assertTrue(r.evaluate(s,outputs,'independent')['feasible'])
        self.assertFalse(r.evaluate(s,outputs,'batch')['feasible'])

    def test_integer_allocation_sum_and_tie(self):
        self.assertEqual(r.apportion(1,{'b':1,'a':1}),{'b':0,'a':1})
        for total in range(12):
            for weights in ({'a':3,'b':2,'c':0},{'a':1,'b':1,'c':1}):
                self.assertEqual(sum(r.apportion(total,weights).values()),total)

    def test_cash_tampering_detected_independently(self):
        s=self.fixture(); out=r.solve(s)['methods']['C']; out['accounts'][0]['final_raw']['CASH']+=1
        self.assertIn('cash_conservation/a',r.independent_check(s,out))

    def test_total_and_overhead_tampering_detected(self):
        s=self.fixture(); out=r.solve(s)['methods']['C']; out['totals']['recurring_micro_usd']=0
        self.assertIn('aggregate/recurring_micro_usd',r.independent_check(s,out))
        out=r.solve(s)['methods']['C']; out['accounts'][0]['waiting_micro_usd']=0
        self.assertIn('overhead',r.independent_check(s,out))

    def test_cost_budget_is_post_route_real_cost(self):
        s=self.fixture(); s['accounts'][0]['cost_debit_budget_micro_usd']=0
        outputs={a['id']:dict(a['target_raw']) for a in s['accounts']}
        out=r.evaluate(s,outputs,'independent')
        self.assertIn('cost_budget',out['accounts'][0]['failures'])

    def test_t02_guard_reference_witness_vs_actual_output(self):
        s=self.fixture('tiny-01')
        self.assertFalse(r.policy_guard(s['accounts'][0],s['accounts'][0]['reference']['final_raw'],r.prices(s))['passes'])
        out=r.solve(s,True)
        self.assertTrue(all(row['value_guard']['passes'] for method in out['methods'].values() for row in method['accounts']))

    def test_value_guard_exact_boundary(self):
        a={'initial_raw':{'STOCK_A':0,'STOCK_B':0,'CASH':1_000_000}}
        p={'STOCK_A':10_000_000,'STOCK_B':20_000_000,'CASH':1}
        x={'STOCK_A':0,'STOCK_B':0,'CASH':980_000}
        self.assertTrue(r.policy_guard(a,x,p)['passes']); x['CASH']-=1
        self.assertFalse(r.policy_guard(a,x,p)['passes'])

    def test_price_shock_shared_by_all_methods(self):
        s=self.fixture('noise-01'); out=r.solve(s)
        for method in out['methods'].values():
            for o in method['external_orders']:
                self.assertEqual(o['execution_price_micro_usd_per_raw'],10_075_000 if o['asset']=='STOCK_A' else 19_900_000)
            self.assertEqual(r.independent_check(s,method),[])

    def test_modest_noise_erases_incremental_gain(self):
        for shock in (-50,50):
            s=self.fixture(); s['price_observation']['execution_price_shock_bps']['STOCK_A']=shock
            self.assertEqual(r.solve(s,True)['comparison']['incremental_cooperative_trading_savings_micro_usd'],0)

    def test_high_network_fees_can_make_batch_lose(self):
        s=self.fixture(); s['cost_model']['network']['priority_lamports_per_transaction']=1_000_000
        self.assertLess(r.solve(s,True)['comparison']['A_minus_C_recurring_micro_usd'],0)

    def test_long_wait_can_make_batch_lose(self):
        # A one-hour batch delay is enough for independent execution to beat cooperative execution
        # on full lifecycle cost, even after the idle-account subsidy is counted in.
        s=self.fixture(); s['cost_model']['waiting']['batch_seconds']=3600
        self.assertLess(r.solve(s,True)['comparison']['A_minus_C_recurring_micro_usd'],0)

    def test_lifecycle_cost_is_fully_allocated_for_two_active_owners(self):
        """Two active owners among three accounts must account for every lifecycle transaction.

        Before this fix the shared settlement was divided across all three accounts but charged to
        the two active ones, so a third of the settlement fee disappeared. The per-owner network
        allocations plus the disclosed operator subsidy must now equal the funded lifecycle exactly.
        """
        s=self.fixture('opposite-01')
        c=r.solve(s)['methods']['C']
        active=[row for row in c['accounts'] if any(row['trades_raw'].values())]
        self.assertEqual(len(active),2)
        self.assertEqual(len(c['accounts']),3)
        funded_transactions=len(c['accounts'])*(s['cost_model']['network']['batch_funding_transactions_per_owner']+s['cost_model']['network']['batch_cleanup_transactions_per_owner'])+s['cost_model']['network']['batch_settlement_transactions']
        self.assertEqual(c['totals']['funded_lifecycle_transactions'],funded_transactions)
        owner_network=sum(row['network_micro_usd'] for row in c['accounts'])
        # Nothing disappears: owner shares plus the operator subsidy reconcile to the funded total.
        self.assertEqual(owner_network+c['totals']['operator_subsidy_micro_usd'],c['totals']['funded_lifecycle_network_micro_usd'])
        # The idle third owner bears no cost at all — it is not the one paying for its own inclusion.
        idle=[row for row in c['accounts'] if not any(row['trades_raw'].values())]
        for row in idle:
            self.assertEqual(row['recurring_micro_usd'],0)
            self.assertEqual(row['network_micro_usd'],0)
        self.assertEqual(r.independent_check(s,c),[])

    def test_route_price_tampering_detected(self):
        s=self.fixture(); out=r.solve(s)['methods']['A']
        out['external_orders'][0]['execution_price_micro_usd_per_raw']+=1
        self.assertIn('execution_price',r.independent_check(s,out))

    def test_exploratory_scales_are_separate_and_grid_declared(self):
        output=r.run_training(ROOT)
        self.assertEqual(output['heldout_runs'],0)
        self.assertEqual(len(output['runs']),12)
        self.assertEqual(len(output['post_freeze_scale_sensitivity']),4)
        ten=output['post_freeze_scale_sensitivity'][1]
        self.assertEqual(ten['factor'],10)
        self.assertEqual(ten['result']['grid_step_raw'],10)
        self.assertEqual(ten['result']['comparison']['incremental_cooperative_trading_savings_micro_usd'],153000)

    def test_frozen_inputs_not_mutated(self):
        s=self.fixture(); before=r.sha(s); r.solve(s); self.assertEqual(before,r.sha(s))

    def test_all_training_ledgers_and_policy_subsets(self):
        for s in TRAIN:
            for policy in (False,True):
                output=r.solve(s,policy)
                for result in output['methods'].values(): self.assertEqual(r.independent_check(s,result),[])
                self.assertEqual(r.audit_comparison(s,output),[])
                self.assertLessEqual(output.get('joint_candidates',0),729)

if __name__=='__main__': unittest.main()
