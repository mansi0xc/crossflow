/**
 * Plain-language explanation of what the operator is about to do.
 *
 * The rule this component exists to satisfy: nothing critical may live only in a tooltip, an
 * abbreviation or a colour. Every paragraph here is visible text, and each one is also stated where
 * the decision is actually made.
 */
export function Explainer() {
  return (
    <section className="explainer" data-testid="explainer" aria-labelledby="explainer-heading">
      <h2 id="explainer-heading">What this does, in plain words</h2>
      <h3>Funded escrow</h3>
      <p>
        When you approve a slice, the amounts move into a vault that the program controls, not your
        wallet. While it sits there you cannot spend it freely: it can only be settled inside the
        bounds you signed, or cancelled and withdrawn by you. Rent is a refundable deposit, not a
        fee — you get it back when the intent closes.
      </p>
      <h3>The bounds you sign</h3>
      <p>
        Two numbers per asset: the smallest and the largest amount you are willing to end up with.
        If a settlement would leave you outside either bound, the whole batch is refused rather than
        adjusted. The numbers are raw units, shown exactly as the program stores them, and the hash
        above them is computed from those same bytes.
      </p>
      <h3>What crosses internally</h3>
      <p>
        If two participants want opposite trades in the same asset, the batch can move that asset
        between them directly. That part never touches an outside venue, so it pays no spread or
        impact. Only the leftover is routed externally.
      </p>
      <h3>Recovery</h3>
      <p>
        You can cancel at any time, which stops the intent from settling but moves nothing. Then you
        withdraw each asset to your own account, one at a time, and close the intent to reclaim the
        rent. None of that needs the operator, the solver, or the service to be running.
      </p>
      <h3>What the three approaches mean</h3>
      <ul>
        <li><strong>Independent execution</strong> — every participant trades its own slice, paying full cost each time.</li>
        <li><strong>Fixed-order netting</strong> — opposing orders are matched and cancelled first, then the remainder is traded.</li>
        <li><strong>Cooperative adjustment</strong> — participants additionally adjust their targets jointly to reduce external flow.</li>
      </ul>
      <p>
        A comparison only claims an improvement for the participants it can demonstrate one for. If
        any participant ends up worse than it would have alone, the comparison says so and refuses to
        recommend the batch.
      </p>
      <h3>Test assets and test prices</h3>
      <p>
        The assets are devnet mints with their authorities revoked, not issuer-backed shares. Prices
        come from a labelled fixture publisher and are not real market data. Nothing here is deployed
        to mainnet, and the program has not been audited.
      </p>
    </section>
  );
}
