"""Custom-portfolio acceptance.

The one thing a caller cannot choose is the denomination convention. Cash is the unit of account:
raw cash units and micro-USD coincide only at exactly one micro-USD per raw cash unit, so any other
cash price is refused explicitly rather than accepted and mis-priced.
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services'))

from optimizer.portfolio import PortfolioError, scenario_from_portfolio  # noqa: E402

TEMPLATE = json.loads((ROOT / 'research' / 'economics' / 'scenarios.json').read_text())['scenarios'][0]


def portfolio(cash_price: int = 1) -> dict:
    return {
        'label': 'unit test portfolio',
        'assets': [
            {'id': 'STOCK_A', 'decimals': 6, 'price_micro_usd_per_raw': 10},
            {'id': 'STOCK_B', 'decimals': 6, 'price_micro_usd_per_raw': 20},
            {'id': 'CASH', 'decimals': 6, 'price_micro_usd_per_raw': cash_price},
        ],
        'accounts': [
            {'id': 'a', 'initial_raw': {'STOCK_A': 100, 'STOCK_B': 0, 'CASH': 1_000_000},
             'target_raw': {'STOCK_A': 50, 'STOCK_B': 0}},
            {'id': 'b', 'initial_raw': {'STOCK_A': 0, 'STOCK_B': 0, 'CASH': 1_000_000},
             'target_raw': {'STOCK_A': 50, 'STOCK_B': 0}},
        ],
    }


class CashDenominationTests(unittest.TestCase):
    def test_unit_cash_denomination_is_accepted(self):
        scenario, defaults = scenario_from_portfolio(portfolio(1), TEMPLATE)
        self.assertEqual({a['id']: a['price_micro_usd_per_raw'] for a in scenario['assets']}['CASH'], 1)
        self.assertTrue(any('cost model' in line for line in defaults))

    def test_two_micro_usd_cash_is_refused_rather_than_mis_priced(self):
        with self.assertRaises(PortfolioError) as caught:
            scenario_from_portfolio(portfolio(2), TEMPLATE)
        self.assertIn('cash denomination', str(caught.exception))

    def test_the_model_also_refuses_a_non_unit_cash_scenario(self):
        # Defence in depth: even a hand-built scenario with a non-unit cash price is refused by the
        # frozen model's admission gate, not silently mis-debited.
        sys.path.insert(0, str(ROOT / 'research' / 'economics'))
        import importlib.util
        spec = importlib.util.spec_from_file_location('reference', ROOT / 'research' / 'economics' / 'reference.py')
        reference = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reference)
        scenario = json.loads(json.dumps(TEMPLATE))
        for asset in scenario['assets']:
            if asset['id'] == 'CASH':
                asset['price_micro_usd_per_raw'] = 2
        self.assertIn('unsupported_cash_denomination', reference.admission_reasons(scenario))


if __name__ == '__main__':
    unittest.main()
