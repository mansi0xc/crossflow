import { expect, test } from '@playwright/test';
import { installWallet, reachApproval, stubPrices, stubRpc, STUB_INTENT_ADDRESS } from './harness.js';

/**
 * T27 — the presentation must not hide a decision behind colour, a tooltip or a mouse.
 *
 * These are structural assertions rather than a screenshot comparison: contrast is computed from
 * the rendered colours, status is required to carry a word, and the whole path is walked with the
 * keyboard alone.
 */
test.describe('T27 accessibility and clarity', () => {
  test('the four steps are reachable and operable with the keyboard alone', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('cluster-label')).toBeVisible();

    // A skip link is the first thing focus reaches.
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();

    // Every step control is a real button, reachable and operable.
    for (const step of ['prepare', 'compare', 'approve', 'intent'] as const) {
      const button = page.getByTestId(`nav-${step}`);
      await expect(button).toHaveRole('button');
    }
    await page.getByTestId('scenario-opposite-01').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('comparison-table')).toBeVisible();
    await page.getByTestId('go-approve').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('approve')).toBeVisible();
  });

  test('status and errors carry text, not colour alone', async ({ page }) => {
    await page.route('**/plans', async route => route.fulfill({ status: 429, contentType: 'application/json',
      body: JSON.stringify({ status: 'REJECTED', reason: 'rate limit exceeded' }) }));
    await page.goto('/');
    await page.getByTestId('scenario-opposite-01').click();
    const error = page.getByTestId('error');
    await expect(error).toBeVisible();
    // The word "Error" is present, and the element is a live region so it is announced.
    await expect(error).toContainText('Error');
    expect(await error.getAttribute('role')).toBe('alert');
    await expect(page.getByTestId('cluster-label')).toContainText(/test assets only/i);
  });

  test('body text meets the WCAG AA contrast ratio', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('explainer')).toBeVisible();
    const ratios = await page.evaluate(() => {
      const luminance = (colour: string) => {
        const [r, g, b] = colour.match(/\d+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const backdrop = (element: Element): string => {
        let node: Element | null = element;
        while (node) {
          const colour = getComputedStyle(node).backgroundColor;
          if (colour && !/rgba?\(0, 0, 0, 0\)/.test(colour)) return colour;
          node = node.parentElement;
        }
        return 'rgb(255, 255, 255)';
      };
      return [...document.querySelectorAll('p, li, td, h1, h2, h3, label, button')].map(element => {
        const style = getComputedStyle(element);
        const front = luminance(style.color);
        const back = luminance(backdrop(element));
        const ratio = (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
        return { text: (element.textContent ?? '').trim().slice(0, 40), ratio: Number(ratio.toFixed(2)), size: parseFloat(style.fontSize) };
      });
    });
    const failures = ratios.filter(entry => entry.text.length > 0 && entry.ratio < (entry.size >= 24 ? 3 : 4.5));
    expect(failures, `low contrast: ${JSON.stringify(failures.slice(0, 5))}`).toEqual([]);
  });

  test('every input is labelled and no decision lives only in a tooltip', async ({ page }) => {
    const wallet = await installWallet(page, 51);
    await stubPrices(page);
    await stubRpc(page);
    await page.goto('/');
    await reachApproval(page);
    await page.getByTestId('connect-wallet').click();
    await expect(page.getByTestId('reference-prices')).toContainText('1000000');

    // Each numeric input has an accessible name, not just a placeholder.
    for (const index of [0, 1, 2]) {
      for (const prefix of ['funding', 'min', 'max']) {
        const input = page.getByLabel(`${prefix}-${index}`);
        await expect(input).toBeVisible();
        expect(await input.getAttribute('aria-label')).toBe(`${prefix}-${index}`);
      }
    }
    // Nothing critical is tooltip-only.
    expect(await page.locator('[title]').count()).toBe(0);
    const explanation = page.getByTestId('explainer');
    await page.getByTestId('nav-prepare').click();
    await expect(explanation).toContainText('Rent is a refundable deposit, not a fee');
    await expect(explanation).toContainText('not issuer-backed shares');
    await expect(explanation).toContainText('If any participant ends up worse');
    void wallet;
  });

  test('long values stay readable and the layout survives a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    const wallet = await installWallet(page, 52);
    await stubPrices(page);
    await stubRpc(page, { intents: [{ address: STUB_INTENT_ADDRESS, owner: wallet.publicKey,
      config: (await (await fetch('http://127.0.0.1:8787/deployment')).json()).config, nonce: '0', status: 0 }] });
    await page.goto('/');
    await page.getByTestId('connect-wallet').click();
    await page.getByTestId('nav-intent').click();

    const status = page.getByTestId(`status-${STUB_INTENT_ADDRESS}`);
    await expect(status).toHaveText('Funded');
    // A long address must not force a horizontal scrollbar.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    // The status still reads as a word at this width.
    await expect(page.getByTestId('intent')).toContainText('booked claims');
  });
});
