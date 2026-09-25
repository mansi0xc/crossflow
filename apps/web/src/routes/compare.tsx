import { micro, type PlanResponse } from '../api.js';
import { planDecision } from '../decision.js';

const METHOD_LABEL: Record<string, string> = {
  A: 'Run each strategy on its own',
  B: 'Cross the parts that cancel, then trade the rest',
  C: 'Cross, and adjust the targets together',
};

/** Named assets rather than indices; the tested book is two stocks and cash. */
const ASSET_LABEL = ['Cash', 'Test stock 1', 'Test stock 2'];

const recommend = (method: string | undefined) => {
  if (method === 'C') return 'Cross these strategies and adjust them together.';
  if (method === 'B') return 'Cross only the parts that cancel, and trade the rest independently.';
  return 'Execute each strategy independently. Crossing would leave at least one account worse off.';
};

/** micro-USD to a readable dollar figure, without floating point. */
function dollars(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const raw = typeof value === 'string' ? value : typeof value === 'number' ? String(value)
    : (() => { const pair = value as { numerator: number; denominator: number };
      return String(pair.denominator ? Math.trunc(pair.numerator / pair.denominator) : 0); })();
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const whole = digits.padStart(7, '0');
  const dollarsPart = whole.slice(0, -6).replace(/^0+(?=\d)/, '');
  const cents = whole.slice(-6, -4);
  return `${negative ? '-' : ''}$${dollarsPart}.${cents}`;
}

/** Micro-USD to an exact integer string, from a decimal string, integer or rational pair. */
function microString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(Math.trunc(value));
  const pair = value as { numerator?: unknown; denominator?: unknown };
  if (typeof pair.numerator !== 'number' || typeof pair.denominator !== 'number' || pair.denominator === 0) return null;
  return String(Math.trunc(pair.numerator / pair.denominator));
}

/**
 * Money with adaptive precision. Modelled per-owner costs are often far below one cent, so a fixed
 * two-decimal format would render every one of them as "$0.00". Up to six decimals are shown,
 * trailing zeros trimmed.
 */
