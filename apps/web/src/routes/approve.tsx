import { useEffect, useMemo, useState } from 'react';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { buildCreateAndFundInstruction, deriveFundAccounts, fundingTransaction } from '../../../../packages/client/src/fund.js';
import { mandateBytes, sha256Hex } from '../../../../packages/contracts/src/index.js';
import { api, type Deployment, type PlanResponse } from '../api.js';
import { readOwnerNextNonce } from '../../../../packages/client/src/intents.js';
import { connect, signAndSend, type InjectedProvider } from '../wallet.js';
import { planDecision } from '../decision.js';

/**
 * Step 3 — approve the exact mandate.
 *
 * The values rendered here are the values that go into the transaction; the mandate hash shown is
 * recomputed from those same bytes, so a display/signature mismatch is visible rather than silent.
 */
export function Approve({ deployment, plan, connection, provider, wallet, onConnect, onFunded }: {
  deployment: Deployment;
  plan: PlanResponse;
  connection: Connection;
  provider: InjectedProvider | null;
  wallet: PublicKey | null;
  onConnect: () => Promise<void>;
  onFunded: (signature: string, intentAddress: string) => Promise<unknown>;
}) {
  const program = useMemo(() => new PublicKey(deployment.programId), [deployment.programId]);
  const config = useMemo(() => new PublicKey(deployment.config), [deployment.config]);
  const prices = useMemo(() => PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], program)[0], [config, program]);
  const mints = useMemo(() => deployment.assets.map(asset => new PublicKey(Buffer.from(asset.mint, 'hex'))), [deployment.assets]);

  const [funding, setFunding] = useState(['10000000', '4000000', '0']);
  const [bounds, setBounds] = useState([
    { min: '0', max: '60000000' },
    { min: '0', max: '4000000' },
    { min: '0', max: '0' },
  ]);
  const [referencePrices, setReferencePrices] = useState<string[] | null>(null);
  // The owner's nonce advances with every funding, so it must come from chain: a hard-coded zero
  // funds once and then fails for the same wallet.
  const [nonce, setNonce] = useState<bigint | null>(null);
  const [activeIntent, setActiveIntent] = useState<string | null>(null);
  const [affirmed, setAffirmed] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The funding reference price must equal the authenticated snapshot exactly, so it is read from
  // the service rather than typed by the user.
  useEffect(() => {
    api.price().then(snapshot => setReferencePrices(snapshot.assets.map(asset => asset.price)))
      .catch(reason => setError(String(reason.message ?? reason)));
  }, []);

  // The nonce comes from the owner's account on chain, so a wallet can fund repeatedly. A hard-coded
  // zero funds once and then fails for the same wallet.
  useEffect(() => {
    if (!wallet) { setNonce(null); setActiveIntent(null); return; }
    let cancelled = false;
    readOwnerNextNonce(connection, program, config, wallet)
      .then(state => { if (!cancelled) { setNonce(state.nonce); setActiveIntent(state.activeIntent); } })
      .catch(reason => { if (!cancelled) setError(`could not read the owner nonce: ${String(reason.message ?? reason)}`); });
    return () => { cancelled = true; };
  }, [wallet, connection, program, config]);

  // Computed once so the expiry that is displayed is the expiry that is signed.
  const [expiry] = useState(() => BigInt(Math.floor(Date.now() / 1000) + 890));
  const [commitment, setCommitment] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    sha256Hex(new TextEncoder().encode(JSON.stringify({ scenario: plan.scenario_id, funding, bounds })))
      .then(digest => { if (!cancelled) setCommitment(digest); })
      .catch(reason => { if (!cancelled) setError(`could not compute the optimization commitment: ${String(reason.message ?? reason)}`); });
    return () => { cancelled = true; };
  }, [plan.scenario_id, funding, bounds]);

  const mandate = useMemo(() => {
    if (!wallet) return null;
    const accounts = deriveFundAccounts(program, config, prices, wallet, nonce ?? 0n, mints);
    return {
      accounts,
      assets: deployment.assets.map((asset, index) => ({
        mint: asset.mint, token_program: asset.tokenProgram, decimals: String(asset.decimals),
        recipient_ata: accounts.sources[index].toBuffer().toString('hex'),
        funding: funding[index], min_output: bounds[index].min, max_output: bounds[index].max,
        funding_reference_price: referencePrices?.[index] ?? '0',
      })),
    };
  }, [wallet, program, config, prices, mints, deployment, funding, bounds, referencePrices, nonce]);

  // The funding handler re-checks the same selected decision as every other gate: reaching this
  // screen by a path that skipped the compare screen cannot fund a harmful or non-executable batch.
  const decision = useMemo(() => planDecision(plan), [plan]);

  const [mandateHash, setMandateHash] = useState<string | null>(null);
  useEffect(() => {
    // Every field must be resolved before the canonical bytes can be built; building them early
    // would throw during commit and blank the page.
    if (!mandate || !wallet || !commitment || !referencePrices) { setMandateHash(null); return; }
    let cancelled = false;
    // Every identity in the canonical mandate is 32-byte hex. The service also exposes base58
    // forms for display and for RPC use, and the two are not interchangeable.
    const canonical = deployment.policy as { genesis: string; program_id: string; config_address: string };
    // The hash is recomputed from the same bytes the transaction carries, so the display and the
    // signed mandate cannot drift apart silently.
    Promise.resolve().then(() => mandateBytes({
      genesis: canonical.genesis, program_id: canonical.program_id, config_address: canonical.config_address,
      schema_version: '1', policy_hash: deployment.policyHash, owner: wallet.toBuffer().toString('hex'),
      nonce: (nonce ?? 0n).toString(), expiry_unix_seconds: expiry.toString(), optimization_commitment: commitment,
      assets: mandate.assets,
    }))
      .then(bytes => sha256Hex(bytes))
      .then(digest => { if (!cancelled) setMandateHash(digest); })
      .catch(reason => { if (!cancelled) setError(String(reason.message ?? reason)); });
    return () => { cancelled = true; };
  }, [mandate, wallet, deployment, expiry, commitment, referencePrices]);

  const fund = async () => {
    setError(null);
    // Enforcement at the execution boundary: the wallet is never asked to sign when the selected
    // decision is ineligible, regardless of how this screen was reached.
    if (!decision.eligible) { setError(`funding refused: ${decision.reason ?? 'the selected decision is not eligible'}`); return; }
    if (!wallet || !mandate || !commitment) { await onConnect(); return; }
    if (activeIntent) { setError(`this wallet already has an active intent (${activeIntent.slice(0, 12)}…). Cancel it before funding another.`); return; }
    if (!affirmed) { setError('Confirm that the raw units shown are the ones you intend to sign.'); return; }
    if (!referencePrices) { setError('the authenticated fixture prices have not loaded yet'); return; }
    setBusy(true);
    try {
      const instruction = buildCreateAndFundInstruction(program, wallet, mandate.accounts, {
        expected_policy_hash: deployment.policyHash, nonce: (nonce ?? 0n).toString(), expiry_unix_seconds: expiry.toString(),
        optimization_commitment: commitment,
        assets: funding.map((amount, index) => ({
          funding: amount,
          min_output: bounds[index].min,
          max_output: bounds[index].max,
          funding_reference_price: referencePrices[index],
        })),
      });
      const transaction = fundingTransaction(instruction);
      transaction.feePayer = wallet;
      transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      const sent = await signAndSend(provider!, connection, transaction);
      setSignature(sent);
      await onFunded(sent, mandate.accounts.intent.toBase58());
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally { setBusy(false); }
  };

  const METHOD_LABEL: Record<string, string> = {
    A: 'each strategy on its own',
    B: 'cross the parts that cancel and trade the rest',
    C: 'cross, and adjust the targets together',
  };

  return (
    <section data-testid="approve">
      <h2>3 · Approve the exact mandate</h2>
      <p className="note" data-testid="selected-method">
        Selected method: {decision.method ? `${decision.method} — ${METHOD_LABEL[decision.method]}` : 'none'}.
        {!decision.eligible ? ` Funding is blocked because ${decision.reason ?? 'the selected decision is not eligible'}.` : ''}
      </p>
      <p className="note" data-testid="nonce-line">
        Funding this will consume nonce {nonce === null ? '…' : nonce.toString()} — the next one for this
        wallet, read from the chain. Expiry {expiry.toString()} (unix seconds, within the policy maximum of {deployment.maxIntentLifetimeSeconds}).
        The raw units below are what the program stores and enforces.
      </p>

      <table data-testid="mandate-table">
        <thead><tr><th>asset</th><th>funding (raw)</th><th>min output</th><th>max output</th></tr></thead>
        <tbody>
          {deployment.assets.map((asset, index) => (
            <tr key={asset.mint}>
              <td>{index}</td>
              <td><input aria-label={`funding-${index}`} value={funding[index]}
                onChange={event => setFunding(previous => previous.map((value, i) => i === index ? event.target.value : value))} /></td>
              <td><input aria-label={`min-${index}`} value={bounds[index].min}
                onChange={event => setBounds(previous => previous.map((value, i) => i === index ? { ...value, min: event.target.value } : value))} /></td>
              <td><input aria-label={`max-${index}`} value={bounds[index].max}
                onChange={event => setBounds(previous => previous.map((value, i) => i === index ? { ...value, max: event.target.value } : value))} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="note" data-testid="reference-prices">
        funding reference prices (from the labelled fixture snapshot): {referencePrices ? referencePrices.join(' / ') : 'loading…'}
      </p>
      <p data-testid="mandate-hash">mandate hash {mandateHash ? `${mandateHash.slice(0, 24)}…` : 'connect a wallet to compute'}</p>
      <label>
        <input type="checkbox" checked={affirmed} onChange={event => setAffirmed(event.target.checked)} data-testid="affirm" />
        {' '}I have reviewed these raw-unit bounds and will sign exactly this mandate.
      </label>

      <div className="actions">
        <button onClick={fund} disabled={busy || !decision.eligible} data-testid="fund-button">
          {wallet ? 'Sign and fund' : 'Connect wallet'}
        </button>
      </div>

      {error ? <p className="error" data-testid="approve-error">{error}</p> : null}
      {signature ? <p className="ok" data-testid="funding-signature">funded: {signature}</p> : null}
    </section>
  );
}
