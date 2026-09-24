import type { Deployment } from '../api.js';
import { PortfolioSlice } from '../components/PortfolioSlice.js';

/**
 * Step 1 — choose the portfolio slice and review what funding it means.
 *
 * Nothing here authorizes anything: the wallet is connected only in the approve step, and the
 * recovery route is offered before any asset is locked.
 */
export function Prepare({ deployment, scenarios, onPlan }: {
  deployment: Deployment | null;
  scenarios: string[];
  onPlan: (scenarioId: string) => void;
}) {
  return (
    <section data-testid="prepare">
      <h2>1 · Select a portfolio slice</h2>
      {!deployment ? <p>Waiting for the deployment identity…</p> : (
        <>
          <p data-testid="deployment-identity">
            program {deployment.programId.slice(0, 8)}… · config {deployment.config.slice(0, 8)}…
            {' · oracle '}{deployment.oracleMode === 0 ? 'fixture (TEST PRICES)' : 'authenticated'}
            {' · protocol fee '}{deployment.protocolFeeBps} bps
          </p>
          <p className="note">
            Connecting a wallet is not an authorization. You authorize by signing one funding
            transaction that commits the exact raw-unit bounds shown on the next screens.
          </p>
          <PortfolioSlice deployment={deployment} />
          <h3>Funded escrow</h3>
          <p>
            Funding moves the selected amounts into per-intent vaults controlled by program rules,
            not by the wallet. During escrow the funds are not freely spendable. You can cancel at
            any time and withdraw each asset separately, without any solver or admin.
          </p>
          <h3>Choose a scenario</h3>
          <ul className="scenarios">
            {scenarios.map(id => (
              <li key={id}>
                <button data-testid={`scenario-${id}`} onClick={() => onPlan(id)}>{id}</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
