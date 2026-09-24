"""Method B — fixed-order netting.

The strongest simple competitor: take method A's independently optimal orders exactly as they
are and cross the compatible ones before routing the residual. This engine may not change an
order, relax a bound or reach a different per-account outcome than A; it may only net.
"""
from __future__ import annotations

from . import independent
from .shared import Budget, Proposal, _proposal, admission, outputs_of, reference


def plan(scenario: dict, budget: Budget | None = None) -> Proposal:
    budget = budget or Budget()
    reasons = admission(scenario)
    if reasons:
        return _proposal('B', scenario, None, 'rejected', reasons, 0, False)
    fixed, base = independent.independent_outputs(scenario, budget)
    if fixed is None:
        return _proposal('B', scenario, None, 'no_fixed_orders',
                         ['independent_engine_did_not_produce_orders'] + list(base.reasons),
                         base.candidates_evaluated, base.budget_exhausted)
    ledger = reference.evaluate(scenario, fixed, 'batch', False)
    # Netting may not silently become a different proposal: the per-account stock outcomes that B
    # prices must still be exactly A's independently chosen orders.
    # Cash differs between the two modes because the shared network/waiting overhead is
    # allocated differently; the stock orders and stock outcomes must be identical.
    for row_a, row_b in zip(base.ledger['accounts'], ledger['accounts']):
        if row_a['trades_raw'] != row_b['trades_raw'] or any(
                row_a['final_raw'][k] != row_b['final_raw'][k] for k in reference.STOCKS):
            return _proposal('B', scenario, None, 'baseline_modified', ['B_changed_A_orders'],
                             base.candidates_evaluated, False)
    status = 'ok' if ledger['feasible'] else 'infeasible'
    return _proposal('B', scenario, ledger, status, [] if ledger['feasible'] else ['netting_infeasible'],
                     base.candidates_evaluated, base.budget_exhausted)


def netted_outputs(scenario: dict, budget: Budget | None = None) -> tuple[dict | None, Proposal]:
    proposal = plan(scenario, budget)
    if not proposal.feasible:
        return None, proposal
    return outputs_of(proposal.ledger), proposal
