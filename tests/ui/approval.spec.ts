import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { mandateBytes, policyBytes, sha256Hex } from '../../packages/contracts/src/index.js';
import { installWallet, reachApproval, signedTransactions, stubPrices, stubRpc } from './harness.js';

const CROSSFLOW = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');
const fundDiscriminator = Buffer.from([0x51, 0xf1, 0x53, 0xb3, 0x13, 0xcb, 0xa7, 0x40]);

/**
 * T19 — the approval screen must render the exact executable mandate, and the bytes the wallet is
 * asked to sign must match what was on screen. Nothing here needs a validator: the assertion is
 * between the rendered value and the recorded transaction.
 */
test.describe('T19 compare and approve', () => {
  test('the three approaches are compared under identical constraints, with negatives shown', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('scenario-all-buy-01').click();
    // The headline is a decision, not a table of totals.
    await expect(page.getByTestId('recommendation')).toBeVisible();
    await page.getByTestId('comparison-summary').click();
    await expect(page.getByTestId('comparison-table')).toBeVisible();
    for (const method of ['A', 'B', 'C']) await expect(page.getByTestId(`proposal-${method}`)).toBeVisible();
    // A method that cannot be executed is named as such rather than silently omitted.
    const rows = await page.getByTestId('comparison-table').innerText();
    expect(rows).toMatch(/yes|no —/);
    // The totals are modelled, not realized, and say so.
    await expect(page.getByTestId('comparison-details')).toContainText('not realized fills');
  });

  test('the signed funding instruction carries exactly the mandate the page displayed', async ({ page }) => {
    const wallet = await installWallet(page, 7);
    await stubPrices(page);
    await stubRpc(page);
    await page.goto('/');
    await reachApproval(page);

    await page.getByTestId('connect-wallet').click();
    await expect(page.getByTestId('wallet-status')).toContainText(wallet.publicKey);
    await expect(page.getByTestId('reference-prices')).toContainText('1000000');

    // The hash is computed asynchronously from the canonical bytes, so wait for it.
    await expect(page.getByTestId('mandate-hash')).toContainText(/[0-9a-f]{24}/);
    const displayedHash = (await page.getByTestId('mandate-hash').textContent())!.replace('mandate hash ', '').replace('…', '');
    expect(displayedHash).toMatch(/^[0-9a-f]{24}$/);

    await page.getByTestId('fund-button').click();
    // Without the explicit affirmation the wallet must never be asked to sign.
    await expect(page.getByTestId('approve-error')).toContainText('Confirm that the raw units');
    expect(await signedTransactions(page)).toHaveLength(0);

    await expect(page.getByTestId('reference-prices')).toContainText('1000000');
    await page.getByTestId('affirm').check();
    await page.getByTestId('fund-button').click();
    // `allTextContents` does not wait for a missing element, unlike `textContent`.
    const failures = await page.getByTestId('approve-error').allTextContents();
    expect(failures.join(' '), 'funding must not fail before reaching the wallet').toBe('');
    await expect.poll(async () => (await signedTransactions(page)).length, { timeout: 20_000 }).toBeGreaterThan(0);

    const [encoded] = await signedTransactions(page);
    const transaction = Transaction.from(Buffer.from(encoded, 'base64'));
    const instruction = transaction.instructions.find((candidate: TransactionInstruction) => candidate.programId.equals(CROSSFLOW));
    expect(instruction).toBeTruthy();
    expect(instruction!.data.subarray(0, 8)).toEqual(fundDiscriminator);
    // Anchor encodes the body as a fixed 177 bytes after the discriminator, with no padding.
    expect(instruction!.data.length).toBe(8 + 177);
    expect(transaction.feePayer?.toBase58()).toBe(wallet.publicKey);
    expect(instruction!.keys[0].pubkey.toBase58()).toBe(wallet.publicKey);
    expect(instruction!.keys[0].isSigner).toBe(true);
  });

  test('the displayed mandate hash is the hash of the signed instruction payload', async ({ page }) => {
    const wallet = await installWallet(page, 11);
    await stubPrices(page);
    await stubRpc(page);
    await page.goto('/');
    await reachApproval(page);
    await page.getByTestId('connect-wallet').click();
    await expect(page.getByTestId('reference-prices')).toContainText('1000000');
    await expect(page.getByTestId('mandate-hash')).toContainText(/[0-9a-f]{24}/);
    await page.getByTestId('affirm').check();
    await page.getByTestId('fund-button').click();
    await expect.poll(async () => (await signedTransactions(page)).length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    const [encoded] = await signedTransactions(page);
    const transaction = Transaction.from(Buffer.from(encoded, 'base64'));
    const instruction = transaction.instructions.find((candidate: TransactionInstruction) => candidate.programId.equals(CROSSFLOW))!;
    const body = instruction.data.subarray(8);

    // Rebuild the canonical mandate from the signed payload alone, exactly as the program does.
    const deployment = await (await fetch('http://127.0.0.1:8787/deployment')).json();
    const policyHash = await sha256Hex(policyBytes(deployment.policy));
    const raw = (offset: number, length: number) => body.subarray(offset, offset + length);
    const schemaVersion = body[0];
    const policy = raw(1, 32).toString('hex');
    const nonce = raw(33, 8).readBigUInt64LE(0).toString();
    const expiry = raw(41, 8).readBigUInt64LE(0).toString();
    const commitment = raw(49, 32).toString('hex');
    const assets = [0, 1, 2].map(index => {
      const base = 81 + index * 32;
      return {
        funding: raw(base, 8).readBigUInt64LE(0).toString(),
        min_output: raw(base + 8, 8).readBigUInt64LE(0).toString(),
        max_output: raw(base + 16, 8).readBigUInt64LE(0).toString(),
        funding_reference_price: raw(base + 24, 8).readBigUInt64LE(0).toString(),
      };
    });
    expect(policy).toBe(policyHash);
    expect(schemaVersion).toBe(1);

    const accounts = instruction.keys;
    const canonical = deployment.policy as { genesis: string; program_id: string; config_address: string };
    const mandate = {
      genesis: canonical.genesis, program_id: canonical.program_id, config_address: canonical.config_address,
      schema_version: '1', policy_hash: policyHash, owner: new PublicKey(wallet.publicKey).toBuffer().toString('hex'),
      nonce, expiry_unix_seconds: expiry, optimization_commitment: commitment,
      assets: assets.map((asset, index) => ({
        ...asset,
        mint: deployment.assets[index].mint,
        token_program: deployment.assets[index].tokenProgram,
        decimals: String(deployment.assets[index].decimals),
        // Owner source ATAs are the canonical owner ATAs, at 8..10 in the funding account order.
        recipient_ata: accounts[8 + index].pubkey.toBuffer().toString('hex'),
      })),
    };
    const recomputed = createHash('sha256').update(mandateBytes(mandate)).digest('hex');
    const displayed = (await page.getByTestId('mandate-hash').textContent())!.replace('mandate hash ', '').replace('…', '');
    expect(recomputed.startsWith(displayed)).toBe(true);
    expect(mandate.nonce).toBe('0');
    expect(new PublicKey(deployment.config).toString()).toBe(deployment.config);
  });
});
