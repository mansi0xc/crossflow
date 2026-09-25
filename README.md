# CrossFlow

An operator running several independently constrained stock strategies pays spread, impact and
network cost once per strategy. Where those strategies want opposing trades, part of that cost is
avoidable: the orders can cross internally, and only the leftover needs an external venue.
CrossFlow makes that safe to do: each owner signs raw-unit bounds, and a Solana program either
settles the whole bounded batch inside every owner's bounds or reverts it entirely.

**Everything here is devnet/test-asset work.** No mainnet, no issuer-backed shares, no audit.

## What actually works today

| Capability | Status | Evidence |
|---|---|---|
| Per-owner funded intent with signed raw bounds | works, local + devnet | `verification/evidence/T05-local-runtime.json`, `T24-devnet-output.json` |
| Thin settle → reject → cancel/refund | works, local | `verification/evidence/T06-local-runtime.json` |
| Lifecycle: expiry, nonces, config rotation, owner ATA recreation | works, local | `artifacts/tasks/T07/**` |
| Asset admission, exact raw amounts, deterministic dust, old-vault donation recovery | works, local | `verification/evidence/T08-local-*.json` |
| Three-owner atomic internal crossing + residual route composition | works, local | `verification/evidence/T09-local-batch-output.json`, `T16-local-route-output.json` |
| Controlled synthetic residual venue (real transfers) | works, local | `verification/evidence/T10-local-venue-output.json` |
| Isolated three-owner fund → batch settle → reject → recover on public devnet | probe passed | `verification/evidence/T24-devnet-output.json` |
| Three-engine economic comparison + held-out evaluation | works | `docs/evidence/economic-report.md` |
| An execution *decision*: recommend crossing, netting or independent, and decline batching that would harm an owner | works | `docs/evidence/economic-report.md`, `services/optimizer/cooperative.py` |
| Local service serving plans, chain intents and unsigned batches | works | `docs/spec/service-api.md`, `tests/services/resource-limits.test.ts` |
| Browser review → compare → approve → recover flow with an injected wallet | works (local) | `tests/ui/*.spec.ts` |
| Per-owner cost disclosure that refuses to hide a fee or excuse a harmed owner | works | `docs/spec/cost-allocation.md`, `tests/planner/cost-allocation.test.ts` |
| Lifecycle soak and measured capacity report | works (local) | `docs/evidence/soak-report.json`, `docs/evidence/capacity-report.md` |
| Keyboard-operable, WCAG-AA-contrast UI with plain-language explanations | works (local) | `docs/evidence/usability.md`, `tests/ui/accessibility.spec.ts` |
| Authenticated Pyth equity prices | **excluded** | T15 unstarted; fixture oracle only |
| Real venue, Pyth, submission portal | **not implemented** | — |

## The honest headline

On the frozen held-out suite the cooperative engine's gain over plain netting has a median of
**+16,200 micro-USD** and is never negative, and it survives **40 of 40** sensitivity points where a
gain existed to lose — including batch delays of up to an hour with the independent path executing
immediately. Two corrections to what this README previously claimed:

- The earlier "36 of 72" figure confused *opportunity coverage* with *fragility*. Most runs cannot
  be positive, because a scenario with no attributable cooperative benefit has nothing to preserve.
  Robustness is now measured against each scenario's own baseline, and the delay test varies only
  the batch clock rather than moving both together.
- Plain netting loses money in **two** held-out scenarios, not one: netting's worst case is
  **−5,155,280 micro-USD** against independent execution. That is the stronger result and it was
  understated.

What the evidence still does not support: cooperative adjustment is positive in only 4 of 6
eligible scenarios (the other 2 gain exactly nothing), and the absolute savings are small — the
incremental benefit is roughly 1.35 basis points of turnover in one case. Volume, liquidity and
reliable opposing flow are not demonstrated. See `docs/evidence/economic-report.md`.

## Layout

