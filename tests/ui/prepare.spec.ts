import { expect, test } from '@playwright/test';

/**
 * T18 — a fresh user must be able to understand the selected slice and the escrow before locking
 * anything, and must be blocked with a specific reason when the input is not usable.
 */
test.describe('T18 prepare screen', () => {
  test('states the cluster, the test assets and the escrow terms before anything is funded', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('cluster-label')).toContainText('test assets only');
    await expect(page.getByTestId('cluster-label')).toContainText('TEST PRICES');
    await expect(page.getByTestId('deployment-identity')).toContainText('fixture (TEST PRICES)');
    await expect(page.getByTestId('portfolio-slice')).toContainText('not issuer-backed shares');
    await expect(page.getByTestId('prepare')).toContainText('not freely spendable');
    await expect(page.getByTestId('prepare')).toContainText('cancel at any time and withdraw each asset separately');
    // Connecting a wallet is explicitly not an authorization.
    await expect(page.getByTestId('prepare')).toContainText('Connecting a wallet is not an authorization');
  });

  test('the identity shown is the identity the service reported, not a hard-coded value', async ({ page }) => {
    await page.route('**/deployment', async route => {
      const response = await route.fetch();
      const body = await response.json();
      // A service that reported a different deployment must change what the page renders.
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ...body, cluster: 'devnet', config: 'So11111111111111111111111111111111111111112' }) });
    });
    await page.goto('/');
    await expect(page.getByTestId('cluster-label')).toContainText('DEVNET');
    await expect(page.getByTestId('deployment-identity')).toContainText('config So111111');
    await expect(page.getByTestId('deployment-identity')).toContainText('fixture (TEST PRICES)');
  });

  test('review and approval are gated on a comparison that actually exists', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('nav-compare')).toBeDisabled();
    await expect(page.getByTestId('nav-approve')).toBeDisabled();
    await expect(page.getByTestId('nav-intent')).toBeDisabled();
  });
});
