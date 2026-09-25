import { expect, test } from '@playwright/test';
import { Transaction } from '@solana/web3.js';
import { installWallet, reachApproval, signedTransactions, stubPrices, stubRpc } from './harness.js';

/**
 * T19/T20 — the same wallet must be able to rebalance more than once.
 *
 * Every funding consumes the owner's persistent nonce, so a client that sends nonce zero funds once
 * and then fails forever. This walks two consecutive fundings with the nonce the chain would report
 * after the first, which is the sequence an operator actually performs.
 */
test.describe('repeated funding with the same wallet', () => {
  async function fundOnce(page: import('@playwright/test').Page, ownerNonce: string) {
    // Each navigation re-runs the init script, so the recorded transactions are per page load.
    await page.goto('/');
    await reachApproval(page);
    await page.getByTestId('connect-wallet').click();
    await expect(page.getByTestId('nonce-line')).toContainText(`nonce ${ownerNonce}`);
    await expect(page.getByTestId('reference-prices')).toContainText('1000000');
    await expect(page.getByTestId('mandate-hash')).toContainText(/[0-9a-f]{24}/);
    const hash = (await page.getByTestId('mandate-hash').textContent())!;
    await page.getByTestId('affirm').check();
    await page.getByTestId('fund-button').click();
    await expect.poll(async () => (await signedTransactions(page)).length, { timeout: 20_000 }).toBeGreaterThan(0);
    return hash;
  }

  test('a second funding uses the next nonce and binds a different mandate', async ({ page }) => {
    const wallet = await installWallet(page, 71);
    await stubPrices(page);
    const deployment = await (await fetch('http://127.0.0.1:8787/deployment')).json();
    const base = { ownerConfig: deployment.config as string, ownerAddress: wallet.publicKey };

    await stubRpc(page, { ...base, ownerNonce: '0' });
    const firstHash = await fundOnce(page, '0');
    const [firstTransaction] = await signedTransactions(page);

    // The chain would now report nonce 1 for this owner; the second funding must use it.
    await stubRpc(page, { ...base, ownerNonce: '1' });
    const secondHash = await fundOnce(page, '1');
    const [secondTransaction] = await signedTransactions(page);

    // A different mandate, and a different transaction: the two fundings are not the same operation.
    expect(secondHash).not.toBe(firstHash);
    expect(secondTransaction).not.toBe(firstTransaction);
    for (const encoded of [firstTransaction, secondTransaction]) {
      const parsed = Transaction.from(Buffer.from(encoded, 'base64'));
      const instruction = parsed.instructions.find(candidate => candidate.programId.toBase58() === 'CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
      expect(instruction).toBeTruthy();
      expect(instruction!.data.subarray(0, 8)).toEqual(Buffer.from([0x51, 0xf1, 0x53, 0xb3, 0x13, 0xcb, 0xa7, 0x40]));
    }
    // The nonces actually signed differ by one, which is what makes the second funding possible.
    const nonceOf = (encoded: string) => Transaction.from(Buffer.from(encoded, 'base64'))
      .instructions.find(candidate => candidate.programId.toBase58() === 'CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh')!
      .data.subarray(8).readBigUInt64LE(33);
    expect(nonceOf(secondTransaction)).toBe(nonceOf(firstTransaction) + 1n);
  });

  test('funding is refused while an intent is already active', async ({ page }) => {
    const wallet = await installWallet(page, 72);
    await stubPrices(page);
    const deployment = await (await fetch('http://127.0.0.1:8787/deployment')).json();
    await stubRpc(page, { ownerNonce: '1', ownerConfig: deployment.config as string, ownerAddress: wallet.publicKey,
      ownerActiveIntent: 'So11111111111111111111111111111111111111112' });
    await page.goto('/');
    await reachApproval(page);
    await page.getByTestId('connect-wallet').click();
    await expect(page.getByTestId('nonce-line')).toContainText('nonce 1');
    await page.getByTestId('affirm').check();
    await page.getByTestId('fund-button').click();
    // One intent per owner at a time: the screen says so rather than letting the chain reject it.
    await expect(page.getByTestId('approve-error')).toContainText('already has an active intent');
    expect(await signedTransactions(page)).toHaveLength(0);
  });
});
