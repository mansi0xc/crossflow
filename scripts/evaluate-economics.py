#!/usr/bin/env python3
"""T21 held-out economic evaluation.

Runs the precommitted held-out matrix **once** against the frozen engines and cost conventions,
preserves every outcome (including the ones that weaken the pitch), and writes both a machine
readable result and a human report.

This script does not tune anything. The split is read from the frozen manifest, the sensitivity
grid is fixed below, and a report validator re-checks the emitted file so a changed split, a
dropped scenario or a missing cost field fails instead of passing silently.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services'))

from optimizer import cooperative  # noqa: E402
from optimizer.shared import Budget, encode, reference, sha  # noqa: E402

SUITE = ROOT / 'research' / 'economics' / 'scenarios.json'
MANIFEST = ROOT / 'research' / 'economics' / 'split-manifest.json'
DEFAULT_RESULTS = ROOT / 'docs' / 'evidence' / 'economic-results.json'
DEFAULT_REPORT = ROOT / 'docs' / 'evidence' / 'economic-report.md'
SCHEMA_VERSION = 1

# Declared before the run and never adjusted afterwards.
BUDGET = Budget(max_candidates=16_384, grid_step=1)
SENSITIVITY = (
    ('external_fee_multiplier_bps', 'scale', (5_000, 10_000, 20_000)),
    ('batch_wait_seconds', 'waiting', (0, 300, 3600)),
    ('liquidity_depth_multiplier_bps', 'depth', (2_500, 10_000, 40_000)),
)


def load_frozen() -> tuple[dict, dict]:
    suite = json.loads(SUITE.read_text())
    manifest = json.loads(MANIFEST.read_text())
    if sha(suite) != manifest['suite_sha256']:
        raise SystemExit('frozen suite hash mismatch; refusing to evaluate a mutated suite')
    return suite, manifest


def select(suite: dict, manifest: dict, split: str):
    ids = manifest['holdout_ids'] if split == 'holdout' else manifest['train_ids']
    present = {scenario['id']: scenario for scenario in suite['scenarios']}
    if set(ids) - set(present):
        raise SystemExit(f'{split} split names a scenario that is not in the suite')
    selected = [present[scenario_id] for scenario_id in ids]
    for scenario in selected:
        if sha(scenario) != manifest['scenario_sha256'][scenario['id']]:
            raise SystemExit(f'fixture mismatch for {scenario["id"]}')
        if scenario['split'] != split:
            raise SystemExit(f'{scenario["id"]} is labelled {scenario["split"]}, not {split}')
    return selected


def scenario_row(scenario: dict) -> dict:
    report = cooperative.compare(scenario, BUDGET)
    proposals = report['proposals']
    row = {
        'id': scenario['id'],
        'category': scenario['category'],
        'scenario_sha256': report['scenario_sha256'],
        'declared_rejections': sorted(scenario['expected_rejection_reasons']),
        'methods': {},
        'comparison': report['comparison'],
    }
    for method, proposal in proposals.items():
        ledger = proposal['totals']
        row['methods'][method] = {
            'status': proposal['status'],
            'feasible': proposal['feasible'],
            'reasons': proposal['reasons'],
            'ledger_errors': proposal['ledger_errors'],
            'candidates_evaluated': proposal['candidates_evaluated'],
            'budget_exhausted': proposal['budget_exhausted'],
            'totals': {key: encode(value) for key, value in (ledger or {}).items()},
        }
    return row


def per_owner_outcomes(scenario: dict, split: str) -> list[dict]:
    report = cooperative.compare(scenario, BUDGET)
    out = []
    for method in ('A', 'B', 'C'):
        proposal = report['proposals'][method]
        if not proposal['feasible']:
            continue
        ledger = method_ledger(scenario, method)
        for row in ledger['accounts']:
            out.append({
                'id': scenario['id'], 'split': split, 'method': method, 'owner': row['id'],
                'recurring_micro_usd': encode(row['recurring_micro_usd']),
                'objective_micro_usd': encode(row['objective_micro_usd']),
                'after_error_micro_usd': encode(row['after_error_micro_usd']),
                'turnover_micro_usd': encode(row['turnover_micro_usd']),
                'venue_cost_micro_usd': encode(row['venue_cost_micro_usd']),
                'network_micro_usd': encode(row['network_micro_usd']),
                'waiting_micro_usd': encode(row['waiting_micro_usd']),
                'price_difference_micro_usd': encode(row['price_difference_micro_usd']),
                'failures': list(row['failures']),
            })
    return out


def method_ledger(scenario: dict, method: str) -> dict:
    from optimizer import fixed_netting, independent
    if method == 'A':
        return independent.plan(scenario, BUDGET).ledger
    if method == 'B':
        return fixed_netting.plan(scenario, BUDGET).ledger
    return cooperative.plan(scenario, BUDGET).ledger


def sensitivity_runs(selected: list[dict]) -> list[dict]:
    rows = []
    for scenario in selected:
        for label, kind, values in SENSITIVITY:
            for value in values:
                perturbed = copy.deepcopy(scenario)
                if kind == 'scale':
                    for curve in perturbed['cost_model']['external_by_asset'].values():
                        curve['half_spread_bps'] = curve['half_spread_bps'] * value // 10_000
                        curve['venue_fee_bps'] = curve['venue_fee_bps'] * value // 10_000
                    perturbed['cost_model']['network']['priority_lamports_per_transaction'] = (
                        perturbed['cost_model']['network']['priority_lamports_per_transaction'] * value // 10_000)
                elif kind == 'waiting':
                    perturbed['cost_model']['waiting']['batch_seconds'] = value
                    perturbed['cost_model']['waiting']['independent_seconds'] = value
                else:
                    for curve in perturbed['cost_model']['external_by_asset'].values():
                        curve['depth_micro_usd'] = curve['depth_micro_usd'] * value // 10_000
                report = cooperative.compare(perturbed, BUDGET)
                comparison = report['comparison']
                rows.append({
                    'scenario': scenario['id'],
                    'parameter': label,
                    'value': value,
                    'input_sha256': sha(perturbed),
                    'valid_baselines': comparison['valid_baselines'],
                    'netting_gain_micro_usd': encode(comparison.get('netting_gain_micro_usd')),
                    'cooperative_gain_micro_usd': encode(comparison.get('cooperative_gain_micro_usd')),
                    'cooperative_trading_benefit_eligible': comparison.get('cooperative_trading_benefit_eligible', False),
                })
    return rows


def summarise(rows: list[dict], sensitivity: list[dict]) -> dict:
    feasible = [row for row in rows if row['comparison']['valid_baselines']]
    netting = [row['comparison']['netting_gain_micro_usd'] for row in feasible]
    co_op = [row['comparison']['cooperative_gain_micro_usd'] for row in feasible]
    eligible = [row for row in feasible if row['comparison']['cooperative_trading_benefit_eligible']]

    def as_int(value):
        if value is None:
            return None
        if isinstance(value, dict):
            return value['numerator'] // value['denominator']
        return value

    netting_ints = sorted(as_int(value) for value in netting if value is not None)
    co_op_ints = sorted(as_int(value) for value in co_op if value is not None)
    sensitivity_co_op = [as_int(row['cooperative_gain_micro_usd']) for row in sensitivity
                         if row['valid_baselines'] and row['cooperative_gain_micro_usd'] is not None]
    return {
        'scenarios_evaluated': len(rows),
        'scenarios_with_three_feasible_methods': len(feasible),
        'scenarios_rejected_before_search': sum(1 for row in rows if not row['methods']['A']['feasible']),
        'cooperative_trading_benefit_eligible_scenarios': len(eligible),
        'netting_gain_micro_usd': {
            'median': _median(netting_ints), 'min': netting_ints[0] if netting_ints else None,
            'max': netting_ints[-1] if netting_ints else None,
            'positive_scenarios': sum(1 for value in netting_ints if value > 0),
            'negative_scenarios': sum(1 for value in netting_ints if value < 0),
        },
        'cooperative_gain_micro_usd': {
            'median': _median(co_op_ints), 'min': co_op_ints[0] if co_op_ints else None,
            'max': co_op_ints[-1] if co_op_ints else None,
            'positive_scenarios': sum(1 for value in co_op_ints if value > 0),
            'negative_scenarios': sum(1 for value in co_op_ints if value < 0),
        },
        'sensitivity_runs': len(sensitivity),
        'sensitivity_cooperative_gain_positive': sum(1 for value in sensitivity_co_op if value > 0),
        'sensitivity_cooperative_gain_negative_or_zero': sum(1 for value in sensitivity_co_op if value <= 0),
        'holds_under_sensitivity': bool(sensitivity_co_op) and all(value > 0 for value in sensitivity_co_op),
    }


def _median(values: list[int]):
    if not values:
        return None
    middle = len(values) // 2
    if len(values) % 2:
        return values[middle]
    return (values[middle - 1] + values[middle]) // 2


def render_report(split: str, rows: list[dict], summary: dict, sensitivity: list[dict], suite_commit: str) -> str:
    lines = [
        '# CrossFlow economic evaluation',
        '',
        f'Split: **{split}** · frozen suite `{suite_commit}` · schema {SCHEMA_VERSION}',
        '',
        'All values are integer micro-USD from the frozen exact-rational model. Method A is',
        'independent execution, B is fixed-order netting of A\'s own orders, C is cooperative joint',
        'adjustment. `netting` is A minus B; `cooperative` is B minus C and is only attributed when',
        'both baselines execute nonzero trades.',
        '',
        '## Headline',
        '',
        f'- scenarios evaluated: **{summary["scenarios_evaluated"]}**',
        f'- scenarios where all three methods are feasible: **{summary["scenarios_with_three_feasible_methods"]}**',
        f'- scenarios rejected before search (mandate/oracle): **{summary["scenarios_rejected_before_search"]}**',
        f'- scenarios where a cooperative trading saving is attributable: **{summary["cooperative_trading_benefit_eligible_scenarios"]}**',
        f'- netting gain (micro-USD): median {summary["netting_gain_micro_usd"]["median"]}, '
        f'min {summary["netting_gain_micro_usd"]["min"]}, max {summary["netting_gain_micro_usd"]["max"]}, '
        f'positive {summary["netting_gain_micro_usd"]["positive_scenarios"]}, '
        f'negative {summary["netting_gain_micro_usd"]["negative_scenarios"]}',
        f'- cooperative gain (micro-USD): median {summary["cooperative_gain_micro_usd"]["median"]}, '
        f'min {summary["cooperative_gain_micro_usd"]["min"]}, max {summary["cooperative_gain_micro_usd"]["max"]}, '
        f'positive {summary["cooperative_gain_micro_usd"]["positive_scenarios"]}, '
        f'negative {summary["cooperative_gain_micro_usd"]["negative_scenarios"]}',
        f'- holds under every declared sensitivity point: **{summary["holds_under_sensitivity"]}** '
        f'({summary["sensitivity_cooperative_gain_positive"]} positive of {summary["sensitivity_runs"]})',
        '',
        '## Per scenario',
        '',
        '| scenario | category | A/B/C status | netting gain | cooperative gain | eligible |',
        '|---|---|---|---|---|---|',
    ]
    for row in rows:
        comparison = row['comparison']
        statuses = '/'.join(row['methods'][m]['status'] for m in ('A', 'B', 'C'))
        lines.append('| {id} | {category} | {statuses} | {netting} | {co_op} | {eligible} |'.format(
            id=row['id'], category=row['category'], statuses=statuses,
            netting=_show(comparison.get('netting_gain_micro_usd')),
            co_op=_show(comparison.get('cooperative_gain_micro_usd')),
            eligible=comparison.get('cooperative_trading_benefit_eligible')))
    lines += [
        '',
        '## Sensitivity (declared before the run)',
        '',
        '| scenario | parameter | value | netting gain | cooperative gain |',
        '|---|---|---|---|---|',
    ]
    for row in sensitivity:
        lines.append('| {scenario} | {parameter} | {value} | {netting} | {co_op} |'.format(
            scenario=row['scenario'], parameter=row['parameter'], value=row['value'],
            netting=_show(row['netting_gain_micro_usd']), co_op=_show(row['cooperative_gain_micro_usd'])))
    lines += [
        '',
        '## What this does and does not show',
        '',
        '- It measures a **modeled** comparison under one frozen cost convention on synthetic',
        '  scenarios. It is not realized trading, not live liquidity and not a backtest of real',
        '  fills. Equal-state comparison differs from sequential live trades that move reserves.',
        '- The cooperative engine explores the frozen integer grid only; `ok_bounded` rows did not',
        '  exhaust their space, so their optimality is bounded, not proven.',
        '- Reordered payments, network fees and recoverable rent are reported separately from',
        '  trading cost; one-time rent is a deposit, not a recurring saving.',
        '- A negative or zero cooperative gain is reported as such and is not replaced by a',
        '  different counterfactual.',
    ]
    return '\n'.join(lines) + '\n'


def _show(value):
    if value is None:
        return '—'
    if isinstance(value, dict):
        return str(value['numerator'] // value['denominator'])
    return str(value)


def build(split: str) -> dict:
    suite, manifest = load_frozen()
    selected = select(suite, manifest, split)
    rows = [scenario_row(scenario) for scenario in selected]
    owners = []
    for scenario in selected:
        owners.extend(per_owner_outcomes(scenario, split))
    sensitivity = sensitivity_runs(selected)
    summary = summarise(rows, sensitivity)
    return {
        'schema_version': SCHEMA_VERSION,
        'split': split,
        'suite_id': manifest['suite_id'],
        'suite_sha256': manifest['suite_sha256'],
        'seed': manifest['seed'],
        'frozen_before_optimizer_tuning': manifest['frozen_before_optimizer_tuning'],
        'budget': {'max_candidates': BUDGET.max_candidates, 'grid_step': BUDGET.grid_step},
        'numeric_policy': 'exact rational micro-USD; integer raw token/cash outputs; no floating point',
        'scenarios': rows,
        'per_owner': owners,
        'sensitivity': sensitivity,
        'summary': summary,
    }


def validate(report: dict) -> list[str]:
    """Re-check an emitted report. A changed split, a dropped scenario or a missing cost field
    must fail rather than be reported as a clean run."""
    errors = []
    suite, manifest = load_frozen()
    expected = manifest['holdout_ids'] if report['split'] == 'holdout' else manifest['train_ids']
    if report.get('schema_version') != SCHEMA_VERSION:
        errors.append('schema_version')
    if report.get('suite_sha256') != manifest['suite_sha256']:
        errors.append('suite_hash')
    listed = [row['id'] for row in report.get('scenarios', [])]
    if listed != expected:
        errors.append('split_coverage')
    present = {scenario['id']: scenario for scenario in suite['scenarios']}
    for row in report.get('scenarios', []):
        if sha(present[row['id']]) != row['scenario_sha256']:
            errors.append(f'fixture_sha/{row["id"]}')
        if row['methods']['A']['status'] == 'rejected':
            if row['methods']['A']['reasons'] != row['declared_rejections']:
                errors.append(f'rejected_mismatch/{row["id"]}')
            continue
        if row['methods']['A']['status'] != 'ok':
            errors.append(f'method_a_status/{row["id"]}')
        for method in ('A', 'B', 'C'):
            totals = row['methods'][method]['totals']
            for key in ('recurring_micro_usd', 'venue_cost_micro_usd', 'network_micro_usd',
                        'waiting_micro_usd', 'price_difference_micro_usd'):
                if key not in totals:
                    errors.append(f'missing_cost/{row["id"]}/{method}/{key}')
        comparison = row['comparison']
        if comparison['valid_baselines']:
            if comparison['netting_gain_micro_usd'] is None:
                errors.append(f'missing_netting_gain/{row["id"]}')
            if not comparison['cooperative_trading_benefit_eligible'] and comparison['cooperative_gain_micro_usd'] != 0:
                errors.append(f'false_cooperative_gain/{row["id"]}')
    if len(report.get('sensitivity', [])) != len(expected) * sum(len(values) for _, _, values in SENSITIVITY):
        errors.append('sensitivity_coverage')
    return errors


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--split', choices=('train', 'holdout'), default='holdout')
    parser.add_argument('--output', type=Path, default=DEFAULT_RESULTS)
    parser.add_argument('--report', type=Path, default=DEFAULT_REPORT)
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()
    if args.validate_only:
        errors = validate(json.loads(args.output.read_text()))
        print(json.dumps({'status': 'PASS' if not errors else 'FAIL', 'errors': errors}))
        raise SystemExit(0 if not errors else 1)
    report = build(args.split)
    errors = validate(report)
    if errors:
        raise SystemExit(f'report validation failed: {errors}')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(encode(report), indent=2) + '\n')
    args.report.write_text(render_report(args.split, report['scenarios'], report['summary'],
                                         report['sensitivity'], report['suite_sha256']))
    print(json.dumps({
        'status': 'PASS', 'split': args.split,
        'scenarios': report['summary']['scenarios_evaluated'],
        'three_feasible_methods': report['summary']['scenarios_with_three_feasible_methods'],
        'cooperative_eligible': report['summary']['cooperative_trading_benefit_eligible_scenarios'],
        'cooperative_gain_median_micro_usd': report['summary']['cooperative_gain_micro_usd']['median'],
        'cooperative_gain_positive': report['summary']['cooperative_gain_micro_usd']['positive_scenarios'],
        'holds_under_sensitivity': report['summary']['holds_under_sensitivity'],
        'output': str(args.output), 'report': str(args.report),
    }, indent=2))


if __name__ == '__main__':
    main()
