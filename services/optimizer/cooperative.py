"""Method C — cooperative joint adjustment.

All accounts are chosen together inside the same approved feasible region. The engine may change
each owner's trades, but only to another point that owner's own mandate already admits, and it
never emits a plan whose ledger the independent checker rejects.

Fail-closed rules:
- the search is a deterministic bounded enumeration seeded with method A's outcome, so the result
  is never worse than a feasible B for the same input and never depends on machine speed;
- `budget_exhausted` is reported whenever the joint space was not fully explored, and the status
  says `ok_bounded` rather than claiming exhaustive optimality;
- if nothing feasible is found inside the budget the engine returns no ledger at all.
"""
from __future__ import annotations

from . import fixed_netting, independent
from .shared import Budget, Proposal, _proposal, admission, full_cost, grid_count, grid_iter, lazy_product, per_owner_verdict, ranking, reference


def _seed_point(account: dict, seed_outputs: dict, step: int):
    """The seed output as a grid point, or None when it is not on the bounded stepped grid."""
    point = {k: seed_outputs[account['id']][k] for k in reference.STOCKS}
    for k in reference.STOCKS:
        low = account['final_bounds_raw'][k]['min']
        if not (low <= point[k] <= account['final_bounds_raw'][k]['max']) or (point[k] - low) % step:
            return None
    return point


def _joint_candidates(scenario: dict, budget: Budget, seed_outputs: dict | None):
    accounts = sorted(scenario['accounts'], key=lambda a: a['id'])
    # Cardinality is computed, never enumerated. An ordinary raw-unit bound space can be enormous,
    # and a subprocess timeout bounds duration but not memory, so the product below is lazy and the
    # candidate budget is what stops it.
    total = 1
    for account in accounts:
        total *= grid_count(account, budget.grid_step)
    seeded = None
    if seed_outputs is not None:
        points = [_seed_point(account, seed_outputs, budget.grid_step) for account in accounts]
        if all(point is not None for point in points):
            seeded = tuple(points)
    combinations = lazy_product(*(grid_iter(account, budget.grid_step) for account in accounts))
    return accounts, combinations, total, seeded


def plan(scenario: dict, budget: Budget | None = None) -> Proposal:
    budget = budget or Budget()
    reasons = admission(scenario)
    if reasons:
        return _proposal('C', scenario, None, 'rejected', reasons, 0, False)
    fixed, base = fixed_netting.netted_outputs(scenario, budget)
    if fixed is None:
        return _proposal('C', scenario, None, 'no_baseline',
                         ['netting_engine_did_not_produce_orders'] + list(base.reasons),
                         base.candidates_evaluated, base.budget_exhausted)
    accounts, combinations, total, seeded = _joint_candidates(scenario, budget, fixed)
    best = None
    evaluated = 0
    exhausted = False
    if seeded is not None:
        # Consider the netting baseline first, so it is always inside the candidate budget.
        seeded_ledger = reference.evaluate(scenario, {account['id']: point for account, point in zip(accounts, seeded)}, 'batch', False)
        evaluated += 1
        if seeded_ledger['feasible']:
            best = seeded_ledger
    for combination in combinations:
        if seeded is not None and tuple(combination) == seeded:
            continue
        if evaluated >= budget.max_candidates:
            exhausted = True
            break
        outputs = {account['id']: point for account, point in zip(accounts, combination)}
        ledger = reference.evaluate(scenario, outputs, 'batch', False)
        evaluated += 1
        if not ledger['feasible']:
            continue
        if best is None or ranking(ledger) < ranking(best):
            best = ledger
    if best is None:
        status = 'budget_exhausted' if exhausted else 'infeasible'
        return _proposal('C', scenario, None, status, ['cooperative_no_feasible_plan_within_budget' if exhausted
                                                       else 'cooperative_no_feasible_plan'],
                         base.candidates_evaluated + evaluated, exhausted)
    if base.feasible and ranking(best) > ranking(base.ledger):
        # The seeded enumeration must never return something worse than the netting baseline.
        best = base.ledger
    status = 'ok_bounded' if exhausted else 'ok'
    return _proposal('C', scenario, best, status, [], base.candidates_evaluated + evaluated, exhausted)


