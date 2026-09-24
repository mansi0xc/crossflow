import { expect, test, type Page } from '@playwright/test';
import { Keypair, PublicKey } from '@solana/web3.js';

/**
 * Injected wallet stub.
 *
 * The application only ever talks to an injected provider, so a stub is enough to drive the whole
 * review-and-sign flow without a browser extension. It records every transaction it is asked to
 * sign; the tests then check the recorded bytes against what the page claimed on screen. The stub
 * never holds a funded key and never reaches a network.
 */
export interface StubWallet {
  publicKey: string;
  signed: number;
}

export async function installWallet(page: Page, seed = 42): Promise<StubWallet> {
  const keypair = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (seed + i) % 251 + 1));
  const publicKey = keypair.publicKey.toBase58();
  await page.addInitScript(({ address }) => {
    const state = { signed: 0, transactions: [] as string[] };
    (globalThis as unknown as { __wallet: typeof state }).__wallet = state;
    const provider = {
      isPhantom: false,
      publicKey: { toBase58: () => address },
      async connect() { return { publicKey: { toBase58: () => address } }; },
      async signTransaction(transaction: { serialize(config?: unknown): Uint8Array }) {
        state.signed += 1;
        state.transactions.push(Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'));
        return transaction;
      },
      async signAndSendTransaction(transaction: { serialize(config?: unknown): Uint8Array }) {
        state.signed += 1;
        state.transactions.push(Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'));
        return { signature: '4XR92Zct9ZodXzisJ4kov3upmTvMotYVrg65MHP8aoCjSPJwRzQ6rY2QeqpwzQQmuY5Fsm3QRFccAr8NaCQ4sha' };
      },
    };
    Object.defineProperty(globalThis, 'solana', { value: provider, configurable: true });
  }, { address: publicKey });
  return { publicKey, signed: 0 };
}

/** Read back the transactions the page asked the stub to sign. */
export async function signedTransactions(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as unknown as { __wallet: { transactions: string[] } }).__wallet.transactions);
}

/** Deterministic fixture prices so the approval flow can load them without a validator. */
export async function stubPrices(page: Page): Promise<void> {
  await page.route('**/price', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'OK',
        label: 'TEST PRICES; synthetic fixture oracle; no equity price claim',
        address: 'Sysvar1nstructions1111111111111111111111111',
        sequence: '1',
        marketClosed: false,
        assets: [
          { index: 0, price: '1000000', confidence: '0', feedId: '41'.repeat(32), publishedAt: '1000' },
          { index: 1, price: '10000000', confidence: '0', feedId: '42'.repeat(32), publishedAt: '1000' },
          { index: 2, price: '20000000', confidence: '0', feedId: '43'.repeat(32), publishedAt: '1000' },
        ],
      }),
    });
  });
}

export interface StubIntent { address: string; owner: string; config: string; nonce: string; status?: number }

/** A real base58 address; the app decodes whatever the stubbed chain returns. */
export const STUB_INTENT_ADDRESS = 'So11111111111111111111111111111111111111112';
export const STUB_OTHER_OWNER = 'SysvarRent111111111111111111111111111111111';
export interface StubRpcOptions { intents?: StubIntent[] }

const INTENT_DISCRIMINATOR = Buffer.from([0xf7, 0xa2, 0x23, 0xa5, 0xfe, 0x6f, 0x81, 0x6d]);

/** Build a real 522-byte Intent account so the app's own decoder is what reads it. */
export function encodeIntent(options: StubIntent): Buffer {
  const data = Buffer.alloc(522);
  INTENT_DISCRIMINATOR.copy(data, 0);
  new PublicKey(options.config).toBuffer().copy(data, 8);
  new PublicKey(options.owner).toBuffer().copy(data, 40);
  data.writeBigUInt64LE(BigInt(options.nonce), 72);
  data.writeBigUInt64LE(9_999_999_999n, 80);
  data.fill(0xab, 88, 120);
  data.fill(0xcd, 120, 152);
  data.fill(0xef, 152, 184);
  for (let index = 0; index < 3; index++) {
    data.writeBigUInt64LE(BigInt(10_000_000), 184 + index * 32);
    data.writeBigUInt64LE(0n, 192 + index * 32);
    data.writeBigUInt64LE(60_000_000n, 200 + index * 32);
    data.writeBigUInt64LE(1_000_000n, 208 + index * 32);
    data.writeBigUInt64LE(10_000_000n, 472 + index * 8);
  }
  data[520] = options.status ?? 0;
  data[521] = 1;
  return data;
}

/**
 * A minimal stand-in for the JSON-RPC endpoint. The tests assert what the page asked the wallet
 * to sign, so the chain is stubbed: a blockhash, a plausible signature, and the program accounts
 * the app scans for its own intents.
 */
const FAKE_SIGNATURE = '4XR92Zct9ZodXzisJ4kov3upmTvMotYVrg65MHP8aoCjSPJwRzQ6rY2QeqpwzQQmuY5Fsm3QRFccAr8NaCQ4sha';
export async function stubRpc(page: Page, options: StubRpcOptions = {}): Promise<void> {
  await page.route(/127\.0\.0\.1:8899/, async route => {
    let body: { id?: number; method?: string } = {};
    try { body = JSON.parse(route.request().postData() ?? '{}'); } catch { /* fall through */ }
    const respond = (result: unknown) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }) });
    switch (body.method) {
      case 'getLatestBlockhash':
        return respond({ context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1_000_000 } });
      case 'getBlockHeight':
        return respond(1_000);
      case 'getGenesisHash':
        return respond('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
      case 'sendTransaction':
      case 'sendRawTransaction':
        return respond(FAKE_SIGNATURE);
      case 'confirmTransaction':
        return respond({ context: { slot: 1 }, value: { err: null } });
      case 'getVersion':
        return respond({ 'solana-core': '3.1.10', 'feature-set': 0 });
      case 'getProgramAccounts':
        return respond((options.intents ?? []).map(intent => ({
          pubkey: intent.address,
          account: { owner: 'CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh', lamports: 1_000_000,
            data: [encodeIntent(intent).toString('base64'), 'base64'], executable: false, rentEpoch: 0 },
        })));
      default:
        return respond(null);
    }
  });
}

export async function reachApproval(page: Page): Promise<void> {
  await expect(page.getByTestId('cluster-label')).toContainText(/DEVNET|LOCALNET/);
  await page.getByTestId('scenario-opposite-01').click();
  await expect(page.getByTestId('comparison-table')).toBeVisible();
  await page.getByTestId('go-approve').click();
  await expect(page.getByTestId('approve')).toBeVisible();
}
