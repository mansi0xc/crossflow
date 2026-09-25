# CrossFlow

*Cross three independently constrained strategies inside one atomic transaction — without trusting
the solver that proposes it.*

An operator runs three strategy accounts. On the same morning two of them want to trade the same
stock in opposite directions — one trimming 2,000,000 units, one adding 2,000,000. Executed the
ordinary way, both pay the spread, both pay price impact, both pay a network fee, to swap with each
other *through* a venue that takes a cut for standing in the middle.

Internalising that flow is not a new idea. The hard part was never spotting the match. The hard part
is letting a solver move money between three accounts without trusting it for one raw unit.

CrossFlow's answer is blunt: **the owner signs the box, the program enforces the box, and the box is
small.** Each owner funds a slice of its portfolio into per-intent vaults and signs raw-unit lower
and upper bounds for *every* asset. A bounded batch may then move value between those accounts, and
against a pinned outside venue, but only inside those bounds, and only atomically. If the last owner
in the batch misses its bounds by a single raw unit, the whole transaction reverts and nothing moved.

The solver is ordinary untrusted input. It picks which compatible orders cross and what residual to
route. It never touches a bound, a recipient, or an amount the owner did not sign.

> Everything in this repository is devnet and test-asset work. No mainnet, no issuer-backed shares,
> no audit, no release.

## What an owner actually signs

No detached signature, no wallet-message signature, no separate approval to keep in sync with the
chain. The owner signs the `create_and_fund` transaction itself, and the program stores the
canonical mandate hash. Here is one owner's slice from the local runs — three allowed assets, every
one of them constrained, even the one funded with zero:

```
asset     funded        min          max
cash      10,000,000          0     60,000,000
stock1     4,000,000          0      4,000,000
stock2             0          0              0
expiry    now + 890s
policy    pinned 32-byte hash, checked at funding
```

That minimum matters. `min output = 0` on cash means the owner is allowed to spend its whole cash
position; `max output = 0` on stock2 means it can never be handed stock2 as change. The bounds are
the authority. The three target bands the operator typed into a UI are *not* — they are off-chain
preferences, and the README says so because the program does too.

## Three ways to rebalance, one fair clock

Every comparison uses the same starting portfolio, the same frozen price snapshot, the same risk
envelope and the same cost convention. Method B may not quietly rewrite Method A's orders, and
Method C may not relax anybody's bounds to make its total look better.

| | what it may do | why it is there |
|---|---|---|
| **A — independent** | optimise and execute each account alone | the honest cost of doing nothing clever |
| **B — fixed-order netting** | cross A's orders exactly as A chose them, then route the residual | ordinary matching, the strongest simple competitor |
| **C — cooperative** | jointly choose trades inside everyone's own mandate, cross, then route | the actual claim under test |

The engines use nothing but the Python standard library: a deterministic bounded enumeration over the
frozen integer grid, judged by an independent checker that recomputes the constraints from the
untouched scenario. A ledger that checker rejects is never presented as executable.

## The honest headline

This is the part most READMEs bury. On the frozen held-out suite of 8 scenarios:

- **Cooperative beats plain netting by a median of +16,200 micro-USD**, and is never negative. Of
  the 40 declared sensitivity points where a positive gain existed to preserve, **all 40 kept it** —
  including a one-hour batch delay while the independent path keeps trading.
- **But the gain is positive in only 4 of the 6 scenarios where all three methods are feasible.** In
  the other two it is exactly zero.
- **And plain netting loses money in two held-out scenarios**, worst case **−5,155,280 micro-USD**
  against just trading independently — when a batch waits an hour, the waiting cost eats more than
  the crossing saves.
- **The engine declines to batch at all in 2 of those 6 scenarios**, because crossing would leave an
  owner worse off than executing alone. Declining is a result, not a bug.

So the sentence this evidence supports is: *compatible orders crossing internally is the mechanism
that holds up.* The sentence it does not support is: *cooperative adjustment adds a reliable premium
on top of plain netting.* The absolute savings are small — a few basis points of turnover at most —
and volume, liquidity and durable opposing flow are not demonstrated at all. The raw table, every
sensitivity point and the per-owner rows are in `docs/evidence/economic-report.md`.

## What is actually built