def compare(scenario: dict, budget: Budget | None = None) -> dict:
    """A, B and C under one budget, with the incremental cooperative attribution kept separate
    from the netting gain. A no-op baseline is labelled rather than counted as a saving."""
    budget = budget or Budget()
    a = independent.plan(scenario, budget)
    b = fixed_netting.plan(scenario, budget)
    c = plan(scenario, budget)
    summary = {'A': a, 'B': b, 'C': c}
    if not (a.feasible and b.feasible and c.feasible):
        return {
            'scenario_sha256': a.scenario_sha256,
            'proposals': {name: proposal.to_json() for name, proposal in summary.items()},
            'comparison': {'valid_baselines': False,
                           'reason': 'A, B and C must all be feasible before any savings claim',
                           'netting_gain_micro_usd': None, 'cooperative_gain_micro_usd': None},
        }
    # The individual guarantee is computed before any aggregate claim is made, so a saving can never
    # be reported without the per-owner verdict that accompanies it.
    verdict = per_owner_verdict(a.ledger, c.ledger)
    netting_verdict = per_owner_verdict(a.ledger, b.ledger)

    # The decision, not just the comparison. Crossing is offered only when it leaves nobody worse
    # off than executing independently; otherwise the engine falls back, and says why. An aggregate
    # saving is never sufficient.
    def objective(proposal):
        # Full lifecycle cost: an operator subsidy is real cost and must not vanish from the
        # comparison merely because an owner was not charged it.
        return full_cost(proposal.ledger) + proposal.ledger['totals']['preference_micro_usd'] if proposal.ledger else None

    declined: dict[str, str] = {}
    recommendation = 'A'
    reason = 'executing independently is the only method that cannot leave an owner worse off'
    if c.feasible and verdict['no_worse_than_independent']:
        if b.feasible and objective(b) is not None and objective(c) is not None and objective(c) > objective(b):
            declined['C'] = 'the cooperative adjustment does not beat plain netting on the objective'
        else:
            recommendation = 'C'
            reason = 'cooperative adjustment leaves every owner no worse off and beats the alternatives'
    elif c.feasible:
        declined['C'] = ('it would leave these owners worse off than executing independently: '
                         + ', '.join(verdict['harmed_owners'])) if verdict['assessable'] else str(verdict['reason'])
    else:
        declined['C'] = 'the cooperative proposal is not executable: ' + '; '.join(c.reasons)
    if recommendation != 'C':
        if b.feasible and netting_verdict['no_worse_than_independent']:
            recommendation = 'B'
            reason = 'plain netting leaves every owner no worse off'
        elif b.feasible:
            declined['B'] = ('it would leave these owners worse off than executing independently: '
                             + ', '.join(netting_verdict['harmed_owners'])) if netting_verdict['assessable'] else str(netting_verdict['reason'])
        else:
            declined['B'] = 'the netting proposal is not executable: ' + '; '.join(b.reasons)
    # Lifecycle cost, not owner-charged cost: the comparison must count the operator subsidy too,
    # or a batch could look cheaper than independent execution by leaving someone else to pay.
    a_cost = full_cost(a.ledger)
    b_cost = full_cost(b.ledger)
    c_cost = full_cost(c.ledger)
    eligible = not b.ledger['noop'] and not c.ledger['noop']
    raw = b_cost - c_cost
    return {
        'scenario_sha256': a.scenario_sha256,
        'proposals': {name: proposal.to_json() for name, proposal in summary.items()},
        'comparison': {
            'valid_baselines': True,
            'netting_gain_micro_usd': a_cost - b_cost,
            'cooperative_raw_difference_micro_usd': raw,
            'per_owner': verdict,
            'per_owner_under_netting': netting_verdict,
            'recommendation': {'method': recommendation, 'reason': reason, 'declined': declined},
            'cooperative_gain_micro_usd': raw if eligible else 0,
            'cooperative_trading_benefit_eligible': eligible,
            'attribution': ('both baselines execute nonzero trades under identical mandates'
                            if eligible else
                            'a no-op baseline is not an attributable cooperative trading saving'),
        },
    }
