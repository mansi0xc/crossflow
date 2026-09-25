"""Accept a portfolio the optimizer has never seen.

The engines were only ever run on the frozen fixture suite, which made the central claim untestable:
a caller could not ask "what would you do with *my* book?". This module turns a bounded, validated
portfolio description into the same scenario structure the engines consume.

What is deliberately *not* caller-supplied is the cost and market convention: those come from the
frozen template, so a user portfolio is priced by the same disclosed model as every committed
result. The defaults that fill the gaps are returned alongside the scenario and printed, so a caller
can see exactly what was assumed on its behalf.
"""
from __future__ import annotations

import copy
from fractions import Fraction

ASSETS = ('STOCK_A', 'STOCK_B', 'CASH')
STOCKS = ('STOCK_A', 'STOCK_B')
MAX_RAW = 10**18
MAX_ACCOUNTS = 3


class PortfolioError(ValueError):
    """A refusal, not a crash: the caller is told what is wrong with the portfolio."""


def _integer(value, name: str, minimum: int = 0, maximum: int = MAX_RAW) -> int:
    if isinstance(value, bool):
        raise PortfolioError(f'{name} must be an integer, not a boolean')
    if isinstance(value, float):
        if not value.is_integer():
            raise PortfolioError(f'{name} must be an integer, not a fraction')
        value = int(value)
    if not isinstance(value, int):
        raise PortfolioError(f'{name} must be an integer')
    if not minimum <= value <= maximum:
        raise PortfolioError(f'{name} is outside the permitted range')
    return value


def _amounts(value, name: str) -> dict:
    if not isinstance(value, dict):
        raise PortfolioError(f'{name} must be an object of asset amounts')
    for key in value:
        if key not in ASSETS:
            raise PortfolioError(f'{name} names an unknown asset {key}')
    return {asset: _integer(value.get(asset, 0), f'{name}.{asset}') for asset in ASSETS}


