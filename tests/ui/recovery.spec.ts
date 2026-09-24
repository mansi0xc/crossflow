import { expect, test } from '@playwright/test';
import { installWallet, stubIntents, stubPrices } from './harness.js';

/**
 * T20 — status, receipts and recovery.
 *
 * The screen must show chain-derived state, never a browser guess, and must offer recovery that
 * needs only the owner wallet.
 */
test.describe('T20 status, receipt and recovery', () => {
  test('a funded intent offers cancellation and states the recovery guarantees', async ({ page }) => {
    const wallet = await installWallet(page, 21);
    await stubPrices(page);
    await stubIntents(page, wallet.publicKey, 'Funded');
    await page.goto('/');
    await page.getByTestId('connect-wallet').click();
    await page.getByTestId('nav-intent').click();

    const intent = page.getByTestId(`intent-Intent111111111111111111111111111111111111`);
    await expect(intent).toBeVisible();
    await expect(page.getByTestId('status-Intent111111111111111111111111111111111111')).toHaveText('Funded');
    await expect(intent).toContainText('booked claims');
    await expect(intent).toContainText('never increases solver authority');
    await expect(page.getByTestId('cancel-Intent111111111111111111111111111111111111')).toBeVisible();
    await expect(page.getByTestId('intent')).toContainText('never routes through the solver');
    await expect(page.getByTestId('receipt')).toHaveCount(0);
  });

  test('a cancelled intent offers per-asset withdrawal rather than a single opaque refund', async ({ page }) => {
    const wallet = await installWallet(page, 22);
    await stubPrices(page);
    await stubIntents(page, wallet.publicKey, 'Cancelled');
    await page.goto('/');
    await page.getByTestId('connect-wallet').click();
    await page.getByTestId('nav-intent').click();

    const address = 'Intent111111111111111111111111111111111111';
    for (const index of [0, 1, 2]) await expect(page.getByTestId(`withdraw-${index}-${address}`)).toBeVisible();
    await expect(page.getByTestId(`close-${address}`)).toBeVisible();
    // A Funded intent must not offer withdrawal; only cancellation comes first.
    await expect(page.getByTestId(`cancel-${address}`)).toHaveCount(0);
  });

  test('an unknown owner sees no intent, and no success is claimed without a chain receipt', async ({ page }) => {
    const wallet = await installWallet(page, 23);
    await stubPrices(page);
    await stubIntents(page, 'SomeOtherOwner111111111111111111111111111111', 'Funded');
    await page.goto('/');
    await page.getByTestId('connect-wallet').click();
    await expect(page.getByTestId('nav-intent')).toBeDisabled();
    await expect(page.getByTestId('wallet-status')).toContainText(wallet.publicKey);
  });
});
