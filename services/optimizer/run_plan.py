#!/usr/bin/env python3
"""Bounded numerical entrypoint used by the service layer.

The service spawns this with a fixed executable and fixed arguments and writes one JSON request to
stdin. It never interpolates anything into a shell. The request must name a **frozen** scenario:
either by id, or inline with a hash that matches the committed suite, so the service cannot be
used to run an arbitrary model.

Output on stdout is a single JSON object with canonical integer/decimal strings only — no floats.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services'))

from optimizer import cooperative  # noqa: E402
from optimizer.portfolio import PortfolioError, scenario_from_portfolio  # noqa: E402
from optimizer.shared import Budget, encode, sha  # noqa: E402

MAX_CANDIDATES = 16_384


def fail(message: str, code: int = 2) -> None:
    json.dump({'status': 'REJECTED', 'reason': message}, sys.stdout)
    sys.stdout.write('\n')
    raise SystemExit(code)


def load_frozen():
    suite = json.loads((ROOT / 'research' / 'economics' / 'scenarios.json').read_text())
    manifest = json.loads((ROOT / 'research' / 'economics' / 'split-manifest.json').read_text())
    if sha(suite) != manifest['suite_sha256']:
        fail('frozen suite hash mismatch')
    return {scenario['id']: scenario for scenario in suite['scenarios']}, manifest


def main() -> None:
    raw = sys.stdin.read()
    if len(raw) > 65_536:
        fail('request too large')
    try:
        request = json.loads(raw)
    except json.JSONDecodeError:
        fail('request is not JSON')
    if not isinstance(request, dict):
        fail('request must be an object')
    if request.get('portfolio') is None and not isinstance(request.get('scenario_id'), str):
        fail('scenario_id or portfolio is required')
    # The step is the search granularity over each owner's signed bounds. Real quantities are large
    # (millions of raw units), so a step of one would exhaust the candidate budget before finding
    # anything; the caller states how finely it wants the space searched.
    grid_step = request.get('grid_step', 1)
    if isinstance(grid_step, bool) or not isinstance(grid_step, int) or grid_step < 1 or grid_step > 10**9:
        fail('grid_step out of range')

    scenarios, _ = load_frozen()
    defaults: list[str] = []
    portfolio = request.get('portfolio')
    if portfolio is not None:
        # A portfolio the optimizer has never seen. The cost and market convention still come from
        # the frozen template, so the result stays comparable with every committed number.
        template = next(iter(scenarios.values()))
        try:
            scenario, defaults = scenario_from_portfolio(portfolio, template)
        except PortfolioError as error:
            fail(f'portfolio refused: {error}')
    else:
        scenario = scenarios.get(request['scenario_id'])
        if scenario is None:
            fail('unknown scenario_id')
        inline = request.get('scenario')
        if inline is not None:
            if not isinstance(inline, dict) or sha(inline) != sha(scenario):
                fail('inline scenario does not match the frozen fixture')

    budget = Budget(max_candidates=MAX_CANDIDATES, grid_step=grid_step)
    report = cooperative.compare(scenario, budget)
    payload = {
        'status': 'OK',
        'schema_version': 1,
        'scenario_id': scenario['id'],
        'portfolio_sha256': sha(scenario),
        'assumptions': defaults,
        'scenario_sha256': report['scenario_sha256'],
        'budget': {'max_candidates': budget.max_candidates, 'grid_step': budget.grid_step},
        'proposals': report['proposals'],
        'comparison': report['comparison'],
    }
    # Exact rationals are encoded as integer/denominator pairs by `encode`; nothing here is a float.
    json.dump(encode(payload), sys.stdout, separators=(',', ':'))
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