function money(value: unknown): string {
  const raw = microString(value);
  if (raw === null) return '—';
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const whole = (digits.length > 6 ? digits.slice(0, digits.length - 6) : '0').replace(/^0+(?=\d)/, '');
  const fraction = (digits.length > 6 ? digits.slice(digits.length - 6) : digits.padStart(6, '0')).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}${fraction ? `.${fraction}` : '.00'}`;
}

const HOLDING_LABEL: Record<string, string> = { CASH: 'cash', STOCK_A: 'stock 1', STOCK_B: 'stock 2' };

/** Named raw holdings, not an objective: what the account actually holds. */
function holdings(raw: Record<string, number | string> | undefined): string {
  if (!raw) return '—';
  return (['CASH', 'STOCK_A', 'STOCK_B'] as const)
    .map(asset => `${Number(raw[asset] ?? 0).toLocaleString('en-US')} ${HOLDING_LABEL[asset]}`)
    .join(', ');
}

/**
 * The decision, then the evidence for it.
 *
 * A trader wants to know what is being recommended and what it does to each account. The aggregate
 * is secondary, and the raw units, hashes and micro-USD stay available but folded away.
 */
export function Compare({ plan, onApprove }: { plan: PlanResponse; onApprove: () => void }) {
  const comparison = plan.comparison;
  const decision = planDecision(plan);
  const recommendation = (comparison as { recommendation?: { method: string; reason: string; declined: Record<string, string> } }).recommendation;
  const perOwner = (comparison as { per_owner?: { per_owner: PerOwnerRow[]; harmed_owners: string[]; no_worse_than_independent: boolean | null; definition?: string } }).per_owner;

  return (
    <section data-testid="compare">
      <h2>2 · What should happen to these strategies</h2>

      <p className="recommendation" data-testid="recommendation">
        <strong>{recommend(recommendation?.method)}</strong>
        {recommendation?.reason ? <span className="note"> {recommendation.reason}.</span> : null}
      </p>
      {recommendation && Object.keys(recommendation.declined ?? {}).length > 0 ? (
        <ul className="note" data-testid="declined-reasons">
          {Object.entries(recommendation.declined).map(([method, reason]) => (
            <li key={method}>Not {METHOD_LABEL[method]?.toLowerCase() ?? method}: {reason}.</li>
          ))}
        </ul>
      ) : null}

      {perOwner?.no_worse_than_independent === false ? (
        <p className="warn" data-testid="harmed-owners">
          This batch would leave {perOwner.harmed_owners.length} account(s) worse off than trading on
          their own: {perOwner.harmed_owners.join(', ')}. It is not recommended.
        </p>
      ) : null}

      <h3>What each account gets</h3>
      <table data-testid="per-owner-table">
        <caption>
          Holdings are the account's own raw units, before and after. Execution cost, target
          deviation and net saving are modelled micro-USD; net saving is the independent outcome
          minus this plan's, so positive means better off. A positive execution cost is money spent.
        </caption>
        <thead>
          <tr>
            <th>account</th><th>holds before</th><th>holds after</th>
            <th>execution cost</th><th>target deviation after</th><th>net saving vs independent</th>
          </tr>
        </thead>
        <tbody>
          {(perOwner?.per_owner ?? []).map(row => (
            <tr key={row.owner} data-testid={`owner-${row.owner.slice(0, 8)}`}
                className={row.worse_than_independent ? 'worse' : undefined}>
              <td>{row.owner.slice(0, 8)}…<span className="note"> {describeTrades(row.trades)}</span></td>
              <td>{holdings(row.before_raw)}</td>
              <td>{holdings(row.after_raw)}</td>
              <td>{money(row.allocated_cost_micro_usd)}</td>
              <td>{money(row.target_error_after_micro_usd)}</td>
              <td>{money(row.objective_saving_micro_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {perOwner?.per_owner?.length ? (
        <p className="note" data-testid="per-owner-definition">{perOwner.definition}</p>
      ) : null}

      <details data-testid="comparison-details">
        <summary data-testid="comparison-summary">How the three approaches compare in total</summary>
        <table data-testid="comparison-table">
          <thead>
            <tr><th>approach</th><th>executable</th><th>recurring cost</th><th>tracking error</th></tr>
          </thead>
          <tbody>
            {(['A', 'B', 'C'] as const).map(method => {
              const proposal = plan.proposals[method];
              return (
                <tr key={method} data-testid={`proposal-${method}`}>
                  <td>{METHOD_LABEL[method]}</td>
                  <td>{proposal.feasible ? 'yes' : `no — ${(proposal.reasons ?? []).join(', ') || 'not executable'}`}</td>
                  <td>{dollars(proposal.totals?.recurring_micro_usd)}</td>
                  <td>{dollars(proposal.totals?.after_error_micro_usd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="note">
          Aggregate difference against current practice: {micro(comparison.netting_gain_micro_usd)} for
          crossing alone, {micro(comparison.cooperative_gain_micro_usd)} if the targets are also
          adjusted. Modelled micro-USD under one frozen cost convention; not realized fills.
        </p>
        <details data-testid="raw-units">
          <summary data-testid="raw-summary">Raw units and identifiers</summary>
          <pre>{JSON.stringify({ scenario: plan.scenario_id, scenarioSha256: plan.scenario_sha256,
            proposalTotals: plan.proposals.C.totals, method: 'C' }, null, 2)}</pre>
        </details>
      </details>

      <button data-testid="go-approve" onClick={onApprove} disabled={!decision.eligible}>
        Continue to approval
      </button>
      {perOwner?.no_worse_than_independent === false ? (
        <p className="note">Approval is blocked because this batch would harm an account.</p>
      ) : null}
      {!decision.eligible && decision.reason ? (
        <p className="note" data-testid="blocked-reason">Approval is blocked: {decision.reason}.</p>
      ) : null}
    </section>
  );
}

interface PerOwnerRow {
  owner: string;
  /** Named raw holdings before and after this plan. */
  before_raw?: Record<string, number | string>;
  after_raw?: Record<string, number | string>;
  trades: Record<string, number | string>;
  /** Estimated execution cost the owner bears. */
  allocated_cost_micro_usd: unknown;
  /** Preference-weighted target deviation after execution. */
  target_error_after_micro_usd?: unknown;
  /** Independent objective minus this plan's: positive means better off. */
  objective_saving_micro_usd: unknown;
  worse_than_independent: boolean;
}

function describeTrades(trades: Record<string, number | string>): string {
  const parts: string[] = [];
  for (const [asset, quantity] of Object.entries(trades ?? {})) {
    const value = Number(quantity);
    if (value === 0) continue;
    parts.push(`${value > 0 ? 'buys' : 'sells'} ${Math.abs(value).toLocaleString('en-US')} ${asset.replace('STOCK_', 'stock ').replace('CASH', 'cash')}`);
  }
  return parts.length ? `(${parts.join(', ')})` : '(no trade)';
}

export { ASSET_LABEL, dollars };
