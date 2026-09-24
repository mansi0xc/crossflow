import { micro, type PlanResponse } from '../api.js';

const METHOD_LABEL: Record<string, string> = {
  A: 'Independent execution',
  B: 'Fixed-order netting',
  C: 'Cooperative adjustment',
};

/**
 * Step 2 — the three approaches under identical constraints.
 *
 * Negative and no-benefit outcomes are shown as prominently as positive ones, and the attribution
 * line states plainly whether a saving is attributable at all.
 */
export function Compare({ plan, onApprove }: { plan: PlanResponse; onApprove: () => void }) {
  const comparison = plan.comparison;
  return (
    <section data-testid="compare">
      <h2>2 · Compare the three approaches</h2>
      <p className="note">Identical starting holdings, prices, target bands and cost model.</p>

      <table data-testid="comparison-table">
        <thead>
          <tr><th>approach</th><th>status</th><th>recurring cost</th><th>objective</th><th>after-target error</th></tr>
        </thead>
        <tbody>
          {(['A', 'B', 'C'] as const).map(method => {
            const proposal = plan.proposals[method];
            return (
              <tr key={method} data-testid={`proposal-${method}`}>
                <td>{METHOD_LABEL[method]}</td>
                <td>{proposal.status}{proposal.feasible ? '' : ' (not executable)'}</td>
                <td>{micro(proposal.totals?.recurring_micro_usd)}</td>
                <td>{micro(proposal.totals?.objective_micro_usd)}</td>
                <td>{micro(proposal.totals?.after_error_micro_usd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Incremental effects, kept separate</h3>
      {comparison.valid_baselines ? (
        <ul data-testid="comparison-attribution">
          <li>netting versus independent: {micro(comparison.netting_gain_micro_usd)}</li>
          <li>
            cooperative versus netting:{' '}
            {comparison.cooperative_trading_benefit_eligible
              ? micro(comparison.cooperative_gain_micro_usd)
              : `not attributable — ${micro(comparison.cooperative_raw_difference_micro_usd)} raw difference`}
          </li>
          <li className="note">{comparison.attribution}</li>
        </ul>
      ) : (
        <p className="warn" data-testid="comparison-invalid">
          No savings claim is possible for this scenario: {comparison.reason}
        </p>
      )}

      {(['A', 'B', 'C'] as const).some(method => !plan.proposals[method].feasible) ? (
        <p className="warn">
          At least one approach is not executable under these constraints. A method that cannot
          satisfy the mandate is reported, not quietly dropped.
        </p>
      ) : null}

      <p className="note">
        These are modelled micro-USD under one frozen cost convention on synthetic scenarios. They
        are not realized trades and not a backtest of live fills.
      </p>
      <button data-testid="go-approve" onClick={onApprove} disabled={!plan.proposals.A.feasible}>
        Continue to approval
      </button>
    </section>
  );
}
