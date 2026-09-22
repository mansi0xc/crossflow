# CrossFlow — execution plan and build contract

**Version 1 · 22 September 2026 · Status: planning, not implemented or audited**

Build a credible stock-portfolio execution product: demonstrate a measurable advantage, make every authorization enforceable, and let a judge understand and verify the result. This document defines what we build, how we check it, when we stop, and what evidence is required before calling anything finished.

The ambition is to compete seriously. A plan cannot guarantee a prize, commercial demand or security. It can prevent avoidable mistakes, expose a weak idea early and concentrate effort on a convincing result. Because money is tight, **the approved spending budget is zero**. There is no hidden assumption that we will purchase data, hosting, RPC access or mainnet SOL.

## Current user execution policy — updated 22 September 2026

Execute in `/Users/mansitibrewal/chronicles/crossflow`. The latest user instruction revokes per-task approval pauses: continue dependency-safe concurrent tasks with occasional status reports, while preserving task checks and independent review. Earlier one-task-at-a-time/user-review requirements are historical and superseded.

The existing local Solana CLI wallet is authorized for CrossFlow devnet work only. Its verified public address is `FSyL13FTp3Yrgdo8VWpoNtpL8FS5FcSGL3tdNp1sjw2t`; the balance was 20.95376933 devnet SOL at 15:16 UTC on 22 September. Verify identity, cluster and actual rent/fees before any future deployment. No signing material belongs in source or evidence. No mainnet work or new real-money spending is authorized.

Use labelled fixture prices for the core setup and revisit Pyth afterward, before final demo freeze if claiming its integration. Preserve the adapter boundary and full-transaction capacity check now. Funded devnet access resolves the T00 faucet prerequisite; it does not waive later program/security gates.

## Reading and execution order

1. Read this contract for scope, architecture, invariants, gates and release rules.
2. Execute the individual work cards in [.planning/TASKS.md](.planning/TASKS.md), respecting their dependencies. Each card supplies its completion checks and evidence requirements.
3. Use [.planning/REQUIREMENTS.md](.planning/REQUIREMENTS.md) as the scope checklist, [.planning/STATE.md](.planning/STATE.md) as the resume point, and [.planning/RESEARCH.md](.planning/RESEARCH.md) for technical sources and unsettled dependencies.
4. Read [.planning/PLAN-REVIEW.md](.planning/PLAN-REVIEW.md) for the independent review of this plan. A plan-review pass is not a product-test pass.

If these documents conflict, stop the affected task and reconcile them before coding. User constraints take precedence. This master document owns security and release policies; task cards own implementation sequence. Neither may silently relax the other.

## 1. The product we are committing to

**Promise:** “Rebalance several stock strategies together, keep each strategy inside its approved limits, and show exactly where transaction costs were saved.”

The first user is one operator with several strategy accounts, such as a small portfolio manager or an advanced individual running separate strategies. This makes coordinated participation plausible without first attracting an entire exchange. Later support for unrelated strangers would introduce additional incentives, privacy and fairness questions that this version does not solve.

The demonstration has three strategy wallets, two stock-like test tokens and test cash. Each account has its own initial holdings, target bands and limits. CrossFlow compares three approaches:

| Approach | What it may do | Why it exists |
|---|---|---|
| Independent execution | Optimize and execute each account separately under the same constraints | Establish the cost of separate execution |
| Fixed-order netting | Cross compatible independently selected orders, then route the residual | Represent ordinary matching, the strongest simple competitor |
| Cooperative adjustment | Jointly choose trades within the same acceptable portfolio constraints, cross them, then route the residual | Test CrossFlow's actual differentiator |

All three must use the same initial holdings, price snapshot, target envelope, risk/tracking-error constraints and venue/cost model. An account cannot be forced outside its mandate to improve the headline total. A lower trading cost is not automatically a better portfolio; report deviations and modeled risk alongside costs.

### Required user journey

1. Open the app and see a persistent **Solana devnet / test assets** label.
2. Connect a wallet; select a fixture strategy or enter a valid selected portfolio slice.
3. Choose target bands, maximum deviations, expiry and price-protection settings.
4. Compare the three plans, including projected costs, amounts, assumptions and each account's outcome.
5. Review a plain-language transaction summary and approve funding for that account's intent.
6. Once enough compatible funded intents exist, the solver proposes a bounded settlement.
7. The program either settles the whole batch within every mandate or rejects it without partial transfers.
8. Inspect before/after balances, internal crosses, external residuals, price provenance, costs and devnet transaction links.
9. Cancel or recover an unsettled intent through a visible independent recovery route.

The first thin slice must exercise funding, settlement/rejection and refund before we build an elaborate optimizer or polished interface.

### Scope boundaries

**Required:** intent lifecycle, a bounded atomic batch, fair three-way comparison, controlled residual execution, clear wallet workflow, reproducible economic evidence, recovery, meaningful negative tests and a verifiable demo.

**Conditional:** authenticated Pyth equity integration using access that costs us nothing. The core must handle authenticated-oracle failure safely, and support clearly labelled test-oracle scenarios if access fails. A test oracle does not qualify as a completed Pyth integration.

**Optional:** actual Meteora DBC devnet residual execution, only if it strengthens the stock workflow and passes its own tests before the cutoff. DBC integration is not established by a logo, a mock, or a DLMM/DAMM swap.

**Deferred:** mainnet; real issuer stock ownership; lending or leverage; shorts; cross-chain settlement; private/encrypted orders; permissionless asset discovery; arbitrary routing; partial fills; guaranteed best execution; tax optimization; multiple issuer bounty campaigns; mobile native apps; production-grade account management. No new token is needed to make CrossFlow useful.

