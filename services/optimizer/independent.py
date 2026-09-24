"""Method A — independent per-account execution.

Each owner is optimized alone under its own mandate and its own external orders. This engine is
also the source of the fixed orders that method B is allowed to net, so it must be optimal within
the frozen grid before B or C are computed.
"""
from __future__ import annotations

from .shared import Budget, Proposal, _proposal, admission, grid, ranking, reference, single_account


def plan(scenario: dict, budget: Budget | None = None) -> Proposal:
    budget = budget or Budget()
    reasons = admission(scenario)
    if reasons:
        return _proposal('A', scenario, None, 'rejected', reasons, 0, False)
    candidates = 0
    chosen: dict[str, dict] = {}
    for account in sorted(scenario['accounts'], key=lambda a: a['id']):
        one = single_account(scenario, account)
        best = None
        for final in grid(account, budget.grid_step):
            candidates += 1
            if candidates > budget.max_candidates:
                return _proposal('A', scenario, None, 'budget_exhausted', ['candidate_budget_exhausted'], candidates, True)
            ledger = reference.evaluate(one, {account['id']: final}, 'independent', False)
            if not ledger['feasible']:
                continue
            if best is None or ranking(ledger) < ranking(best):
                best = ledger
        if best is None:
            return _proposal('A', scenario, None, 'infeasible', [f'independent_no_feasible_plan/{account["id"]}'], candidates, False)
        chosen[account['id']] = {k: best['accounts'][0]['final_raw'][k] for k in reference.STOCKS}
    ledger = reference.evaluate(scenario, chosen, 'independent', False)
    status = 'ok' if ledger['feasible'] else 'infeasible'
    return _proposal('A', scenario, ledger, status, [] if ledger['feasible'] else ['independent_infeasible'], candidates, False)


def independent_outputs(scenario: dict, budget: Budget | None = None) -> tuple[dict | None, Proposal]:
    """The fixed orders method B may net. Returns (outputs, proposal)."""
    proposal = plan(scenario, budget)
    if not proposal.feasible:
        return None, proposal
    from .shared import outputs_of
    return outputs_of(proposal.ledger), proposal
