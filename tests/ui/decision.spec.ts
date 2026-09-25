import { expect, test } from '@playwright/test';
import { installWallet, stubPlan, stubPrices, stubRpc } from './harness.js';

/**
 * The interface must express the decision, in the trader's terms.
 *
 * A scenario id and a micro-USD total do not tell an operator what to do. These tests assert that
 * the recommendation is stated in plain language, that each account's alternative and proposed
 * outcome are shown, that a harmful batch is refused rather than presented, and that the raw units
 * and hashes are still available — folded away rather than removed.
 */
test.describe('the interface states the decision', () => {
  test('recommends crossing in plain language with a per-account outcome', async ({ page }) => {
    await stubPlan(page, { harmed: false });
    await page.goto('/');
    await page.getByTestId('scenario-opposite-01').click();

    const recommendation = page.getByTestId('recommendation');
    await expect(recommendation).toBeVisible();
    await expect(recommendation).toContainText('Cross these strategies');
    // Plain language: no scenario id, no micro-USD, no raw units in the headline.
    for (const jargon of ['micro-USD', 'raw', 'opposite-01', 'objective_micro', 'bps']) {
      await expect(recommendation).not.toContainText(jargon);
    }

    const table = page.getByTestId('per-owner-table');
    await expect(table).toContainText('alternative');
    await expect(table).toContainText('proposed');
    await expect(table).toContainText('$');
    // Each account says what it does, in words.
    await expect(table).toContainText('sells 4');
    await expect(table).toContainText('no trade');
    await expect(page.getByTestId('per-owner-definition')).toContainText('worse off means');

    // Raw units and hashes survive, but they are not the headline.
    await expect(page.getByTestId('comparison-table')).not.toBeVisible();
    await page.getByTestId('comparison-summary').click();
    await expect(page.getByTestId('comparison-table')).toBeVisible();
    await page.getByTestId('raw-summary').click();
    await expect(page.getByTestId('raw-units')).toContainText('opposite-01');
    void installWallet; void stubPrices; void stubRpc;
  });

  test('refuses a batch that would leave an account worse off', async ({ page }) => {
    await stubPlan(page, { harmed: true });
    await page.goto('/');
    await page.getByTestId('scenario-opposite-01').click();

    await expect(page.getByTestId('recommendation')).toContainText('Execute each strategy independently');
    const harmed = page.getByTestId('harmed-owners');
    await expect(harmed).toBeVisible();
    await expect(harmed).toContainText('worse off');
    // The declined reasons are shown, not hidden behind the fallback.
    await expect(page.getByTestId('declined-reasons')).toContainText('worse off than executing independently');
    // And approval is blocked rather than merely discouraged.
    await expect(page.getByTestId('go-approve')).toBeDisabled();
    await expect(page.getByTestId('compare')).toContainText('Approval is blocked because this batch would harm an account');
  });
});
