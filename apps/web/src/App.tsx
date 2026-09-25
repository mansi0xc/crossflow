import { useCallback, useEffect, useMemo, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { api, type Deployment, type PlanResponse } from './api.js';
import { listOwnerIntents, type OnChainIntent } from '../../../packages/client/src/intents.js';
import { connect, detectProvider, providerLabel, type InjectedProvider } from './wallet.js';
import { Prepare } from './routes/prepare.js';
import { Compare } from './routes/compare.js';
import { Approve } from './routes/approve.js';
import { Intent } from './routes/intent.js';
import { Explainer } from './components/Explainer.js';

export type Step = 'prepare' | 'compare' | 'approve' | 'intent';

export interface SessionState {
  deployment: Deployment | null;
  plan: PlanResponse | null;
  selectedSlice: { funding: string; minOutput: string; maxOutput: string }[] | null;
  signature: string | null;
  intent: OnChainIntent | null;
}

const SCENARIOS = ['opposite-01', 'all-buy-01', 'asymmetric-01', 'tight-01', 'expensive-01', 'noise-01'];

export default function App() {
  const [step, setStep] = useState<Step>('prepare');
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [provider, setProvider] = useState<InjectedProvider | null>(null);
  const [wallet, setWallet] = useState<PublicKey | null>(null);
  const [intents, setIntents] = useState<OnChainIntent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setProvider(detectProvider()); }, []);

  useEffect(() => {
    api.deployment().then(setDeployment).catch(reason => setError(String(reason.message ?? reason)));
  }, []);

  const connection = useMemo(
    () => (deployment ? new Connection(import.meta.env?.VITE_CROSSFLOW_RPC ?? 'http://127.0.0.1:8899', 'confirmed') : null),
    [deployment],
  );

  // Intents are read from chain, not from the service: recovery must stay reachable when the
  // service is down, which is exactly the situation the recovery path exists for.
  const refreshIntents = useCallback(async () => {
    if (!connection || !wallet || !deployment) return;
    try {
      setIntents(await listOwnerIntents(connection, new PublicKey(deployment.programId), new PublicKey(deployment.config), wallet));
      setIntentError(null);
    } catch (reason) {
      // A failed refresh must never erase what the user could already see.
      setIntentError(`could not read intents from chain: ${String((reason as Error).message ?? reason)}`);
    }
  }, [connection, wallet, deployment]);

  useEffect(() => { void refreshIntents(); }, [refreshIntents]);

  const runPlan = useCallback(async (scenarioId: string) => {
    setBusy(true); setError(null);
    try {
      setPlan(await api.plan(scenarioId, 4));
      setStep('compare');
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  }, []);

  const connectWallet = useCallback(async () => {
    if (!provider) { setError('No wallet provider detected. Install Phantom, or run the UI test harness.'); return; }
    try { setWallet(await connect(provider)); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); }
  }, [provider]);

  const owned = intents;

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to the main content</a>
      <header>
        <h1>CrossFlow</h1>
        {/* The cluster label is persistent and never implied by context. */}
        <p className="cluster" data-testid="cluster-label">
          {deployment ? `${deployment.cluster.toUpperCase()} · test assets only · ${deployment.oracleLabel}` : 'loading deployment identity…'}
        </p>
        <nav aria-label="Steps">
          {(['prepare', 'compare', 'approve', 'intent'] as Step[]).map(candidate => (
            <button
              key={candidate}
              type="button"
              data-testid={`nav-${candidate}`}
              aria-current={candidate === step ? 'step' : undefined}
              className={candidate === step ? 'active' : ''}
              onClick={() => setStep(candidate)}
              disabled={
                (candidate === 'compare' && !plan) ||
                (candidate === 'approve' && !plan) ||
                (candidate === 'intent' && !wallet)
              }
            >
              {candidate}
            </button>
          ))}
        </nav>
      </header>

      <p className="wallet" data-testid="wallet-status">
        wallet: <span className="mono">{wallet ? wallet.toBase58() : providerLabel(provider)}</span>
        {wallet ? null : <button type="button" data-testid="connect-wallet" onClick={connectWallet}>connect</button>}
      </p>

      {/* Errors are announced, and carry a word rather than relying on colour alone. */}
      {error ? <p className="error" role="alert" data-testid="error"><strong>Error:</strong> {error}</p> : null}
      {intentError ? <p className="warn" role="status" data-testid="intent-error-banner"><strong>Warning:</strong> {intentError}</p> : null}
      {busy ? <p className="busy" role="status" aria-live="polite">working…</p> : null}

      <main id="main" tabIndex={-1}>
        <p className="visually-hidden" aria-live="polite">
          Step {['prepare', 'compare', 'approve', 'intent'].indexOf(step) + 1} of 4: {step}
        </p>
      {step === 'prepare' ? (
        <Prepare deployment={deployment} scenarios={SCENARIOS} onPlan={runPlan} />
      ) : null}
      {step === 'prepare' ? <Explainer /> : null}
      {step === 'compare' && plan ? (
        <Compare plan={plan} onApprove={() => setStep('approve')} />
      ) : null}
      {step === 'approve' && plan && deployment && connection ? (
        <Approve
          deployment={deployment}
          plan={plan}
          connection={connection}
          provider={provider}
          wallet={wallet}
          onConnect={connectWallet}
          onFunded={async () => {
            await refreshIntents();
            setStep('intent');
          }}
        />
      ) : null}
      {step === 'intent' && deployment && connection ? (
        <Intent
          deployment={deployment}
          connection={connection}
          provider={provider}
          wallet={wallet}
          owned={owned}
          onRefresh={refreshIntents}
        />
      ) : null}
      </main>

      <footer>
        <small>
          No protocol fee. Rent is a recoverable deposit, not a cost. Settlement is atomic or it reverts.
          Everything here is devnet and synthetic test assets; there is no audit.
        </small>
      </footer>
    </div>
  );
}
