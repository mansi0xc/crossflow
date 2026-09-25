"""T21 evaluation checks.

The point of these tests is that a *worse* result cannot be silently dropped: the committed
report must reproduce exactly, and the validator must fail on a changed split, an omitted
scenario, a missing cost field or an overstated cooperative claim.
"""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services'))

_SPEC = importlib.util.spec_from_file_location('crossflow_evaluate', ROOT / 'scripts' / 'evaluate-economics.py')
evaluate = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(evaluate)

COMMITTED = ROOT / 'docs' / 'evidence' / 'economic-results.json'


class EvaluationReproductionTests(unittest.TestCase):
    def setUp(self):
        self.committed = json.loads(COMMITTED.read_text())

    def test_committed_report_is_valid_and_reproduces_exactly(self):
        self.assertEqual(evaluate.validate(self.committed), [])
        fresh = json.loads(json.dumps(evaluate.encode(evaluate.build('holdout'))))
        self.assertEqual(fresh, self.committed, 'a fresh held-out run differs from the committed report')

    def test_rejected_scenarios_are_preserved_with_their_declared_reasons(self):
        rejected = [row for row in self.committed['scenarios'] if row['methods']['A']['status'] == 'rejected']
        self.assertEqual(sorted(row['id'] for row in rejected), ['confidence-02', 'noise-02'])
        for row in rejected:
            self.assertEqual(row['methods']['A']['reasons'], row['declared_rejections'], row['id'])
            self.assertFalse(row['comparison']['valid_baselines'], row['id'])

    def test_one_negative_netting_outcome_is_retained(self):
        gains = [row['comparison']['netting_gain_micro_usd'] for row in self.committed['scenarios']
                 if row['comparison']['valid_baselines']]
        def as_int(value):
            return value['numerator'] // value['denominator'] if isinstance(value, dict) else value
        self.assertTrue(any(as_int(value) < 0 for value in gains),
                        'the report must keep the scenario where netting costs more than independent execution')

    def test_robustness_is_measured_against_the_points_that_had_a_gain_to_lose(self):
        """A scenario whose baseline cooperative gain is exactly zero has nothing to preserve.

        Counting those as failures confused opportunity coverage with fragility, and an earlier
        version of the sensitivity grid moved both the batch and the independent clock together so it
        never tested coordination delay at all. Both are asserted here.
        """
        summary = self.committed['summary']
        # The gain held at every point where a gain existed to lose.
        self.assertGreater(summary['sensitivity_points_at_risk'], 0)
        self.assertEqual(summary['sensitivity_points_keeping_the_gain'], summary['sensitivity_points_at_risk'])
        self.assertEqual(summary['sensitivity_points_losing_the_gain'], 0)
        self.assertTrue(summary['holds_under_sensitivity'])
        # And the coverage limit is still stated: not every eligible scenario has a gain.
        self.assertLess(summary['cooperative_gain_micro_usd']['positive_scenarios'],
                        summary['cooperative_trading_benefit_eligible_scenarios'])
        self.assertEqual(summary['cooperative_gain_micro_usd']['negative_scenarios'], 0)

    def test_the_delay_sensitivity_varies_only_the_batch(self):
        """The grid must contain the batch's *additional* delay, not a common clock."""
        parameters = {row['parameter'] for row in self.committed['sensitivity']}
        self.assertIn('batch_extra_wait_seconds', parameters)
        self.assertNotIn('batch_wait_seconds', parameters)
        waits = sorted({row['value'] for row in self.committed['sensitivity']
                        if row['parameter'] == 'batch_extra_wait_seconds'})
        self.assertEqual(waits, [0, 60, 300, 3600])


class ValidatorRejectionTests(unittest.TestCase):
    def setUp(self):
        self.report = json.loads(COMMITTED.read_text())

    def test_changed_split_fails(self):
        broken = copy.deepcopy(self.report)
        broken['split'] = 'train'
        self.assertIn('split_coverage', evaluate.validate(broken))

    def test_omitted_scenario_fails(self):
        broken = copy.deepcopy(self.report)
        broken['scenarios'] = broken['scenarios'][:-1]
        self.assertIn('split_coverage', evaluate.validate(broken))

    def test_missing_cost_field_fails(self):
        broken = copy.deepcopy(self.report)
        del broken['scenarios'][0]['methods']['B']['totals']['venue_cost_micro_usd']
        errors = evaluate.validate(broken)
        self.assertTrue(any(error.startswith('missing_cost/') for error in errors), errors)

    def test_overstated_cooperative_claim_fails(self):
        broken = copy.deepcopy(self.report)
        row = next(entry for entry in broken['scenarios'] if entry['comparison']['valid_baselines'])
        row['comparison']['cooperative_trading_benefit_eligible'] = False
        row['comparison']['cooperative_gain_micro_usd'] = 1
        self.assertTrue(any(error.startswith('false_cooperative_gain/') for error in evaluate.validate(broken)))

    def test_mutated_fixture_hash_fails(self):
        broken = copy.deepcopy(self.report)
        broken['scenarios'][0]['scenario_sha256'] = '0' * 64
        self.assertTrue(any(error.startswith('fixture_sha/') for error in evaluate.validate(broken)))

    def test_incomplete_sensitivity_grid_fails(self):
        broken = copy.deepcopy(self.report)
        broken['sensitivity'] = broken['sensitivity'][:-1]
        self.assertIn('sensitivity_coverage', evaluate.validate(broken))


if __name__ == '__main__':
    unittest.main()
