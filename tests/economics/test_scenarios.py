"""Adversarial acceptance checks for the frozen T01 inputs; no solver code."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('scenario_check', ROOT/'scripts/check-scenarios.py')
check = importlib.util.module_from_spec(spec); spec.loader.exec_module(check)

class ScenarioChecks(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT/'research/economics/scenarios.json').read_text())
        self.manifest = json.loads((ROOT/'research/economics/split-manifest.json').read_text())

    def assert_bad(self, phrase):
        with self.assertRaisesRegex(check.ValidationError, phrase): check.validate(self.data, self.manifest)

    def test_frozen_suite(self):
        self.assertEqual(check.validate(self.data, self.manifest)['scenarios'], 20)

    def test_overlapping_splits(self):
        self.manifest['holdout_ids'].append(self.manifest['train_ids'][0]); self.assert_bad('overlapping')

    def test_missing_cost(self):
        del self.data['scenarios'][0]['cost_model']['external_by_asset']['STOCK_A']['venue_fee_bps']; self.assert_bad('missing keys')

    def test_impossible_range(self):
        self.data['scenarios'][0]['accounts'][0]['final_bounds_raw']['STOCK_A']['min']=100; self.assert_bad('impossible target range')

    def test_unlabelled_synthetic(self):
        self.data['scenarios'][0]['provenance']['kind']='observed'; self.assert_bad('synthetic provenance')

    def test_zero_trade_cannot_meet_progress(self):
        a = self.data['scenarios'][0]['accounts'][0]
        a['reference']['final_raw']=copy.deepcopy(a['initial_raw']); a['reference']['final_raw']['CASH']-=a['reference']['cost_debit_micro_usd']
        self.assertIn('required_progress', check.reference_failures(a, {'STOCK_A':10000000,'STOCK_B':20000000,'CASH':1}))
        self.assert_bad('unexpected reference failures')

    def test_zero_holdings_valid_noop_is_separate(self):
        s = next(x for x in self.data['scenarios'] if x['id']=='zero-01')
        check.validate_scenario(s)
        self.assertTrue(all(a['initial_raw']==a['reference']['final_raw'] for a in s['accounts']))
        self.assertEqual(s['expected_admission'], 'accept')

    def test_infeasible_rejection_not_silent_success(self):
        s = next(x for x in self.data['scenarios'] if x['id']=='infeasible-01')
        s['expected_admission']='accept'; self.assert_bad('admission expectation')

    def test_reference_reserve_understatement(self):
        self.data['scenarios'][0]['accounts'][0]['reference']['cost_debit_micro_usd']-=1; self.assert_bad('full debit reserve')

    def test_cash_fee_conservation(self):
        self.data['scenarios'][0]['accounts'][0]['reference']['final_raw']['CASH']+=1; self.assert_bad('cash_conservation')

    def test_hash_tampering(self):
        self.data['scenarios'][0]['expected_qualitative_case']+=' changed'; self.assert_bad('suite hash')

    def test_manifest_hash_tampering(self):
        self.manifest['scenario_sha256']['opposite-01']='0'*64; self.assert_bad('scenario hash')

    def test_float_amount(self):
        self.data['scenarios'][0]['accounts'][0]['initial_raw']['CASH']=1.0; self.assert_bad('floating')

    def test_bool_amount(self):
        self.data['scenarios'][0]['accounts'][0]['initial_raw']['CASH']=True; self.assert_bad('integer required')

    def test_price_guard_mutation(self):
        self.data['scenarios'][0]['price_observation']['confidence_bps']=101; self.assert_bad('rejection reasons')

    def test_zero_depth(self):
        self.data['scenarios'][0]['cost_model']['external_by_asset']['STOCK_A']['depth_micro_usd']=0; self.assert_bad('below minimum')

    def test_missing_split_case(self):
        self.manifest['holdout_ids'].pop(); self.assert_bad('partition')

    def test_duplicate_scenario(self):
        self.data['scenarios'].append(copy.deepcopy(self.data['scenarios'][0])); self.assert_bad('duplicate scenario')

    def test_duplicate_account(self):
        self.data['scenarios'][0]['accounts'][1]['id']='a'; self.assert_bad('duplicate account')

    def test_rent_not_recurring(self):
        self.data['scenarios'][0]['cost_model']['recoverable_rent']['treatment']='recurring_fee'; self.assert_bad('rent disclosure')

if __name__=='__main__': unittest.main()