def scenario_from_portfolio(portfolio: object, template: dict) -> tuple[dict, list[str]]:
    """Build a scenario from a portfolio, using the frozen cost and market convention."""
    if not isinstance(portfolio, dict):
        raise PortfolioError('portfolio must be an object')
    unknown = set(portfolio) - {'label', 'assets', 'accounts'}
    if unknown:
        raise PortfolioError(f'portfolio has unsupported fields: {sorted(unknown)}')

    assets = portfolio.get('assets')
    if not isinstance(assets, list) or len(assets) != len(ASSETS):
        raise PortfolioError('portfolio.assets must list exactly the three assets')
    asset_ids = [a.get('id') if isinstance(a, dict) else None for a in assets]
    if sorted(asset_ids) != sorted(ASSETS) or len(set(asset_ids)) != 3:
        raise PortfolioError('portfolio.assets must be STOCK_A, STOCK_B and CASH, each once')
    prices = {}
    for asset in assets:
        prices[asset['id']] = _integer(asset.get('price_micro_usd_per_raw'),
                                       f'assets[{asset["id"]}].price_micro_usd_per_raw', 1)
        # Decimals only describe how the raw amounts are denominated; the convention is about
        # prices *per raw unit*, so any 0..9 is coherent as long as the prices match.
        _integer(asset.get('decimals', 0), f'assets[{asset["id"]}].decimals', 0, 9)

    accounts = portfolio.get('accounts')
    if not isinstance(accounts, list) or not 2 <= len(accounts) <= MAX_ACCOUNTS:
        raise PortfolioError(f'portfolio.accounts must hold between two and {MAX_ACCOUNTS} accounts')
    seen = set()
    built = []
    defaults: list[str] = []
    for index, account in enumerate(accounts):
        if not isinstance(account, dict):
            raise PortfolioError(f'accounts[{index}] must be an object')
        extra = set(account) - {'id', 'initial_raw', 'target_raw', 'final_bounds_raw', 'constraints'}
        if extra:
            raise PortfolioError(f'accounts[{index}] has unsupported fields: {sorted(extra)}')
        identifier = account.get('id')
        if not isinstance(identifier, str) or not identifier or identifier in seen:
            raise PortfolioError(f'accounts[{index}].id must be a unique non-empty string')
        seen.add(identifier)
        initial = _amounts(account.get('initial_raw'), f'accounts[{index}].initial_raw')
        target = _amounts(account.get('target_raw'), f'accounts[{index}].target_raw')
        if target['CASH'] != 0:
            raise PortfolioError('a target cannot specify cash; cash is the residual of the trades')
        bounds = account.get('final_bounds_raw')
        if bounds is None:
            # Bounds default to the target: the caller asked for exactly this outcome.
            bounds = {asset: {'min': target[asset], 'max': target[asset]} for asset in ASSETS}
            bounds['CASH'] = {'min': 0, 'max': 2 * MAX_RAW}
            defaults.append(f'accounts[{index}].final_bounds_raw defaulted to the target')
        else:
            for asset in ASSETS:
                entry = bounds.get(asset) if isinstance(bounds, dict) else None
                if not isinstance(entry, dict) or 'min' not in entry or 'max' not in entry:
                    raise PortfolioError(f'accounts[{index}].final_bounds_raw.{asset} needs min and max')
                low = _integer(entry['min'], f'bounds.{asset}.min')
                high = _integer(entry['max'], f'bounds.{asset}.max')
                if low > high:
                    raise PortfolioError(f'accounts[{index}].final_bounds_raw.{asset} has min above max')
                if not low <= target[asset] <= high:
                    raise PortfolioError(f'accounts[{index}].target_raw.{asset} is outside its bounds')
                bounds[asset] = {'min': low, 'max': high}
        constraints = account.get('constraints') or {}
        if not isinstance(constraints, dict):
            raise PortfolioError(f'accounts[{index}].constraints must be an object')
        template_account = template['accounts'][min(index, len(template['accounts']) - 1)]
        resolved = {
            'min_error_reduction_bps': _integer(constraints.get('min_error_reduction_bps',
                template_account['min_error_reduction_bps']), 'min_error_reduction_bps', 0, 10_000),
            'max_stock_error_micro_usd': _integer(constraints.get('max_stock_error_micro_usd',
                template_account['max_stock_error_micro_usd']), 'max_stock_error_micro_usd'),
            'max_turnover_micro_usd': _integer(constraints.get('max_turnover_micro_usd',
                template_account['max_turnover_micro_usd']), 'max_turnover_micro_usd'),
            'cost_debit_budget_micro_usd': _integer(constraints.get('cost_debit_budget_micro_usd',
                template_account['cost_debit_budget_micro_usd']), 'cost_debit_budget_micro_usd'),
        }
        for key, value in resolved.items():
            if key not in constraints:
                defaults.append(f'accounts[{index}].{key} defaulted to {value} from the frozen template')
        built.append({'id': identifier, 'initial_raw': initial, 'target_raw': target,
                      'final_bounds_raw': bounds, **resolved, 'reference': 'user_supplied'})

    # Cash must be able to pay for every intended purchase; otherwise the portfolio is incoherent
    # and the engines would only discover it as an infeasible plan.
    for position, account in enumerate(built):
        # Cash is a raw amount and the stock price is in micro-USD per raw unit, so both sides of
        # this comparison are already in the same units.
        spend = sum((account['target_raw'][stock] - account['initial_raw'][stock]) * prices[stock]
                    for stock in STOCKS)
        if spend > 0 and spend > account['initial_raw']['CASH']:
            raise PortfolioError(f'accounts[{position}] targets more stock than its cash can buy')
    total_stock = sum(account['initial_raw'][stock] + account['target_raw'][stock]
                      for account in built for stock in STOCKS)
    if total_stock == 0:
        raise PortfolioError('the portfolio holds and targets no stock at all, so there is nothing to cross')

    scenario = {
        'id': 'user-portfolio',
        'category': 'user_supplied',
        'split': 'holdout',
        'provenance': {
            'kind': 'user_supplied',
            'license': 'n/a',
            'source': str(portfolio.get('label') or 'caller-supplied portfolio'),
            'is_market_evidence': False,
        },
        'assets': [{'id': asset, 'decimals': 6 if asset == 'CASH' else 0,
                    'price_micro_usd_per_raw': prices[asset],
                    'provenance': 'caller_supplied_price_not_market_data'} for asset in ASSETS],
        'accounts': built,
        'cost_model': copy.deepcopy(template['cost_model']),
        'price_observation': copy.deepcopy(template['price_observation']),
        'batch_min_participants': 2,
        'expected_admission': 'accept',
        'expected_rejection_reasons': [],
        'expected_qualitative_case': 'user_supplied',
    }
    defaults.append('the cost model, network fees, waiting cost and oracle convention come from the frozen template, not from the caller')
    defaults.append('prices are the caller\'s declared reference prices, which are not market data')
    return scenario, defaults
