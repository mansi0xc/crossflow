"""Shared, deterministic model surface for the three CrossFlow execution engines.

The frozen economic model itself lives in `research/economics/reference.py` (T03). These engines
deliberately import it rather than reimplementing it, so there is one numeric definition of the
mandate, the cost curves and the ledger check. What T12 adds is an explicit engine boundary:
each engine returns a status, its feasibility residuals, the search budget it consumed and the
seed it used, and refuses to emit an executable plan when it did not converge.
"""
from __future__ import annotations

import copy
import importlib.util
import sys
from dataclasses import dataclass, field
from fractions import Fraction as F
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_REFERENCE = ROOT / 'research' / 'economics' / 'reference.py'


def _load_reference():
    spec = importlib.util.spec_from_file_location('crossflow_reference', _REFERENCE)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise ImportError(f'cannot load the frozen reference model from {_REFERENCE}')
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault('crossflow_reference', module)
    spec.loader.exec_module(module)
    return module


reference = _load_reference()

ASSETS = reference.ASSETS
STOCKS = reference.STOCKS
apportion = reference.apportion
grid = reference.grid
prices = reference.prices
ranking = reference.ranking
sha = reference.sha
admission_reasons = reference.admission_reasons

METHODS = ('A', 'B', 'C')


@dataclass(frozen=True)
class Budget:
    """Deterministic limits. `max_candidates` is an evaluation count, not wall-clock time, so a
    replay on another machine consumes exactly the same budget."""
    max_candidates: int = 8_192
    grid_step: int = 1

    def validate(self) -> None:
        if not isinstance(self.grid_step, int) or self.grid_step < 1:
            raise ValueError('grid_step must be a positive integer')
        if not isinstance(self.max_candidates, int) or self.max_candidates < 1:
            raise ValueError('max_candidates must be a positive integer')


@dataclass
class Proposal:
    method: str
    status: str
    feasible: bool
    reasons: list[str] = field(default_factory=list)
    ledger: dict | None = None
    candidates_evaluated: int = 0
    budget_exhausted: bool = False
    scenario_sha256: str = ''
    ledger_errors: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            'method': self.method,
            'status': self.status,
            'feasible': self.feasible,
            'reasons': list(self.reasons),
            'candidates_evaluated': self.candidates_evaluated,
            'budget_exhausted': self.budget_exhausted,
            'scenario_sha256': self.scenario_sha256,
            'ledger_errors': list(self.ledger_errors),
            'totals': (self.ledger or {}).get('totals'),
        }


def residuals(scenario: dict, ledger: dict) -> dict:
    """Worst-case constraint slack per account, derived from the ledger, not from the engine."""
    worst = {'bounds_raw': None, 'tracking_micro_usd': None, 'progress_integer': None,
             'turnover_micro_usd': None, 'cost_budget_micro_usd': None}
    for row in ledger['accounts']:
        slack = row['slacks']
        for name in ('tracking_micro_usd', 'progress_integer', 'turnover_micro_usd', 'cost_budget_micro_usd'):
            value = slack[name]
            worst[name] = value if worst[name] is None else min(worst[name], value)
        for asset, bounds in slack['bounds'].items():
            value = min(bounds['min'], bounds['max'])
            worst['bounds_raw'] = value if worst['bounds_raw'] is None else min(worst['bounds_raw'], value)
    return worst


def _proposal(method: str, scenario: dict, ledger: dict | None, status: str, reasons: list[str],
              candidates: int, budget_exhausted: bool) -> Proposal:
    errors: list[str] = []
    feasible = bool(ledger and ledger['feasible'])
    if ledger is None:
        feasible = False
    else:
        errors = reference.independent_check(scenario, ledger)
        if errors:
            # A ledger the independent checker rejects is never presented as executable.
            status = 'ledger_mismatch'
            feasible = False
    return Proposal(method=method, status=status, feasible=feasible, reasons=sorted(set(reasons)),
                    ledger=ledger, candidates_evaluated=candidates, budget_exhausted=budget_exhausted,
                    scenario_sha256=sha(scenario), ledger_errors=errors)


def admission(scenario: dict) -> list[str]:
    """Reject an unusable input before any search: the frozen admission reasons plus the
    structural checks a search must never attempt to work around."""
    reasons = list(admission_reasons(scenario))
    if any(account['final_bounds_raw'][k]['min'] > account['final_bounds_raw'][k]['max']
           for account in scenario['accounts'] for k in ASSETS):
        reasons.append('inverted_bounds')
    if any(account['initial_raw'][k] < 0 for account in scenario['accounts'] for k in ASSETS):
        reasons.append('negative_holdings')
    for curve in scenario['cost_model']['external_by_asset'].values():
        if min(curve['half_spread_bps'], curve['venue_fee_bps'], curve['impact_bps_at_depth'],
               curve['depth_micro_usd'], curve['fixed_order_fee_micro_usd']) < 0:
            reasons.append('invalid_cost_curve')
    return sorted(set(reasons))


def assert_clean_scenario(scenario: dict, budget: Budget) -> list[str]:
    budget.validate()
    return admission(scenario)


def outputs_of(ledger: dict) -> dict:
    return {row['id']: {k: row['final_raw'][k] for k in STOCKS} for row in ledger['accounts']}


def single_account(scenario: dict, account: dict) -> dict:
    one = copy.deepcopy(scenario)
    one['accounts'] = [account]
    return one


def account_candidates(scenario: dict, budget: Budget):
    for account in sorted(scenario['accounts'], key=lambda a: a['id']):
        for final in grid(account, budget.grid_step):
            yield account, final


def encode(value):
    return reference.encode(value)


def is_finite(*values) -> bool:
    for value in values:
        if isinstance(value, F):
            if value.denominator == 0:
                return False
        elif isinstance(value, float):
            if value != value or value in (float('inf'), float('-inf')):
                return False
    return True