| Capability | Status | Where the evidence is |
|---|---|---|
| Owner-signed funded intent with raw-unit output bounds | works — local + devnet | `verification/evidence/T05-local-runtime.json` |
| Thin settle / reject / cancel / per-asset refund | works — local | `verification/evidence/T06-local-runtime.json` |
| Lifecycle: expiry, monotonic nonce, config rotation, missing-ATA recreation, closed-vault donation recovery | works — local | `verification/evidence/T07-*`, `T08-*` |
| Atomic three-owner batch, internal crossings, settle-or-revert | works — local + devnet probe | `verification/evidence/T09-local-batch-output.json`, `T24-devnet-output.json` |
| Residual leg against a pinned venue, inside the *same* transaction | works — local only | `verification/evidence/T16-local-route-output.json` |
| Unseen portfolio → proposal → approval → settlement → reconciliation | works — local | `verification/evidence/T33-optimizer-execution-output.json` |
| A decision that can decline: cross, net, or stay independent | works | `services/optimizer/cooperative.py`, `docs/evidence/economic-report.md` |
| Exact per-owner cost attribution that refuses to hide a fee or excuse a harmed owner | works | `packages/planner/src/costs.ts`, `tests/planner/cost-allocation.test.ts` |
| Bounded local service — loopback, no keys, no arbitrary command surface | works — local | `docs/spec/service-api.md`, `verification/evidence/T32-local-service-output.json` |
| Review → compare → approve → recover in a browser, keyboard-operable, WCAG AA contrast | works — local | `tests/ui/*.spec.ts`, `docs/evidence/usability.md` |
| 12-cycle lifecycle soak and measured transaction capacity | measured — local | `docs/evidence/capacity-report.md`, `docs/evidence/soak-report.json` |
| Authenticated Pyth equity prices | **excluded** — fixture oracle only | `docs/claims-ledger.csv` |
| Real venue, mainnet, audit, demo video, submission | **none** | — |

Three things belong printed next to those rows, not in a footnote. The devnet deployment
runs a policy with **routing disabled**, so it exercises internal crossing only; the composed
residual route has never run on devnet. The browser flow is driven with an **injected wallet stub
and a stubbed RPC** — it has never been exercised with the real Phantom extension. And the
`T33` run is the honest version of "it works end to end": when the routed leg's realized proceeds
differed from the model by 4,670 raw units, the run *printed the discrepancy* instead of rounding it
away.

## How a settlement actually runs

One transaction, and the interesting property is what is *not* in it.

1. Each owner signs its own `create_and_fund`. One owner per transaction; the whole slice moves into
   vaults owned by the intent PDA.
2. With 2–3 funded intents under one config, a batch is proposed and validated against the **funded
   mandates** by a planner that never calls the optimizer's own validation.
3. `settle_batch` and `settle_routed` **declare no signer at all.** The only authority in the
   transaction is the funded intent PDAs, via `invoke_signed`.
4. Internal crosses book a seller, a buyer, a raw stock quantity and a raw cash quantity. Debits and
   credits are *derived*, never supplied — there is no free credit-weight field to abuse. Per mint,
   total debits must equal total credits.
5. A residual leg is one CPI into the venue pinned by the committed policy. CrossFlow rebuilds that
   instruction from typed arguments — a 26-byte body and a fixed ten-account list — so no caller
   byte blob is ever forwarded.
6. After the CPI, the output is **measured, not quoted**. The venue's reserves must move by exactly
   the leg, and the third pool must not move at all.
7. Measured output is allocated pro rata by each owner's own contribution, largest remainder, ties
   broken by ascending owner public-key bytes. The pools must end at exactly the sum of credits, and
   then empty.
8. Only then is every `O[i,a] = F[i,a] − D[i,a] + C[i,a]` re-checked against the signed min and max.

## Small things that turned out to matter

Real defects found while building this, and the decisions that stayed:

- **Three owners do not fit a legacy packet.** A three-owner settlement instruction encodes to 1,275
  bytes against a 1,232-byte limit, so an address lookup table is a hard requirement of the
  supported configuration rather than a size optimisation — and the local runs must wait for the
  table's *rooted* slot, because waiting on the confirmed slot lets the leader silently drop the
  transaction.
- **Deploying the same policy twice is not an upgrade.** A config carries its policy for the life of
  the deployment, so changing the policy needs a *new* deployment identity and fresh owner
  authorisation. The tooling refuses to replace a deployment that still has outstanding claims.
- **Anchor caches token balances.** After every CPI the program re-reads the raw account bytes,
  because the cached `amount` field is exactly how a malicious venue would make a stale number look
  authoritative.
- **The settlement instruction was forged-proofed.** Both funding and settlement are re-read from
  the instructions sysvar and required to be at transaction-level stack height, so a CPI cannot
  impersonate one.
- **The batch handlers overflowed the SBF stack frame** once routing was added. `Policy` is boxed
  and the loader helpers are `#[inline(never)]` for that reason, not for style.
- **Two encodings, one bug each way.** Every identity inside the canonical mandate is lowercase hex;
  base58 is display-only. Passing base58 where hex was required crashed loudly rather than signing
  the wrong bytes — which is the failure mode you want.
- **There is no fee field anywhere in the program.** `protocol_fee_bps` must be `0` and the encoder
  refuses anything else, because a non-zero value would be a hidden fee that no settlement path
  could ever pay out. Rent is a recoverable deposit, reported separately and never charged as cost.

## Layout

```
programs/crossflow/     Anchor program: funding, batch settlement, routing, recovery, oracle guard
programs/test-venue/    controlled synthetic residual venue — real constant-product, test liquidity
packages/contracts/     canonical byte encodings, hashes, exact raw amounts, largest-remainder dust
packages/client/        instruction builders shared by the browser, the service and the scripts
packages/planner/       solver-independent plan validator and per-owner cost attribution
packages/adapters/      residual venue adapter contract: the venue cannot choose a destination
services/optimizer/     the three engines (Python standard library only, exact rational arithmetic)
services/api/           bounded loopback service: plans, chain intents, unsigned batches
apps/web/               review → compare → approve → recover, with an injected wallet in tests
scripts/                harness, devnet tooling, capacity probe, evidence checkers
scripts/local-runs/     reproducible local runtime runs; each needs CROSSFLOW_RUN_DIR
verification/           per-task manifests and the committed runtime transcripts
docs/                   specification, operations, evidence, submission kit
```