```
programs/crossflow/     Anchor program: funding, batch settlement, routing, recovery, oracle guard
programs/test-venue/    controlled synthetic residual venue (test liquidity only)
packages/contracts/     canonical byte encodings, hashes, exact raw amounts
packages/client/        instruction builders (fund, settle, route, recover, config)
packages/planner/       solver-independent plan validator
packages/adapters/      residual venue adapter interface
services/optimizer/     independent / netting / cooperative engines
services/api/           bounded local service: plans, chain intents, unsigned batches
apps/web/               review → compare → approve → recover UI (injected wallet)
scripts/                local harness, devnet tooling, capacity probe, evidence checkers
verification/           per-task manifests and committed runtime evidence
docs/                   specification, operations, evidence, submission kit
scripts/local-runs/     reproducible local runtime runs (each needs CROSSFLOW_RUN_DIR)
```

Local runtime runs reproduce the committed evidence from a checkout:

```sh
export CROSSFLOW_RUN_DIR=$(mktemp -d)
bash scripts/local-runs/run-t09.sh    # internal three-owner batch
bash scripts/local-runs/run-t16.sh    # composed cross + residual route
bash scripts/local-runs/run-t32.sh    # service end-to-end
bash scripts/local-runs/run-soak.sh   # T28 lifecycle soak
bash scripts/local-runs/run-t24.sh    # devnet probe (the only run that leaves this machine)
```

## Running it

```sh
corepack pnpm@10.17.1 check:workspace                 # harness, secrets, RPC guard, schema vectors
corepack pnpm@10.17.1 exec vitest run                 # 131 TypeScript tests (see note below)
python3 -m unittest discover -s services/optimizer -p 'test_engines.py'
python3 scripts/evaluate-economics.py --split holdout
CROSSFLOW_DEPLOYMENT_MANIFEST=verification/evidence/T09-local-manifest.json cargo test -p crossflow --lib
corepack pnpm@10.17.1 verify:task -- T09              # full per-task check set
corepack pnpm@10.17.1 test:ui                          # browser flow (injected wallet, stubbed RPC)
corepack pnpm@10.17.1 verify:release                   # ties the commit, tree and artifact hashes together
```

See `docs/local-demo-runbook.md` for the full reproduction path and `docs/release-checklist.md` for
the current gate results.

Running the UI locally:

```sh
corepack pnpm@10.17.1 serve:api    # http://127.0.0.1:8787, bound to loopback
corepack pnpm@10.17.1 dev:web      # http://127.0.0.1:5173
```

The approval screen requires a wallet provider. In a browser that is Phantom (set it to the local
validator at `http://127.0.0.1:8899`); the browser tests inject a stub provider instead, which is
why they can assert that the mandate on screen is the mandate the wallet was asked to sign.

Note: `vitest run` with no arguments also picks up `tests/**/*.test.mjs`, which are `node:test`
files and report "No test suite found". Use `check:workspace` (which runs them with `node --test`)
or pass explicit paths.

Nothing here requires a paid service, a funded wallet or mainnet. Devnet tooling refuses any
destination whose live genesis is not the reviewed devnet genesis.

## Limitations a reader should know before trusting anything

- **No audit, no formal verification.** Invariant coverage is tabulated in
  `docs/evidence/security-matrix.md`, including the rows that are *not* exercised.
- **The residual route is composed only against a synthetic venue** with test tokens, and the
  leg size is bounded by the committed ±200 bps execution band rather than by demand.
- **Pyth is excluded.** Prices are a labelled fixture oracle; no live equity claim is made.
- **The browser flow is tested against an injected wallet and a stubbed RPC.** The real Phantom
  extension flow has not been exercised end to end, and the UI is not hosted anywhere. No
  unfamiliar-user review has been run, and there is no screen-reader session.
- **There is no adversarial runtime matrix** against the deployed instruction: adversarial coverage
  is the named rejection cases in the local transcripts plus the property and soak suites.
- **The service is a local operator tool**: loopback only, one configured deployment, no
  authentication and no multi-tenancy.
- **Retained upgrade authority** on the devnet program is a trust assumption, disclosed in
  `docs/operations/deployment.md`.
