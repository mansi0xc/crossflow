import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

/**
 * Wallet boundary.
 *
 * The app talks to an injected provider only. Production use is Phantom; the test harness injects
 * a stub that signs with a local keypair, which is why the tests can drive the whole flow without
 * a browser extension. The app never receives or stores a private key.
 */
export interface InjectedProvider {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signTransaction?<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAndSendTransaction?(transaction: Transaction | VersionedTransaction): Promise<{ signature: string }>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window { solana?: InjectedProvider & { isPhantom?: boolean } }
}

export function detectProvider(): InjectedProvider | null {
  const injected = (globalThis as { solana?: InjectedProvider }).solana;
  if (injected && typeof injected.connect === 'function') return injected;
  return null;
}

export function providerLabel(provider: InjectedProvider | null): string {
  if (!provider) return 'no wallet detected — connect Phantom, or run the test harness';
  return provider.isPhantom ? 'Phantom' : 'injected wallet (test harness)';
}

export async function connect(provider: InjectedProvider): Promise<PublicKey> {
  const result = await provider.connect();
  const address = result?.publicKey?.toBase58() ?? provider.publicKey?.toBase58();
  if (!address) throw new Error('wallet did not return a public key');
  const key = new PublicKey(address);
  if (!PublicKey.isOnCurve(key.toBytes())) throw new Error('wallet address is not a signing key');
  return key;
}

export async function signAndSend(provider: InjectedProvider, connection: Connection, transaction: Transaction): Promise<string> {
  let signature: string;
  if (provider.signAndSendTransaction) {
    // Preferred: the wallet signs and submits, so the key never leaves it and there is one less
    // round trip. The app still reconciles the result against the chain below.
    signature = (await provider.signAndSendTransaction(transaction)).signature;
  } else if (provider.signTransaction) {
    const signed = await provider.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: 'confirmed', maxRetries: 3 });
  } else {
    throw new Error('wallet cannot sign or send transactions');
  }
  const latest = await connection.getLatestBlockhash('confirmed');
  const confirmation = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
  if (confirmation.value.err) throw new Error(`transaction failed on chain: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}

export function explorerLink(cluster: string, signature: string): string {
  const suffix = cluster === 'devnet' ? '?cluster=devnet' : '?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899';
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

/** Only used by the injected test stub; never referenced by the application path. */
export const __testOnly = { Keypair };