## Running it

Nothing here needs a paid service, a funded wallet or mainnet. Devnet tooling refuses any
destination whose live genesis is not the reviewed devnet genesis.

```sh
corepack pnpm@10.17.1 install --frozen-lockfile
corepack pnpm@10.17.1 exec playwright install chromium

corepack pnpm@10.17.1 check:workspace          # harness + secrets + RPC guard + schema vectors
corepack pnpm@10.17.1 exec vitest run          # 164 TypeScript tests, 22 files
corepack pnpm@10.17.1 test:ui                  # 24 browser tests, injected wallet + stubbed RPC
python3 -m unittest discover -s services/optimizer -p 'test_engines.py'   # 8 engine tests
python3 scripts/evaluate-economics.py --split holdout
CROSSFLOW_DEPLOYMENT_MANIFEST=verification/evidence/T16-local-manifest.json \
  cargo test -p crossflow -p test-venue --lib  # 30 Rust tests
corepack pnpm@10.17.1 verify:task -- T09       # the full per-task check set for one task
corepack pnpm@10.17.1 verify:release           # binds the commit, tree and artifact hashes together
```

The on-chain runs — real validator, real token transfers, real CPIs — reproduce the committed
evidence from a checkout:

```sh
export CROSSFLOW_RUN_DIR=$(mktemp -d)
bash scripts/local-runs/run-t09.sh        # internal three-owner atomic batch
bash scripts/local-runs/run-t16.sh        # composed cross + residual route
bash scripts/local-runs/run-t32.sh        # the service end to end over HTTP
bash scripts/local-runs/run-optimizer.sh  # an unseen portfolio, proposal to reconciliation
bash scripts/local-runs/run-lifecycle.sh  # full lifecycle, config rotation, recovery
bash scripts/local-runs/run-soak.sh       # the 12-cycle soak
bash scripts/local-runs/run-t24.sh        # the only run that leaves this machine
```

To drive the interface yourself:

```sh
corepack pnpm@10.17.1 serve:api    # http://127.0.0.1:8787 — loopback, holds no key, signs nothing
corepack pnpm@10.17.1 dev:web      # http://127.0.0.1:5173
```

The approval screen needs a wallet provider — Phantom, pointed at the local validator at
`http://127.0.0.1:8899`. The automated tests inject a stub instead, which is the only reason they can
assert that the mandate on screen is the mandate the wallet was asked to sign.

## Where to look

| You want | Read |
|---|---|
| Every claim, classified as implemented / narrowed / excluded / false | `docs/claims-ledger.csv` |
| All 24 invariants mapped to where they are enforced — including the gaps | `docs/evidence/security-matrix.md` |
| The economics, raw, with every sensitivity point | `docs/evidence/economic-report.md` |
| How big a settlement can get, and why | `docs/evidence/capacity-report.md` |
| What ran on public devnet, and what did not | `docs/evidence/devnet-runs.md` |
| The signed mandate and the accounting rules | `docs/spec/intent-contract.md`, `docs/spec/settlement-accounting.md` |
| The three-minute demo and its rehearsal checklist | `docs/demo-script.md` |
| The state of the work, plainly | `docs/final-handoff.md` |

## What this is not

The list is long on purpose, and it is the same list the claims ledger carries.

- **No audit and no formal verification.** Three scoped independent engineering reviews are recorded
  — internal batch settlement, composed residual route, and the service/UI surface. The last one
  came back REWORK, and its high finding was real: recovery was unreachable when the service was
  offline, which is precisely the outage recovery exists for. Fixed, with a regression test. That is
  still not a certificate.
- **No real prices and no real liquidity.** Pyth is excluded; prices are a labelled fixture
  publisher with an unmistakable TEST PRICES mode. The residual venue is a synthetic test pool whose
  size is bounded by the committed ±200 bps execution band rather than by demand.
- **No devnet route, and no adversarial matrix in one run.** Adversarial coverage is the named
  rejection cases in the local transcripts plus the property and soak suites.
- **The browser flow has never met a real wallet**, the UI is not hosted anywhere, no unfamiliar
  human has completed the path, and there has been no screen-reader session.
- **The service is a local operator tool**: loopback only, one configured deployment, no
  authentication, no multi-tenancy. It holds no key, accepts none, and never signs.
- **The devnet program retains an upgrade authority**, which is a real trust assumption, disclosed
  in `docs/operations/deployment.md`.
- **Nothing has been submitted and no video exists.** The submission package is written; the human
  decision it is waiting on is described in `docs/final-handoff.md`.

The devnet deployment is program `CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh`, and four owners
are refused — the encoder and the program both say three. Capacity headroom is not spare capacity
for another leg: a second residual needs another CPI and more accounts.
