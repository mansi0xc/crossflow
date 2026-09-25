import { expect, test, type Page } from '@playwright/test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { policyBytes } from '../../packages/contracts/src/index.js';

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
export interface StubRpcOptions {
  intents?: StubIntent[];
  /** The owner's persistent nonce, as the chain would report it after previous fundings. */
  ownerNonce?: string;
  ownerConfig?: string;
  ownerAddress?: string;
  ownerActiveIntent?: string | null;
  /** When set, the stubbed chain also serves a Config account, which the offline path needs. */
  config?: { address: string; policy: Record<string, unknown>; deploymentId: string; policyHash: string };
}

/**
 * Build a real 831-byte Config account so the app's own decoder reads it. The offline recovery path
 * derives its identity from this account, so a stub returning nothing here would make the offline
 * test pass or fail for reasons unrelated to the behaviour under test.
 */
export function encodeConfig(options: { policy: Record<string, unknown>; deploymentId: string; policyHash: string }): Buffer {
  const data = Buffer.alloc(831);
  Buffer.from([0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82]).copy(data, 0);
  Buffer.from(options.deploymentId, 'hex').copy(data, 8);
  Buffer.from(options.policyHash, 'hex').copy(data, 104);
  Buffer.from(policyBytes(options.policy)).copy(data, 136);
  data[830] = 1;
  return data;
}

/** A real 114-byte OwnerState account, so the app reads the nonce the way it would on chain. */
export function encodeOwnerState(options: { config: string; owner: string; nextNonce: string; activeIntent?: string | null }): Buffer {
  const data = Buffer.alloc(114);
  Buffer.from([0xea, 0x38, 0x6b, 0xd8, 0x90, 0x34, 0x36, 0xf4]).copy(data, 0);
  new PublicKey(options.config).toBuffer().copy(data, 8);
  new PublicKey(options.owner).toBuffer().copy(data, 40);
  data.writeBigUInt64LE(BigInt(options.nextNonce), 72);
  if (options.activeIntent) {
    data[80] = 1;
    new PublicKey(options.activeIntent).toBuffer().copy(data, 81);
  }
  data[113] = 1;
  return data;
}

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
      case 'getAccountInfo': {
        // web3.js expects the `{ context, value }` envelope here, unlike getProgramAccounts.
        const account = (value: unknown) => respond({ context: { slot: 1 }, value });
        if (options.ownerNonce === undefined || !options.ownerConfig || !options.ownerAddress) return account(null);
        const [ownerState] = PublicKey.findProgramAddressSync(
          [Buffer.from('owner'), new PublicKey(options.ownerConfig).toBuffer(), new PublicKey(options.ownerAddress).toBuffer()],
          new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh'));
        const requested = route.request().postDataJSON()?.params?.[0];
        if (requested !== ownerState.toBase58()) return account(null);
        return account({ owner: 'CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh', lamports: 2_000_000,
          data: [encodeOwnerState({ config: options.ownerConfig, owner: options.ownerAddress,
            nextNonce: options.ownerNonce, activeIntent: options.ownerActiveIntent }).toString('base64'), 'base64'],
          executable: false, rentEpoch: 0 });
      }
      case 'getGenesisHash':
        return respond('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
      case 'sendTransaction':
      case 'sendRawTransaction':
        return respond(FAKE_SIGNATURE);
      case 'confirmTransaction':
        return respond({ context: { slot: 1 }, value: { err: null } });
      case 'getVersion':
        return respond({ 'solana-core': '3.1.10', 'feature-set': 0 });
      case 'getProgramAccounts': {
        // The app asks for two different account types by data size; the stub must answer both or
        // the offline path silently finds nothing.
        const filters = (route.request().postDataJSON()?.params?.[1]?.filters ?? []) as { dataSize?: number }[];
        const size = filters[0]?.dataSize;
        if (size === 831) {
          if (!options.config) return respond([]);
          return respond([{ pubkey: options.config.address,
            account: { owner: 'CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh', lamports: 6_000_000,
              data: [encodeConfig(options.config).toString('base64'), 'base64'], executable: false, rentEpoch: 0 } }]);
        }
        return respond((options.intents ?? []).map(intent => ({
          pubkey: intent.address,
          account: { owner: 'CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh', lamports: 1_000_000,
            data: [encodeIntent(intent).toString('base64'), 'base64'], executable: false, rentEpoch: 0 },
        })));
      }
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
