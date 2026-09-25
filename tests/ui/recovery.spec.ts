import { expect, test } from '@playwright/test';
import { installWallet, stubPrices, stubRpc, STUB_INTENT_ADDRESS, STUB_OTHER_OWNER } from './harness.js';

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
    await stubRpc(page, { intents: [{ address: STUB_INTENT_ADDRESS, owner: wallet.publicKey,
      config: (await (await fetch('http://127.0.0.1:8787/deployment')).json()).config, nonce: '0', status: 0 }] });
    await page.goto('/');
    await page.getByTestId('connect-wallet').click();
    await page.getByTestId('nav-intent').click();

    const intent = page.getByTestId(`intent-${STUB_INTENT_ADDRESS}`);
    await expect(intent).toBeVisible();
    await expect(page.getByTestId(`status-${STUB_INTENT_ADDRESS}`)).toHaveText('Funded');
    await expect(intent).toContainText('booked claims');
    await expect(intent).toContainText('never increases solver authority');
    await expect(page.getByTestId(`cancel-${STUB_INTENT_ADDRESS}`)).toBeVisible();
    await expect(page.getByTestId('intent')).toContainText('never routes through the solver');
    await expect(page.getByTestId('receipt')).toHaveCount(0);
  });

  test('a cancelled intent offers per-asset withdrawal rather than a single opaque refund', async ({ page }) => {
    const wallet = await installWallet(page, 22);
    await stubPrices(page);
    await stubRpc(page, { intents: [{ address: STUB_INTENT_ADDRESS, owner: wallet.publicKey,
      config: (await (await fetch('http://127.0.0.1:8787/deployment')).json()).config, nonce: '0', status: 2 }] });
    await page.goto('/');
    await page.getByTestId('connect-wallet').click();
    await page.getByTestId('nav-intent').click();

    for (const index of [0, 1, 2]) await expect(page.getByTestId(`withdraw-${index}-${STUB_INTENT_ADDRESS}`)).toBeVisible();
    await expect(page.getByTestId(`close-${STUB_INTENT_ADDRESS}`)).toBeVisible();
    // A Funded intent must not offer withdrawal; only cancellation comes first.
    await expect(page.getByTestId(`cancel-${STUB_INTENT_ADDRESS}`)).toHaveCount(0);
  });

  test('recovery stays reachable with no intents, and no success is claimed without a receipt', async ({ page }) => {
    const wallet = await installWallet(page, 23);
    await stubPrices(page);
    await stubRpc(page, { intents: [{ address: STUB_INTENT_ADDRESS, owner: STUB_OTHER_OWNER,
      config: (await (await fetch('http://127.0.0.1:8787/deployment')).json()).config, nonce: '0', status: 0 }] });
    await page.goto('/');
    await page.getByTestId('connect-wallet').click();
    await expect(page.getByTestId('wallet-status')).toContainText(wallet.publicKey);

    // The recovery route is never gated on discovery: a wallet can always reach its own intents,
    // which is what makes recovery work when the service is unavailable.
    await expect(page.getByTestId('nav-intent')).toBeEnabled();
    await page.getByTestId('nav-intent').click();
    await expect(page.getByTestId('intent')).toContainText('No funded intent for this wallet yet');
    // Somebody else's intent must not be adopted.
    await expect(page.getByTestId(`intent-${STUB_INTENT_ADDRESS}`)).toHaveCount(0);
    await expect(page.getByTestId('receipt')).toHaveCount(0);
  });

  test('recovery works with the service entirely offline', async ({ page }) => {
    const wallet = await installWallet(page, 24);
    // Every service endpoint fails; only the chain is reachable. The pattern is a regex because a
    // glob like `**/8787/**` matches nothing here, which silently made this test vacuous.
    let intercepted = 0;
    await page.route(/127\.0\.0\.1:8787/, async route => {
      intercepted += 1;
      await route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ status: 'REJECTED', reason: 'service unavailable' }) });
    });
    // The Config account is served by the stubbed chain, because with the service down the identity
    // can only come from the cluster.
    const deployment = await (await fetch('http://127.0.0.1:8787/deployment')).json();
    const policyHash = deployment.policyHash as string;
    await stubRpc(page, {
      config: { address: deployment.config, policy: deployment.policy, deploymentId: deployment.deploymentId, policyHash },
      intents: [{ address: STUB_INTENT_ADDRESS, owner: wallet.publicKey, config: deployment.config, nonce: '0', status: 0 }],
    });
    await page.goto('/');
    // The service identity must fail: the app has to fall back to the chain.
    await expect(page.getByTestId('identity-source')).toContainText('the cluster');
    await page.getByTestId('connect-wallet').click();

    // The recovery route must not depend on the service: this is the finding that forced the
    // intent scan to move to the chain.
    await expect(page.getByTestId('nav-intent')).toBeEnabled();
    await page.getByTestId('nav-intent').click();
    await expect(page.getByTestId(`status-${STUB_INTENT_ADDRESS}`)).toHaveText('Funded');
    await expect(page.getByTestId(`cancel-${STUB_INTENT_ADDRESS}`)).toBeVisible();
    // The test is only meaningful if the service really was unreachable.
    expect(intercepted, 'the service was never intercepted, so this proves nothing').toBeGreaterThan(0);
  });
});
