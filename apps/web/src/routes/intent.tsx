import { useState } from 'react';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { buildCancelIntentInstruction, buildCloseIntentInstruction, buildWithdrawAssetInstruction, deriveRecoveryAccounts } from '../../../../packages/client/src/recover.js';
import type { Deployment, IntentSummary } from '../api.js';
import { explorerLink, signAndSend, type InjectedProvider } from '../wallet.js';

/**
 * Step 4 — status, receipt and recovery.
 *
 * Every state shown is read from chain; a browser timeout is never presented as a failure or a
 * success. Recovery needs only the owner wallet, so it works with the solver and the oracle
 * offline.
 */
export function Intent({ deployment, connection, provider, wallet, owned, onRefresh }: {
  deployment: Deployment;
  connection: Connection;
  provider: InjectedProvider | null;
  wallet: PublicKey | null;
  owned: IntentSummary[];
  onRefresh: () => Promise<void>;
}) {
  const program = new PublicKey(deployment.programId);
  const config = new PublicKey(deployment.config);
  const prices = PublicKey.findProgramAddressSync([Buffer.from('prices'), config.toBuffer()], program)[0];
  const mints = deployment.assets.map(asset => new PublicKey(Buffer.from(asset.mint, 'hex')));
  const [signatures, setSignatures] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (intent: IntentSummary, action: 'cancel' | 'withdraw' | 'close', assetIndex = 0) => {
    if (!wallet || !provider) { setError('connect the owner wallet first'); return; }
    setBusy(true); setError(null);
    try {
      const accounts = deriveRecoveryAccounts(program, config, prices, wallet, BigInt(intent.nonce), mints);
      const instruction = action === 'cancel'
        ? buildCancelIntentInstruction(program, wallet, accounts)
        : action === 'withdraw'
          ? buildWithdrawAssetInstruction(program, wallet, accounts, assetIndex)
          : buildCloseIntentInstruction(program, wallet, accounts);
      const transaction = new Transaction().add(instruction);
      transaction.feePayer = wallet;
      transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      const signature = await signAndSend(provider, connection, transaction);
      setSignatures(previous => [signature, ...previous]);
      await onRefresh();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally { setBusy(false); }
  };

  return (
    <section data-testid="intent">
      <h2>4 · Status, receipt and recovery</h2>
      {owned.length === 0 ? <p>No funded intent for this wallet yet.</p> : null}
      <ul className="intents">
        {owned.map(intent => (
          <li key={intent.address} data-testid={`intent-${intent.address}`}>
            <p>
              intent <code>{intent.address.slice(0, 16)}…</code> · nonce {intent.nonce} ·{' '}
              <strong data-testid={`status-${intent.address}`}>{intent.status}</strong>
            </p>
            <p className="note">
              booked claims {intent.bookedClaims.join(' / ')} · unsolicited surplus {intent.initialSurplus.join(' / ')}
              {' '}(surplus belongs to the owner and never increases solver authority)
            </p>
            <div className="actions">
              {intent.status === 'Funded' ? (
                <button data-testid={`cancel-${intent.address}`} onClick={() => act(intent, 'cancel')} disabled={busy}>cancel</button>
              ) : null}
              {intent.status !== 'Funded' ? (
                <>
                  {[0, 1, 2].map(index => (
                    <button key={index} data-testid={`withdraw-${index}-${intent.address}`}
                      onClick={() => act(intent, 'withdraw', index)} disabled={busy}>withdraw asset {index}</button>
                  ))}
                  <button data-testid={`close-${intent.address}`} onClick={() => act(intent, 'close')} disabled={busy}>close and recover rent</button>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {error ? <p className="error" data-testid="intent-error">{error}</p> : null}
      {signatures.length ? (
        <div data-testid="receipt">
          <h3>Receipt</h3>
          <ul>
            {signatures.map(signature => (
              <li key={signature}><a href={explorerLink(deployment.cluster, signature)} target="_blank" rel="noreferrer">{signature.slice(0, 24)}…</a></li>
            ))}
          </ul>
          <p className="note">Balances above are read from chain, not from browser memory.</p>
        </div>
      ) : null}
      <p className="note">
        Recovery needs only this wallet and the chain. It works while funding and settlement are
        paused, and it never routes through the solver.
      </p>
    </section>
  );
}

/** Only used by tests to build recovery accounts for a keypair-backed stub wallet. */
export const __testOnly = { Keypair };
