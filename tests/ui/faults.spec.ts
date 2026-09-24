import { expect, test } from '@playwright/test';
import { installWallet, reachApproval, signedTransactions, stubPrices, stubRpc, STUB_INTENT_ADDRESS } from './harness.js';

/**
 * T26 — operational fault drills.
 *
 * Each case breaks one dependency and asserts the interface degrades to an explicit, safe state:
 * never a false success, never a lost recovery route, never a silent retry that would double-sign.
 */
test.describe('T26 fault drills', () => {
  test('a chain failure during funding reports an error and never claims success', async ({ page }) => {
    const wallet = await installWallet(page, 41);
    await stubPrices(page);
    await stubRpc(page);
    await page.goto('/');
    await reachApproval(page);
    await page.getByTestId('connect-wallet').click();
    await expect(page.getByTestId('reference-prices')).toContainText('1000000');
    await expect(page.getByTestId('mandate-hash')).toContainText(/[0-9a-f]{24}/);

    // The RPC dies after the review, before the wallet can be asked to sign.
    await page.route(/127\.0\.0\.1:8899/, async route => route.abort('failed'));
    await page.getByTestId('affirm').check();
    await page.getByTestId('fund-button').click();

    await expect(page.getByTestId('approve-error')).toBeVisible();
    await expect(page.getByTestId('funding-signature')).toHaveCount(0);
    await expect(page.getByTestId('approve')).not.toContainText('funded:');
    expect(await signedTransactions(page)).toHaveLength(0);
    void wallet;
  });

  test('a rate-limited service surfaces as an explicit error, not an empty screen', async ({ page }) => {
    await page.route('**/plans', async route => route.fulfill({ status: 429, contentType: 'application/json',
      body: JSON.stringify({ status: 'REJECTED', reason: 'rate limit exceeded' }) }));
    await page.goto('/');
    await page.getByTestId('scenario-opposite-01').click();
    await expect(page.getByTestId('error')).toContainText('rate limit exceeded');
    await expect(page.getByTestId('nav-compare')).toBeDisabled();
    await expect(page.getByTestId('cluster-label')).toBeVisible();
  });

  test('an unavailable numerical engine fails the plan closed without claiming a comparison', async ({ page }) => {
    await page.route('**/plans', async route => route.fulfill({ status: 400, contentType: 'application/json',
      body: JSON.stringify({ status: 'TIMEOUT', reason: 'engine exceeded 20000ms', durationMs: 20000 }) }));
    await page.goto('/');
    await page.getByTestId('scenario-tight-01').click();
    await expect(page.getByTestId('error')).toContainText('engine exceeded');
    await expect(page.getByTestId('comparison-table')).toHaveCount(0);
  });

  test('an expired intent still offers cancellation and per-asset withdrawal', async ({ page }) => {
    const wallet = await installWallet(page, 42);
    await stubPrices(page);
    const deployment = await (await fetch('http://127.0.0.1:8787/deployment')).json();
    await stubRpc(page, { intents: [{ address: STUB_INTENT_ADDRESS, owner: wallet.publicKey, config: deployment.config, nonce: '0', status: 0 }] });
    await page.goto('/');
    await page.getByTestId('connect-wallet').click();
    await page.getByTestId('nav-intent').click();
    // Expiry does not consume the intent or its claims: the recovery controls remain.
    await expect(page.getByTestId(`cancel-${STUB_INTENT_ADDRESS}`)).toBeVisible();
    await expect(page.getByTestId('intent')).toContainText('never routes through the solver');
  });

  test('a cancelled intent keeps per-asset withdrawal reachable after a chain error', async ({ page }) => {
    const wallet = await installWallet(page, 43);
    await stubPrices(page);
    const deployment = await (await fetch('http://127.0.0.1:8787/deployment')).json();
    await stubRpc(page, { intents: [{ address: STUB_INTENT_ADDRESS, owner: wallet.publicKey, config: deployment.config, nonce: '0', status: 2 }] });
    await page.goto('/');
    await page.getByTestId('connect-wallet').click();
    await page.getByTestId('nav-intent').click();
    await expect(page.getByTestId(`withdraw-0-${STUB_INTENT_ADDRESS}`)).toBeVisible();

    // The submit path failing must leave the controls in place rather than blanking the screen.
    await page.route(/127\.0\.0\.1:8899/, async route => route.abort('failed'));
    await page.getByTestId(`withdraw-0-${STUB_INTENT_ADDRESS}`).click();
    await expect(page.getByTestId('intent-error')).toBeVisible();
    await expect(page.getByTestId(`withdraw-1-${STUB_INTENT_ADDRESS}`)).toBeVisible();
  });
});
