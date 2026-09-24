import type { Deployment } from '../api.js';
import { formatRawDisplay } from '../../../../packages/contracts/src/amounts.js';

/**
 * The selected slice, labelled unmistakably as devnet test assets.
 *
 * Display conversion is exact and one-way: the raw integer is the authority everywhere else, and
 * this component never feeds a displayed number back into a transaction.
 */
export function PortfolioSlice({ deployment }: { deployment: Deployment }) {
  const labels = ['test cash', 'test stock 1', 'test stock 2'];
  return (
    <table data-testid="portfolio-slice">
      <caption>Configured test assets (devnet only — not issuer-backed shares)</caption>
      <thead>
        <tr><th>asset</th><th>label</th><th>decimals</th><th>mint</th></tr>
      </thead>
      <tbody>
        {deployment.assets.map((asset, index) => (
          <tr key={asset.mint}>
            <td>{index}</td>
            <td>{labels[index] ?? `asset ${index}`}</td>
            <td>{asset.decimals}</td>
            <td><code>{asset.mint.slice(0, 16)}…</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Exact display of a raw amount, used wherever a number is shown rather than signed. */
export function raw(value: string, decimals: number): string {
  try { return formatRawDisplay(BigInt(value), decimals); }
  catch { return value; }
}
