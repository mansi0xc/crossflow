"""T12 engine checks: analytic cases, deterministic replay, and fail-closed behaviour.

These tests use the frozen training fixtures only. They assert that the three engines agree with
the independent ledger checker, that B may not rewrite A's orders, that C is never worse than a
feasible B, and that an unusable or exhausted input produces no executable plan.
"""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services'))

from optimizer import cooperative, fixed_netting, independent  # noqa: E402
from optimizer.shared import Budget, reference, residuals, sha  # noqa: E402


def _load_fixtures():
    data = json.loads((ROOT / 'research' / 'economics' / 'scenarios.json').read_text())
    manifest = json.loads((ROOT / 'research' / 'economics' / 'split-manifest.json').read_text())
    if sha(data) != manifest['suite_sha256']:
        raise AssertionError('frozen suite hash mismatch')
    by_id = {scenario['id']: scenario for scenario in data['scenarios']}
    return by_id, manifest


FIXTURES, MANIFEST = _load_fixtures()
SMALL = Budget(max_candidates=4_096, grid_step=4)
REPLAY = Budget(max_candidates=4_096, grid_step=4)


class AdmissionTests(unittest.TestCase):
    def test_every_frozen_scenario_reports_its_declared_admission_result(self):
        for scenario in FIXTURES.values():
            self.assertEqual(independent.admission(scenario), sorted(scenario['expected_rejection_reasons']),
                             scenario['id'])

    def test_rejected_input_never_produces_a_plan(self):
        rejected = next(s for s in FIXTURES.values() if s['expected_rejection_reasons'])
        for engine in (independent, fixed_netting, cooperative):
            proposal = engine.plan(rejected, SMALL)
            self.assertFalse(proposal.feasible, engine.__name__)
            self.assertIsNone(proposal.ledger, engine.__name__)
            self.assertEqual(proposal.status, 'rejected', engine.__name__)
            self.assertTrue(proposal.reasons, engine.__name__)


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admissible = sorted((s for s in FIXTURES.values() if not s['expected_rejection_reasons']),
                                key=lambda s: s['id'])

    def test_b_never_rewrites_a_and_c_is_never_worse_than_b(self):
        checked = 0
        for scenario in self.admissible:
            a = independent.plan(scenario, SMALL)
            b = fixed_netting.plan(scenario, SMALL)
            c = cooperative.plan(scenario, SMALL)
            if not a.feasible:
                self.assertEqual(b.status, 'no_fixed_orders', scenario['id'])
                self.assertEqual(c.status, 'no_baseline', scenario['id'])
                continue
            checked += 1
            self.assertEqual(b.status, 'ok', scenario['id'])
            for row_a, row_b in zip(a.ledger['accounts'], b.ledger['accounts']):
                self.assertEqual(row_a['trades_raw'], row_b['trades_raw'], scenario['id'])
                # Netting may not change the stock outcome A chose; only the shared overhead
                # allocation, and therefore cash, differs between the two modes.
                for asset in reference.STOCKS:
                    self.assertEqual(row_a['final_raw'][asset], row_b['final_raw'][asset], scenario['id'])
            self.assertIn(c.status, ('ok', 'ok_bounded'), scenario['id'])
            self.assertLessEqual(reference.ranking(c.ledger), reference.ranking(b.ledger), scenario['id'])
        self.assertGreater(checked, 0, 'no admissible frozen scenario exercised the engines')

    def test_ledgers_pass_the_independent_checker_and_report_their_residuals(self):
        for scenario in self.admissible:
            ledger = independent.plan(scenario, SMALL).ledger
            if ledger is None:
                continue
            self.assertEqual(reference.independent_check(scenario, ledger), [], scenario['id'])
            slack = residuals(scenario, ledger)
            for name, value in slack.items():
                self.assertIsNotNone(value, f'{scenario["id"]}:{name}')
                self.assertGreaterEqual(value, 0, f'{scenario["id"]}:{name}')

    def test_replay_is_deterministic_for_a_seeded_budget(self):
        scenario = next(s for s in self.admissible if fixed_netting.plan(s, REPLAY).feasible)
        first = cooperative.compare(scenario, REPLAY)
        second = cooperative.compare(scenario, REPLAY)
        self.assertEqual(first['scenario_sha256'], second['scenario_sha256'])
        self.assertEqual(first['comparison'], second['comparison'])
        self.assertEqual({k: v['totals'] for k, v in first['proposals'].items()},
                         {k: v['totals'] for k, v in second['proposals'].items()})

    def test_comparison_keeps_netting_and_cooperative_attribution_separate(self):
        for scenario in self.admissible:
            report = cooperative.compare(scenario, SMALL)
            comparison = report['comparison']
            if not comparison['valid_baselines']:
                self.assertIsNone(comparison['netting_gain_micro_usd'])
                self.assertIsNone(comparison['cooperative_gain_micro_usd'])
                continue
            if not comparison['cooperative_trading_benefit_eligible']:
                self.assertEqual(comparison['cooperative_gain_micro_usd'], 0)
                self.assertIn('no-op', comparison['attribution'])
            else:
                self.assertEqual(comparison['cooperative_gain_micro_usd'],
                                 comparison['cooperative_raw_difference_micro_usd'])

    def test_budget_exhaustion_fails_closed_rather_than_claiming_optimality(self):
        scenario = next(s for s in self.admissible if fixed_netting.plan(s, REPLAY).feasible)
        tiny = Budget(max_candidates=1, grid_step=1)
        proposal = cooperative.plan(scenario, tiny)
        self.assertTrue(proposal.budget_exhausted or proposal.feasible)
        if proposal.feasible:
            self.assertIn(proposal.status, ('ok', 'ok_bounded'))
            self.assertEqual(reference.independent_check(scenario, proposal.ledger), [])
        starved = independent.plan(scenario, Budget(max_candidates=1, grid_step=1))
        self.assertIn(starved.status, ('budget_exhausted', 'ok'))
        if starved.status == 'budget_exhausted':
            self.assertIsNone(starved.ledger)
            self.assertFalse(starved.feasible)

    def test_search_does_not_materialise_a_huge_bound_space(self):
        """An ordinary raw-unit bound space can be enormous; the search must stay bounded.

        A subprocess timeout limits duration but not memory, so the joint space is counted and
        enumerated lazily. With a one-candidate budget the search must terminate without ever
        building the product.
        """
        scenario = copy.deepcopy(next(iter(self.admissible)))
        wide = 10 ** 9
        for account in scenario['accounts']:
            for asset in reference.STOCKS:
                account['final_bounds_raw'][asset]['min'] = 0
                account['final_bounds_raw'][asset]['max'] = wide
        budget = Budget(max_candidates=1, grid_step=1)
        accounts, combinations, total, _ = cooperative._joint_candidates(scenario, budget, None)
        expected = 1
        for account in accounts:
            expected *= reference.grid_count(account, budget.grid_step)
        self.assertEqual(total, expected)
        self.assertGreater(total, 10 ** 18)
        # The enumeration is lazy: a bounded prefix never materialises the space.
        prefix = [next(combinations) for _ in range(5)]
        self.assertEqual(len(prefix), 5)
        # And a one-candidate search over that space terminates, failing closed.
        proposal = cooperative.plan(scenario, budget)
        self.assertTrue(proposal.budget_exhausted or not proposal.feasible)

    def test_invalid_budgets_and_cost_curves_are_refused(self):
        scenario = copy.deepcopy(next(iter(self.admissible)))
        for bad in (Budget(max_candidates=0), Budget(grid_step=0), Budget(grid_step=-2)):
            with self.assertRaises(ValueError):
                bad.validate()
        broken = copy.deepcopy(scenario)
        for curve in broken['cost_model']['external_by_asset'].values():
            curve['half_spread_bps'] = -1
        proposal = independent.plan(broken, SMALL)
        self.assertFalse(proposal.feasible)
        self.assertIn('invalid_cost_curve', proposal.reasons)
        inverted = copy.deepcopy(scenario)
        for account in inverted['accounts']:
            account['final_bounds_raw']['STOCK_A']['min'] = account['final_bounds_raw']['STOCK_A']['max'] + 1
        proposal = independent.plan(inverted, SMALL)
        self.assertFalse(proposal.feasible)
        self.assertIn('inverted_bounds', proposal.reasons)


if __name__ == '__main__':
    unittest.main()
