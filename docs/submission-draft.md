# Submission draft

**CrossFlow — cooperative rebalancing for separately constrained strategy accounts, enforced on
Solana.**

Everything below is devnet/test-asset work. Nothing is audited, nothing is on mainnet, and the
eligible claims are listed with the ineligible ones in `docs/claims-ledger.csv`.

## The problem

An operator running several strategy accounts pays execution cost once per account. When two
strategies want opposing trades in the same name, part of that cost buys nothing: the shares could
have changed hands between the accounts themselves. But letting a solver move money between
accounts on the strength of "trust me, the portfolio is fine afterwards" is not an acceptable
design — an operator needs a hard, per-account boundary.

## What CrossFlow does

Each owner funds a selected slice of its portfolio into per-intent vaults and signs **raw-unit
lower and upper bounds for every asset** at funding time. A bounded batch can then move value
between those accounts and against a pinned venue, but only inside those bounds, and only
atomically. The solver is ordinary untrusted input: it chooses which compatible orders cross and
what residual to route, never a bound, a recipient or an amount the owner did not sign.

The demonstration is three independently constrained strategy accounts, two labelled test stocks
and test cash.

## What is actually implemented

- **Funded intent with signed bounds** — `create_and_fund`, exact funding, deterministic mandate
  hash, single active intent, nonce discipline, rent recoverable.
- **Bounded atomic batch settlement** — `settle_batch` for internal crossings; one instruction, no
  signer authority at all; every owner's realized output must satisfy its signed bounds or the
  whole batch reverts. 205,117 CU and 350 serialized bytes for three owners behind a 33-entry
  lookup table.
- **Composed residual routing** — `settle_routed` pools every debit, executes the admitted leg
  against the venue pinned by the committed policy, allocates the measured output pro rata by each
  owner's own contribution, re-checks the ±200 bps per-owner execution band on realized amounts,
  reconciles the pools against the sum of credits and requires them empty. 330,095 CU, 451 bytes,
  43 lookup entries.
- **Owner-controlled recovery** — cancellation is transfer-independent, each asset is withdrawn
  separately to the owner's canonical account, missing accounts are recreated at the same address,
  and donations to a closed vault remain recoverable.
- **Controlled synthetic venue** — a real constant-product execution venue with test liquidity, so
  the residual leg is an actual token transfer rather than an animation.
- **Three fair engines and a held-out evaluation** — independent, fixed-order-netting and
  cooperative, sharing one frozen model, with an independent ledger checker and a validator that
  refuses a report with a dropped scenario, a missing cost field or an overstated claim.
- **Bounded local service** — a loopback operator tool that serves the deployment identity, the
  labelled fixture snapshot, funded intents read from chain, the three engine proposals, and an
  **unsigned** settlement transaction built only from a plan the independent validator accepted.
  It holds no key and accepts none, and it never signs.
- **Review → compare → approve → recover UI** — the three approaches with their attribution and
  negatives, the exact raw-unit mandate with its recomputed hash, an explicit affirmation gate
  before the wallet is asked to sign, and per-asset recovery read from chain. Recovery works with
  the service completely offline.
- **Isolated public-devnet probe** — the program is deployed to devnet and a three-owner fund →
  atomic batch settle → rejection → cancel/refund probe passed with reconciled balances.

## The honest result

On the frozen held-out suite, the cooperative engine's advantage over plain netting has a median
of **+16,200 micro-USD** and is never negative — but it is positive in only **4 of 6** eligible
scenarios, and only **36 of 72** declared sensitivity points keep it positive. One scenario's
netting costs *more* than running the accounts independently.

So the defensible claim is narrower than the motivating hypothesis: **compatible orders crossing
internally is the mechanism that holds up; "cooperative adjustment adds value on top of plain
netting" does not survive modest fee or latency change.** We report it that way rather than
tuning the baseline until it looks good.

## What is deliberately absent

Authenticated equity prices (Pyth is excluded; the oracle is a labelled fixture), any real venue
(not Meteora, not Jupiter, not an AMM), mainnet, production liquidity, issuer-backed assets, and any
security audit. The browser flow is exercised with an injected wallet stub and a stubbed RPC, so
the real Phantom extension path and any hosting remain untested. `docs/evidence/security-matrix.md`
tabulates all 24 design invariants against where they are enforced and which check exercises them,
including the rows that are only partly exercised.

## Where to look

| Question | File |
|---|---|
| What works, what does not | `README.md` |
| Every claim and its classification | `docs/claims-ledger.csv` |
| Invariant coverage, including gaps | `docs/evidence/security-matrix.md` |
| The economics, raw | `docs/evidence/economic-report.md` |
| The devnet probe | `docs/evidence/devnet-runs.md` |
| The signed mandate and accounting rules | `docs/spec/intent-contract.md`, `docs/spec/settlement-accounting.md` |
| The three-minute demo | `docs/demo-script.md` |