## 2. Calendar, critical path and budget

The published deadline is **25 September 2026, 16:00 Eastern Time**, equivalent to **26 September 2026, 01:30 IST**. Recheck the [official Stocklana page](https://hackathons.solana.com/hackathons/stocklana) at execution start; preserve the applicable rules in evidence. Planning was resumed at approximately 10:30 IST on 22 September. The schedule below assumes an 11:00 IST execution start, leaving about 86.5 hours; it must be rebased if execution starts later. These are elapsed-time targets, not a demand for anyone to work without rest. Parallel agents can shorten independent work, but cannot remove dependency checks.

| Latest target, IST | Required evidence | If missed |
|---|---|---|
| 22 Sep 23:00 | G0: toolchain, free access decision, tiny fair economic example | Resolve blockers or narrow claims before major work |
| 23 Sep 08:00 | G1: local fund → valid settle → reject → refund slice; schemas frozen | Cut optional integration work; focus exclusively on money path |
| 23 Sep 14:00 | Isolated thin-slice devnet proof and full-envelope capacity probe, under the probe policy below | Reduce batch size/assets if needed; do not split atomicity silently |
| 24 Sep 17:00 | G2 and core G3: security review, three baselines and full basic UI | Cut cosmetic and extension work; preserve safety and evidence |
| 24 Sep 23:00 | Full core devnet workflow; optional-integration cutoff; Pyth/DBC demonstrated or excluded | No new sponsor path after this point |
| 25 Sep 05:00 | Feature freeze; G4 full workflow stable | Only correctness, reliability and presentation fixes |
| 25 Sep 14:00 | G5 rehearsal and submission package ready | Use validated smaller release; disclose omissions |
| **25 Sep 19:30** | Internal submission-ready deadline, six-hour buffer | Escalate missing mandatory deliverables immediately |
| 26 Sep 01:30 | Published external deadline | Do not rely on this being an extension of build time |

If implementation begins later, recalculate the remaining window and cut optional scope first. Do not pretend these elapsed targets remain achievable. Keep at least six hours for submission/upload problems where the remaining time permits. The user reviews and submits, unless separately authorizing us to submit later.

**Critical path:** dependency/access and economic preflight → mandate schema → thin escrow lifecycle → full atomic settlement and attack tests → real devnet integration → repeatable demo → verified release package.

The task-graph check estimates **53–74 focused hours on the dependency-critical path**. The assumed 11:00 IST start leaves 80.5 elapsed hours to internal readiness, only 6.5 hours above that upper estimate. These numbers exclude unexpected rework, reviewer queues, human rest and service outages; they are not a delivery guarantee. DBC therefore starts **not scheduled** and may be admitted only if the validated core finishes early enough to leave its implementation, review, regression and release buffer intact. A missed mandatory checkpoint triggers immediate reforecasting and reduced optional scope. Preserve required safety/recovery checks even if the demonstration must use fewer assets or participants.

After the mandate schema freezes, solver, UI and contract improvements may proceed in parallel against versioned fixtures. Each money-path change still requires integration review. More agents do not permit conflicting edits or merging unreviewed output.

### Zero-spend operating rules

- Use existing local tools, local validator, devnet test SOL and free service allowances. Devnet SOL is not an asset purchase.
- Record each external service: account needed, limits, expiry, data entitlement, cancellation/credit-card requirement and fallback. Never put API keys in this ledger.
- Use [Pyth's documented no-credit-card trial](https://docs.pyth.network/price-feeds/pro/pyth-terminal) only if the actual selected feeds and duration qualify. If access fails, drop the bounty claim rather than automatically subscribe. The Pyth bounty is non-cash data access, so it is not a source of cash runway; the main competition remains the objective.
- Prefer a reproducible local demo plus recorded backup over a paid hosting dependency. Any free public host must pass its limits and server-secret checks before use.
- No cloud model API, premium RPC, paid data, domain, sponsor payment or mainnet funding is authorized by this plan. A future spending proposal must state the exact service, amount, necessity and free alternative.
- Treat RPC/API request quotas as a budget too. Cache shared price observations, back off and cap retries. No unbounded background polling.

## 3. Architecture and contracts to freeze before parallel work

### Components and ownership boundaries

| Component / proposed path | Responsibility | Must not do |
|---|---|---|
| `programs/crossflow/` | Funding, mandate validation, atomic settlement, cancellation/refund, accounting | Trust the solver's claimed savings or arbitrary CPI accounts |
| `packages/contracts/` | Canonical schemas, hashes, typed errors, integer units, fixture vectors | Use browser floating-point values as settlement authority |
| `services/optimizer/` | Three planners, feasibility checking, route selection, deterministic explanations | Hold user keys or alter a funded mandate |
| `services/prices/` | Server-only Pyth access and authenticated update packaging | Expose API secrets to a browser or silently substitute a fixture |
| `apps/web/` | Review/approval, status/recovery, evidence display | Say “settled” before chain reconciliation |
| `tests/` and `benchmarks/` | Independent models, attack cases, end-to-end and economics | Derive every expected result from the same code being tested |
| `scripts/` | Safe environment checks, repeatable fixtures, deployment and release verification | Fall back to the developer's global mainnet configuration |

Exact package versions are pinned after a compatibility build. Research observed Anchor 1.1.2, Solana CLI 3.1.10, Cargo 1.91.1 and Node 24.10.0 installed locally; that observation is not proof that their SDK combination works. Keep lockfiles and a recorded known-good toolchain. Prefer TypeScript for UI/client, Rust/Anchor for the program, and a local Python numerical prototype for research; use a solver service boundary so numerical code does not execute in a wallet transaction. Select a production demo numerical library only after its license and reproducibility are checked.

### Mandate schema

Define one canonical versioned encoding, shared test vectors and a cryptographic hash. Every intent includes:

- Schema version, deployment domain, program/config identity, owner, owner nonce and unique intent identity.
- Ordered unique asset identities: mint, token program, decimals and supported-extension policy/hash where relevant.
- Exact raw-unit initial funding amounts for the selected portfolio slice.
- Minimum and maximum final raw-unit output for **every** selected asset; no omitted asset implies unlimited permission.
- Approved recipient token accounts and required owner; default to the owner's canonical associated accounts.
- Expiry, price observation age/confidence/deviation policy and fixed allowed feed mapping.
- Permitted residual adapter/pool identities, maximum permitted debit/slippage settings and zero protocol-fee policy.
- The reviewed target-envelope/optimization input hash and human-facing explanation, with a distinction between enforceable constraints and economic estimates.

An owner authorizes an intent by signing the program's create-and-fund transaction. Do not introduce a second off-chain signature scheme unless necessary; if added later, it needs its own domain/replay audit. Solver proposals are ordinary untrusted input. The browser must render the exact canonical mandate it is about to fund; changing bounds or a route requires a new approval.

The mandate covers the **funded slice**, not the owner's total wallet wealth. Fully fund the selected cash and stock inventory in per-intent vaults so settlement can evaluate final outputs without assuming unrelated wallet balances stay constant. “Non-custodial” must be explained accurately: funds are temporarily controlled by program rules, with owner recovery; they are not freely spendable in the wallet during escrow.

Raw output bounds are the on-chain authority. Target percentages and risk objectives guide the planner; do not advertise a target-weight guarantee unless its exact price basis and arithmetic are also enforced. Show the actual implied target envelope and require explicit review. This avoids presenting an off-chain optimization constraint as an on-chain guarantee.

### State machine

Use atomic `create_and_fund`, rather than introducing a partially funded state in version one:

`No intent → Funded → Settled` or `Funded → Cancelled → Fully refunded`

Expiry does not make tokens disappear or require an automatic scheduled job. It makes settlement invalid and makes owner recovery available. Cancellation must also be available before expiry while the intent is still funded. Cancellation changes authorization state independently of token transfers; the owner can then withdraw each asset separately to the fixed owner recipient. This prevents one externally paused token from trapping refundable cash. Retain per-asset claims until recovered. Closing accounts and returning rent occurs only after their assets are correctly distributed/refunded and no claims remain.

- Each owner has a monotonic nonce/account that survives closing an intent; a closed intent cannot be recreated with an old nonce.
- Settlement requires all included intents still funded, compatible and unexpired. One cancellation invalidates any batch containing it.
- A cancel/settle race has one winner under Solana account locking; the loser must reload state, never resubmit a stale authorization automatically.
- Failed transactions must roll back all program state and token transfers. Network fees can still be charged for a failed transaction; UI and economics must say so.
- External issuer pauses can prevent a token transfer, including refunds. Exclude these assets by default; if explicitly supported, explain this issuer dependency and test unpause/recovery. Never claim our admin can override an issuer's token rules.
- If an approved owner associated token account is missing/closed, recovery must reconstruct that same verified address before withdrawal. It cannot substitute another recipient or require solver/admin access. The owner still needs devnet SOL for transaction/rent costs; show that prerequisite explicitly.

### Settlement and residual routing

Target one atomic transaction for a small batch. Funding transactions are per owner and separate from settlement. Start with one account/one asset pair, then prove two and three accounts with two stocks plus cash. The supported maximum is what the **complete** transaction passes, including Pyth verification, all writable accounts, route instructions and compute budget.

Internal transfers and any residual swap use program-derived vault authorities. A transient batch vault may collect approved amounts for a residual route; it must start from a known state, account for every transfer, and end with zero unallocated balance. Per-owner final output bounds and accounting, rather than the solver's transfer list, determine validity.

For owner `i` and mint `a`, record funded inventory `F[i,a]`, authorized batch debit `D[i,a]` and allocated batch credit `C[i,a]`. The final authorized portfolio is `O[i,a] = F[i,a] - D[i,a] + C[i,a]`; require `0 ≤ D[i,a] ≤ F[i,a]` and `min[i,a] ≤ O[i,a] ≤ max[i,a]`. Sum internal debits and credits per mint; they must cancel exactly. Remaining differences must equal measured external-venue net flows, with declared fees and deterministic dust included exactly once. Validate actual recipient deltas against allocated outputs, not recipient total balances that existed before settlement. Stock units and cash units cannot be added without the explicit valuation conversion.

Track booked funding separately from unsolicited vault donations. Extra tokens never increase solver spending authority or become solver revenue. Preserve owner recovery for surplus; do not close a nonempty vault or erase a residual claim after marking the authorized intent consumed. Tests must specify whether surplus is returned before settlement or retained for separate owner withdrawal, and prove it cannot corrupt the authorized output calculation. Baseline SPL fixtures have no freeze authority; any different authority policy needs explicit admission and recovery tests.

Allow only fixed audited route adapters and explicit account roles. Verify the executable program, pool/mints, token accounts, owner authorities and instruction form. Measure actual pre/post balances, not a quoted output. Enforce minimum proceeds and final mandate bounds after CPI. If a swap or final validation fails, revert the entire batch. Reject duplicate intent IDs, duplicate account roles and malicious aliasing of input/output/vault/fee accounts.

T04 must estimate and serialize the full transaction envelope early; T06/T23 permit an isolated thin-slice devnet probe after scoped review, with disposable test wallets and no public-demo claims. The probe review covers all instructions actually deployed, network guard, signer authority, exact transfers and owner recovery; it does not waive those checks. Record unimplemented route/oracle parts as capacity estimates. G2/T17 and T24 must later verify the actual complete implementation. No shared funded intents or user-facing release is allowed under this probe exception.

If a full transaction does not fit, reduce supported batch or asset count. A sequence of individually committed settlements is **not** the same atomic guarantee. Address lookup tables can reduce serialized account-address size but do not eliminate compute, account-lock or instruction limits; any use belongs in the reproducible setup and recovery plan.

Capacity reduction is a documented scope amendment, not a pass against the original three-wallet/two-stock R11. Update PROJECT, R11, scenario inputs, task acceptance and the release manifest, then rerun economic and demo gates at the revised size. The smallest meaningful cooperative demonstration is **two independently constrained portfolio accounts and at least one stock plus cash**. A one-wallet flow is only a technical probe and cannot satisfy the cooperative-product claim. Surface the reduction clearly in the user handoff.

A controlled constant-product or fixed-function test venue is the core fallback. Freeze its fee and reserve model and publish it. Execute real token transfers on devnet and call the liquidity synthetic. This proves the execution path, not market demand or real price impact. The mainnet Jupiter product is not automatically available on devnet; never accept a mainnet-built transaction by changing a wallet label.

### Oracle contract

For authentic Pyth mode, bind the selected mint to an exact allowed feed ID and verify the signed payload through the official Solana verification path. Verification requires the correct Ed25519 instruction and Pyth verifier CPI; bind instruction indices, payload bytes and feed identity rather than accepting a caller's “verified” flag.

Define maximum observation age, maximum allowed future skew, confidence/deviation policy and market-closed behavior before coding. Normalize exponent/units using checked integer arithmetic. Inspect underlying feed-update time as well as message publication time: a newly signed message can contain a carried-forward equity price. Default to rejecting new settlements when the underlying stock observation is outside the declared freshness policy. Do not silently widen thresholds on weekends or to make a demo pass.

Test-oracle mode uses a separate unmistakable configuration/domain, deterministic fixtures and visible labels. It must never be a hidden fallback from an authentication failure. Receipts record mode, feed, timestamp, source and exact price basis. Reference prices protect agreed bounds; they do not promise executable liquidity.

### Asset compatibility

Base SPL fixtures are mandatory. Validate mint ownership, decimals, authorities, account state and balances. For Token-2022, inspect the entire extension set and reject anything outside an explicit capability table. Transfer fees, hooks, confidential transfers, permanent delegates, non-transferability, default frozen state, pausing and scaled UI amounts each need separate decisions. The safe initial decision is exclusion.

If scaled UI or pausable issuer-like fixtures are added, require raw-integer settlement, display conversion tests, multiplier/config change invalidation and paused/refund scenarios. Display amounts can fail to round-trip; they are never the source of settlement amounts. Do not describe basic SPL success as support for all tokenized-stock issuers.

## 4. Invariant register — conditions that may never be relaxed

These are design obligations and test targets. Runtime enforcement plus repeated testing reduces risk; it is not a mathematical proof that every possible execution is secure. IDs must appear in relevant tests and task evidence.

| ID | Invariant and enforcement | Required attempt to break it | Gate |
|---|---|---|---|
| S01 | All signing/deployment/broadcast uses local validator or verified devnet genesis and configured program identity | Wrong RPC/genesis, mainnet config, stale browser setting, mainnet-built route transaction | Every write path; G0/G4/G5 |
| S02 | Only the actual owner can create/fund or cancel the owner's mandate | Wrong signer, substituted owner, forged client flag | Every lifecycle change; G1/G2 |
| S03 | Funded authorization is immutable and binds exact assets, amounts, recipients, domain, expiry and routes | Change one field after review; reorder assets; hash ambiguity; wrong deployment | Schema changes; G1/G2 |
| S04 | An intent is consumed at most once and cannot be revived after closure | Replay settlement/cancel, old nonce, duplicate batch entry, reinitialize closed PDA | G1/G2; every release |
| S05 | Expired/cancelled/unfunded intents cannot settle | Boundary timestamps, future clock assumptions, cancel/settle race | G2/G4 |
| S06 | Each asset balance is conserved under permitted transfers; no unexplained mint/burn, drain or subsidy | Missing output, wrong mint, unsolicited vault donation, surplus extraction, fabricated starting balance | Every settlement test; G2/G3 |
| S07 | Every owner's actual final output satisfies all signed min/max bounds | One-unit violation, omitted asset, wrong recipient, apparently good batch total hiding one user's loss | Every settlement; G2/G3 |
| S08 | Amount arithmetic cannot overflow, underflow or silently lose precision | Zero, one unit, maximum values, mixed decimals, negative/NaN/infinity off-chain | Unit/property tests; schema change |
| S09 | Rounding and dust have deterministic disclosed ownership | Input permutation, many tiny fills, dust as disguised solver fee | G2/G3 |
| S10 | All account identities and roles are verified; aliases cannot bypass balances | Duplicate vault/destination, malicious token program, wrong PDA seeds/owner, arbitrary account metas | Money-path review; G2 |
| S11 | Any failed settlement leaves pre-transaction token/state balances intact, excluding network fees | Failing final leg, route min-out failure, stale oracle, last recipient invalid | Integration; G2/G4 |
| S12 | Refunds cannot be disabled by a solver, unrelated failed order or global settlement pause | Solver offline, config pause, rejected batch, missing recipient ATA | G1/G2/G4 |
| S13 | Prices are authentic for the permitted feed and bound to the verified bytes | Forged update, swapped feed, wrong verifier/instruction index, fixture in live mode | Oracle changes; G3 |
| S14 | Price age, confidence, exponent and market-session policy are enforced | Fresh wrapper/stale underlying, extreme exponent, future timestamp, wide confidence | G3/G4 |
| S15 | External routing cannot spend outside declared vaults or keep unallocated proceeds | Malicious adapter/pool/accounts, over-debit, fake quote, route callback/reentry path, nonzero transient residue | Adapter change; G2/G3 |
| S16 | Unreviewed mint extensions/configurations are rejected | Transfer-fee mint, hook, multiplier/config change, paused/frozen account | Asset change; G2/G4 |
| S17 | User keys never reach solver/logs; server API keys never reach client bundles | Secret scan, inspect built assets/errors/network responses, missing-key path | Every merge/release |
| S18 | A UI success claim matches reconciled chain state and intended transaction | Timeout after send, expired blockhash, duplicate click, refresh, reorg/commitment handling | G4/G5 |
| S19 | Baselines use identical feasible mandates, market state and cost treatment | Give cooperative planner looser bands, omit its extra fees, compare against deliberately poor orders | Economic changes; G0/G3 |
| S20 | Claimed savings distinguish modeled, replayed and realized quantities | Synthetic screenshot presented as live liquidity; inferred counterfactual presented as executed | G3/G5 |
| S21 | Batch-level benefit does not conceal worse per-account outcomes | One participant benefits while another pays disproportionate cost; alternative cost allocations | G0/G3 |
| S22 | Admin/config powers cannot silently weaken existing approved mandates | Upgrade/config/feed/route change with outstanding escrow | Configuration change; G2/G5 |
| S23 | Public demo operations have bounded resource use | Huge asset lists, oversized request, infeasible solver, API flood, repeated retries | G3/G4 |
| S24 | A deployed artifact is traceable to tested source/config and supported capacity | Wrong binary/IDL/program ID, late untested hotfix, oversized Pyth+route transaction | Every deploy; G4/G5 |

S21 is not a claim that all participants always save money. Report each participant's costs, tracking deviation and allocation. The hard protection is the explicitly approved mandate; if we additionally claim “no participant worse off,” define the same-state baseline and enforce/test that extra constraint in the planner. Do not infer individual rationality from aggregate savings.

Upgradability requires honesty: a retained upgrade authority is a trust assumption. Keep its devnet key local and separate, show its status, forbid upgrades with outstanding funded intents, and drain/refund before replacing a deployment. Do not claim upgradeable escrow is trustless. A fresh program/config identity requires fresh user authorization; do not migrate funds automatically.

## 5. Economic validation before expensive implementation

The early question is not whether the optimizer can output numbers. It is whether the cooperative adjustment mechanism adds useful value after stronger alternatives and added costs are considered.

### Evaluation contract

1. Construct a tiny hand-solvable example and enumerate feasible discrete trades or use an independent reference calculation. Demonstrate how each baseline is derived.
2. Keep identical portfolio feasibility constraints. Avoid a zero-trade “win” when rebalancing was required. Show target error/risk before and after, not only turnover.
3. Separate internal crossing benefit from **additional** cooperative-adjustment benefit: report independent minus fixed-netting, then fixed-netting minus cooperative.
4. Account for external spread, modeled price impact, venue fees, network/priority fees, extra funding/settlement transactions, waiting delay and failure/retry overhead. One-time rent is a recoverable deposit where appropriate; show upfront required SOL separately from recurring cost.
5. Display per-account results and the explicit allocation rule for shared external costs and rounding. Zero protocol fee does not mean zero execution cost.
6. Freeze scenario definitions and evaluation criteria before tuning. Commit a train/dev set and a held-out set with seeds, input hashes and provenance. Avoid repeatedly tuning against the held-out set.
7. Evaluate balanced opposing flows, all-buy/no-match, thin liquidity, high fees, tiny portfolios, one dominant account, extreme target bands, infeasible constraints, zero holdings, expired prices and insufficient compatible participation.
8. Report sample count, median/range/negative cases and sensitivity to uncertain costs. More synthetic samples do not make the data real. Treat statistical intervals as conditional on the scenario model.
9. Recompute selected outputs using an independent checker that validates feasibility and accounting without calling the optimizer's own validation routines.
10. Preserve raw inputs and outputs so a judge can reproduce the result from a fresh checkout.

Do not copy a paper's experiment and claim it proves the app's live benefit. The [cooperative transaction-cost paper](https://arxiv.org/abs/2603.07881) motivates the mechanism; its assumptions and reference implementation need review. A public repository without a clear license is not permission to copy code. Cite mathematical inspiration and verify the license before reuse.

### Go / revise / stop rules

**G0 economic pass:** at least one independently checked nontrivial case has strictly lower modeled total cost than fixed-order netting after declared overhead, while all three satisfy the same mandates. Include a no-benefit control. This establishes feasibility, not prevalence.

**G3 claim pass:** the frozen representative suite and held-out evaluation are complete, with feasibility, per-account outcomes, negatives and sensitivity reported. Any headline percentage names its dataset and assumptions. If benefits disappear under modest fee/latency changes, say so and narrow the product use case.

**Revise:** if savings only come from inflated baseline spreads, relaxed constraints, hidden costs or cherry-picked seeds, repair the experiment before more UI work. If the honest result is ordinary netting with no meaningful adjustment gain, remove the cooperative-superiority claim and reassess the product narrative. Do not present a weaker result as if the initial hypothesis succeeded.

**Stop expanding:** if no defensible incremental example survives a bounded two-attempt research spike, stop optional build work and bring the concrete results and smaller alternatives to the user. Do not burn the remaining deadline concealing an invalid premise. Core safety work and evidence organization can continue independently.

### Demand and payment evidence

Potential customers and willingness to pay remain hypotheses. Produce a one-page operator workflow and a short validation script asking how strategies are currently rebalanced, what execution costs matter, what controls are essential and whether measured savings justify a fee. No unsolicited outreach is authorized. If the user obtains feedback or explicitly authorizes outreach later, record consented, anonymized findings and contradictions. Without that evidence, pitch the operator segment and pricing hypothesis as a hypothesis; do not invent interviews, customers, revenue or testimonials.

## 6. Check cadence and definition of done

“Run tests” is insufficient. Each task must name the failure modes it checks, the evidence it saves and who reviewed it. Planned check commands in the task ledger are interfaces to implement; **they do not exist yet merely because the plan names them**.

### Before each task

- Read its requirements, dependencies, touched invariants and previous evidence; verify prerequisites against the current commit.
- Confirm file ownership with concurrent workers, and reserve shared schema changes for a single owner.
- State the intended behavior and expected failure behavior. Add meaningful regression cases before or with the implementation.
- Confirm network/cost constraints and the current feature-freeze position. Do not start an optional task when its cutoff has passed.
- For external SDKs, check the pinned version and official interface rather than relying on stale examples.

### After each task

1. Inspect the diff for unrelated edits, accidental generated files, secrets, changes to public interfaces and weakening of assertions.
2. Run the task's targeted positive and adversarial checks plus formatting/type/build checks for the touched components.
3. Run relevant regression tests for every affected invariant; changed monetary arithmetic requires unit, independent-reference and property checks.
4. Record command, exit status, commit/tree identity, versions, seed, fixture/config hashes and expected/actual output. Attach a failure artifact for any repaired defect.
5. Obtain independent review for authorization, token transfers, arithmetic, oracle validation, routes, upgrades and network guards. Another AI reviewer is acceptable if it sees the contract and diff independently; do not call a self-review independent.
6. Update requirement/task status, unresolved issues and the next handoff. A task with skipped mandatory checks is **blocked**, not done.
7. Make a small reviewable commit when implementation begins and repository policy permits; do not mix several unrelated unfinished tasks into one commit.

No task closes on “looks good,” screenshots alone, a successful compile or the implementer's confidence. A valid completion statement is: behavior implemented; named checks passed; evidence location; reviewer; remaining limits.

### At integration boundaries and regular intervals

| Trigger | Checks | Failure action |
|---|---|---|
| Every pull request/integration commit | Deterministic fast suite, schema compatibility, secret scan, changed invariant tests | Block merge; no bypass to meet schedule |
| Every authorization/accounting/schema change | Cross-language vectors, all lifecycle tests, malicious account substitution, decimals/rounding boundaries | Invalidate dependent fixtures and prior integration sign-off |
| Every two active working hours | Update actual progress, critical path, cost/quota ledger, blockers and cut list | Reassign or reduce optional scope; avoid status theatre |
| Every four active working hours with integrated changes | Full local end-to-end suite plus representative adverse scenarios on that snapshot | Hold downstream integration until reproducible failure fixed |
| Each stable daily/freeze candidate | Longer seeded property/adversarial suite, clean startup, dependency/reproducibility check | Record seed; repair root cause and replay nearby cases |
| Before every integrated/public devnet deployment (isolated probes use the scoped policy above) | G2 money-path suite, review, artifact identity, no outstanding funded intents in replaced deployment, verified devnet genesis | Abort deployment on mismatch |
| After every devnet deployment/config change | Initialize once, valid settle, invalid settle, cancel/refund, complete Pyth/route transaction measurement | Disable settlement and recover intents if unexpected behavior |
| Before every public demo/release | Fresh wallet flow, secret checks, claim/evidence audit, recovery link, source-to-binary/IDL manifest | Use last validated release or disclose reduced scope |

Do not rerun expensive suites endlessly against an unchanged commit. The purpose is to catch new integration risks. A stable candidate should pass at least three consecutive complete devnet scenario runs, including a rejected settlement and recovery, with transaction links and balance reconciliation. This is a reproducibility threshold, not proof of reliability under all network conditions.

### Failure classification and handling

- **Critical:** unauthorized asset movement, mainnet write path, exposed signing key or funds permanently unrecoverable due to our logic. Stop all signing/deployment; preserve evidence; contain exposure; repair and independently re-review. Rotate a leaked key without printing it. Do not erase the incident to make the report look clean.
- **High:** mandate bypass, incorrect accounting/price authentication, replay, broken cancellation, or a materially false economic claim. Block integration/release until fixed and regression-tested.
- **Medium:** a recoverable operational defect, incorrect noncritical status or missing error path. Fix before the affected workflow is demonstrated; an unrelated feature may continue.
- **Low:** polish/documentation issues with no material behavior or claim impact. Track and timebox.

For a repeat failure: preserve failing seed/input; isolate it; implement the smallest cause-level fix; add a regression; rerun the targeted and affected integration suites. After two unsuccessful fix attempts, obtain a fresh review rather than repeatedly weakening the test. Safety invariants cannot be waived to meet a deadline. Optional features can be removed.

## 7. Formal phase gates

Every gate record contains PASS / FAIL / EXCLUDED (only for optional/conditional scope), evidence, reviewer and date. No “mostly passed.” Planned gates below remain unpassed until execution evidence exists.

| Gate | Preconditions and acceptance | Evidence | Decision on failure |
|---|---|---|---|
| G0 — feasibility | Zero-spend stack; working local toolchain build; published rules/deadline snapshot; Pyth access outcome; independent incremental economic example and no-benefit control | Environment manifest, entitlement result without secrets, tiny example and inputs, cost ledger | Narrow integration or revisit economic premise; no large build on assumptions |
| G1 — walking slice | Canonical mandate frozen; local owner fund, bounded valid settle, invalid settle rejection and owner refund; nonce and precision vectors pass | Local tx/state logs, schema vectors and minimal UI/CLI walkthrough | Repair lifecycle before parallel expansion |
| G2 — settlement safety | S01–S12/S15–S17/S22/S24 relevant mandatory paths pass; independent money-path review; complete transaction capacity measured | Attack matrix, property seeds, reviewer report, balance reconciliation and capacity limits | Block devnet feature release; reduce capacity if needed |
| G3 — economic and integration truth | Three baselines, independent feasibility checker, held-out report, per-account outcomes; real authenticated Pyth or explicit exclusion; route net-delta tests | Reproducible benchmark command, source data/provenance, Pyth/route evidence | Fix misleading claims; exclude inaccessible integration; keep safety gates |
| G4 — usable devnet system | Three complete repeat runs; fresh-wallet/refresh/timeout/duplicate-click/recovery cases; no private keys in services; supported batch fits with margin | Explorer links, UI test/video, resource measurements, runbook | Use smaller validated batch/asset set; no hidden mock success |
| G5 — release/submission ready | Zero critical/high open issues; clean-checkout reproduction; demo video/backups; claims linked to evidence; source/license/limitations complete; verified submission requirements | Release manifest, checklist, final artifact links and checksum | Fall back to last validated release and disclose omissions |

Gate ownership: implementer prepares evidence; an independent reviewer assesses money-path/claim gates; the coordinator verifies dependencies and updates state. The user approves new spending, material product pivots or external submission, not every routine passing test.

## 8. Threat-driven test and evidence strategy

### Test layers

**Pure/unit:** canonical encoding, hashing, raw-unit parsing/formatting, rounded allocation, target conversion, expiry and price policies, error mapping. Use hand-calculated vectors and big-integer/reference arithmetic where useful.

**Program integration:** real token programs on a local validator; valid lifecycle and every forbidden transition; malicious accounts; replay; authority checks; CPI failure rollback; close/rent refund; config changes with outstanding intents. Mocks alone cannot validate token authority or CPI behavior.

**Property/model tests:** generate bounded portfolios and compare conservation, final mandate compliance and lifecycle behavior against an independently written model. Include decimal/amount boundaries and input permutations. Save each failing seed. Fix a practical reproducible seed count in T00 according to runtime; disclose it, and increase it for freeze candidates rather than pretending a count guarantees safety.

**Service/UI tests:** malformed requests, solver timeout/nonconvergence, infeasible mandate, stale prices, rate limits, disconnected wallets, rejected signature, duplicate submit, RPC send timeout with later confirmation, expired blockhash, refresh after funding and lost local storage. Reconstruct from chain state, not browser memory alone.

**Devnet integration:** proves deployed account identities, authenticated-price plumbing if enabled, actual token transfers, transaction size/compute and explorer evidence. Public-network timing is nondeterministic; keep deterministic local regressions separate. A recorded local pass cannot substitute for a claimed devnet pass.

### Evidence layout to create during implementation

`artifacts/tasks/<task-id>/<commit>/` — acceptance record, logs, reviewer notes and fixture hashes.

`artifacts/security/<release>/` — invariant-to-test matrix, attack cases, findings and retest evidence.

`artifacts/benchmarks/<run-id>/` — raw inputs/outputs, seeds, environment, model assumptions and rendered report.

`artifacts/devnet/<release>/` — deployment manifest, transaction signatures, balances, compute/size data and recovery checks.

`artifacts/release/<release>/` — exact submission text/video/source links, license record and final checklist.

Never store seed phrases, signing-key JSON, API keys, auth headers or unredacted sensitive participant data in evidence. Public addresses/signatures are appropriate for devnet receipts. Document which generated artifacts should be committed, attached to a release or ignored to keep the repository usable.

### Runtime protections

Settlement must stop on stale/unverified price, unexpected mint state, missing authorization, excessive route slippage, invalid config or exceeded capacity. Surface a specific reason and safe next action; do not turn these errors into a spinner or silently retry forever. The solver has bounded input sizes/timeouts, request limits and cancellation. Price/API failure cannot disable owner refunds. A public recovery page or documented direct client command must work when the solver is offline.

The UI distinguishes draft, awaiting signature, funding submitted, funded, settlement submitted, confirmed, finalized, expired and refunded states. Confirmed results may be shown with that label; a “finalized” receipt requires finalized reconciliation. Ambiguous submission status triggers signature/account lookup before any new transaction is built.

## 9. Agent collaboration and change control

Assign bounded work by module: program owner, numerical/benchmark owner, client/UI owner and independent reviewer. Workers read the same requirements and canonical schema fixtures. They must not revert each other's changes. No two workers edit shared contract schemas concurrently.

Each assignment includes task ID, permitted files, dependencies, invariants, expected outputs, exact check commands and stop conditions. Handoff includes what changed, commit/diff, tests actually run, failed/skipped checks, known issues and next action. “Done” without evidence is rejected.

Use isolated branches/worktrees for implementation when helpful, with the configured `codex/` prefix if branches are created. Merge only after dependency/interface checks. Parallelism follows the task graph; a frontend can use versioned mock fixtures while a program is being built, but its integration gate waits for the actual deployed contract.

Changes to asset support, authorization, cost allocation, oracle policy, batch size or claims require a short decision record: reason, affected requirements/invariants, migration impact, newly invalid evidence and new checks. A schema change invalidates dependent snapshots and must not silently reuse an old user approval. Minor presentation changes need only the appropriate UI checks.

If an agent is interrupted, update STATE and task evidence before handing off. On resume, inspect current files and live devnet state; do not redeploy, recreate escrows or repeat a transaction just because the last message was incomplete.

## 10. Demo and submission runbook

### Three-minute narrative

**0:00–0:25 — Problem.** Show three strategy accounts independently paying spread/impact for partially offsetting rebalances. Explain the operator and constraints in plain language.

**0:25–1:05 — Difference.** Compare independent execution, plain netting and cooperative adjustment. Highlight one concrete, independently reproducible difference while showing the unchanged target limits. Label the cost model and test assets.

**1:05–1:55 — Actual workflow.** Review one owner's mandate, approve, show funded intents and execute the bounded devnet batch. Display the receipt and explorer transaction with per-account before/after balances.

**1:55–2:25 — Trust.** Try an out-of-bounds or stale-price settlement and show it rejected. Show owner cancellation/refund. Explain that the optimizer cannot override approval.

**2:25–3:00 — Evidence and honest limits.** Show incremental savings across the disclosed suite, a no-match case, integration provenance and the next real user hypothesis. Keep the market opportunity grounded rather than promising universal cheaper trades.

### Rehearsal checklist

- Prepare dedicated devnet demo wallets and sufficient faucet SOL early; never display private keys. Confirm each is on the correct cluster.
- Reset fixtures through a deterministic explicit command and show the exact scenario version. Never mint/reset in the middle of a run without disclosure.
- Verify real-price entitlement and freshness shortly before recording. If unavailable, switch the entire presentation to the labelled validated fixture mode and remove the live-Pyth claim.
- Open links in a fresh browser, verify wallet review text and test keyboard/readable error states. Check secret-free browser bundle and server logs.
- Run the core scenario three times, including rejection and recovery, without undocumented manual repair. Record failures as well as fixes.
- Capture a clean screen recording, exported economic chart with provenance and a local startup backup. Do not manufacture a success clip from unrelated transactions.
- Check microphone/text size, concise narrative, video duration/file format and exact submission requirements against the official form.
- Validate the public demo if one is hosted for free; provide a local runbook regardless. An inaccessible host must not make the source unreproducible.

### Submission package acceptance

Include a concise problem/user statement, architecture, runnable source, dependency/license attribution, environment template without secrets, devnet program/config/transaction identities, demo video, benchmark instructions and a limitations section. Record which track requirements are demonstrably met, which are conditional and which were excluded. Sponsor acceptance is not implied by technical integration.

Explicitly disclose test assets, synthetic liquidity, oracle mode, batch capacity, retained upgrade authority, unsupported extensions, absence of production audit and any remaining operational limitation. Use actual measured numbers only. Treat customer/payment assumptions and production liquidity as future validation work.

The final claims audit checks each sentence in the pitch: **implemented → transaction/test evidence; measured → reproducible data; inferred → labelled reasoning; future → clearly future.** Remove anything that cannot be classified honestly.

## 11. Fallback hierarchy

| Problem | Approved response | Unacceptable response |
|---|---|---|
| Pyth trial lacks required equities or expires | Label test oracle; drop Pyth submission claim; retain oracle failure tests | Buy a subscription silently or pass off a mock as Pyth |
| DBC configuration/compatibility uncertain | Cut DBC; keep controlled residual venue | Add a cosmetic SDK import and call it integration |
| Three-wallet full transaction exceeds capacity | Reduce tested batch or assets and disclose maximum | Commit separate legs and describe them as atomic |
| Public devnet/RPC unavailable | Back off; preserve prior valid devnet evidence; use labelled local recording for continuity | Fabricate explorer evidence or route to mainnet |
| Solver finds no meaningful incremental savings | Publish honest result and narrow/revisit value proposition with user | Weaken baseline or hide adverse cases |
| UI behind schedule | Keep simple review/approve/receipt/recover screens | Remove authorization visibility or recovery |
| Release candidate has security failure | Revert to validated smaller candidate, retest, disclose scope | Waive a security invariant to finish the demo |
| No free public hosting | Local demo plus video and reproducible runbook | Make paid infrastructure an implicit requirement |

## 12. What “ready to build” and “done” mean

This plan is ready when task dependencies are complete, requirements have owners/checks, invariants have test targets, external assumptions have explicit gates and an independent reviewer has no unresolved blocking plan issue. That says nothing about whether implementation already passes.

The project is done for this hackathon when G0–G5 evidence exists for the delivered scope, the final workflow works on devnet, recovery is demonstrable, economic claims survive fair comparison, and the submission package can be checked by someone who never read our conversation. Optional exclusions must be explicit. A beautiful interface cannot compensate for an unproven benefit, unsafe authorization or invented integration.

Start execution at **T00**, not by adding features. The first result we want is a small, honest, testable CrossFlow foundation that earns the right to become larger.
