# CrossFlow v1 — exact settlement and reference accounting

Companion to intent-contract.md. Specification candidate; no runtime checks are claimed yet. Raw token amounts are the sole transfer authority. Stock and cash units are never added directly. Every summation/multiplication/division uses checked u128 intermediates; CPI amounts and stored token balances use checked u64 conversion. No floating point appears in on-chain authorization or the independent acceptance validator.

## 1. Assets, immutable funding and explicit flows

For owner i and asset a: F[i,a] is immutable booked funding; L/U are approved minimum/maximum outputs. D/C are **derived** batch debits/credits, never a free solver distribution; O is the authorized output. F/L/U/D/C/O are raw units, each 0–MAX_AMOUNT (10^12), with D <= F and L <= U. Initial vault balance V0 must be >= F. `surplus = V0 - F` belongs to that owner and is excluded from valuation, routing, allocation and output bounds. Pre-funding donations obey the same rule. A donor cannot satisfy a minimum or increase solver spending authority.

All intents share config/policy/assets and fixture mode and remain Funded/unexpired. Order owners by raw public-key bytes and assets by raw mint bytes. At most three owners and three assets; exactly one asset is cash. Product scenarios need at least two owners; one owner is a technical probe only. Every input owner index is resolved through that validated batch order, not a caller-selected unrelated account.

### Internal cross record

Each record contains `stock_index u8, seller_index u8, buyer_index u8, stock_quantity u64 LE, cash_amount u64 LE`. No implicit prices or free cash credits. Both amounts are positive and <= MAX_AMOUNT. Stock index identifies one of the two noncash configured assets; seller != buyer; both belong to batch. Maximum six records. Order records strictly by `(stock_index, seller_index, buyer_index)` and reject duplicate tuples. No owner may both buy and sell the same stock anywhere in a batch, including its residual participation; this prevents round trips and hidden cycle allocations. With three owners this rule can reduce the achievable record count below six, which is a capacity ceiling rather than a required count.

A cross `(s,b,a,q,k)` creates exactly these four booked entries:

- `I_D[s,a] += q`, `I_C[b,a] += q`.
- `I_D[b,cash] += k`, `I_C[s,cash] += k`.

All other entries are unchanged. Every record passes its own snapshot-price band in section 5. No whole-portfolio loss guard can substitute for this per-record check. Internal stock/cash transfers may be implemented through the pooled vaults, but their ledger contribution remains these exact entries; there is no arbitrary credit-weight instruction field.

### External residual record

At most two records, at most one per stock, ordered by stock index. Each contains `stock_index u8, direction u8 (0 sell stock, 1 buy stock), minimum_output u64 LE, input_allocations[batch_count] u64 LE`. Positive input allocations identify participating owners; zeros identify nonparticipants. Each input allocation <= MAX_AMOUNT. `X = sum(input_allocations)` must be positive and <= 3×MAX_AMOUNT; minimum_output must be positive and <= 3×MAX_AMOUNT. X is the **exact input** sent to the pinned venue. Direction determines stock/cash input/output assets; stock-to-stock, cash-to-cash, cycles and multiple legs for the same stock are forbidden.

For each participant i, book `R_D[i,input] += x[i]`. After the CPI, actual output Y is allocated by the deterministic pro-rata rule in section 3, using **x themselves as weights**; no alternate weights or output beneficiary choices are accepted. Book `R_C[i,output] += y[i]`. A zero input always gets zero output. Each nonzero participant's derived `(stock_quantity,cash_amount)` also passes the separate external execution band; a positive input yielding zero output rejects. Thus external fees/slippage are shared by actual input contribution, subject only to deterministic one-raw-unit residue. A caller cannot move the cost to a different owner using hidden credit weights.

For each owner/asset derive:

`D = I_D + R_D`

`C = I_C + R_C`

`O = F - D + C`

There are **no additional flows**: no unpaired gifts, no solver fee, no redistribution of reference profits, no residual cash subsidy. A solver proposal can choose crossings and residual participation only if all derived bounds and independent price checks pass. Debit must be funded from original F; anticipated credits cannot be reused as new debits in the same batch. An owner may sell one stock and buy another, but must initially fund the full required cash debit. Off-chain economics must apply this execution restriction identically when claiming executable A/B/C outcomes.

## 2. Exact atomic algorithm

1. Validate all account roles, mandate/config hashes, status/nonces, policy, snapshot identity/sequence, pause bits and expiry **before transfers**. Validate cross ordering/identities/amounts and every per-cross price inequality. Derive I_D/I_C/R_D, stock direction consistency and complete D; reject any D > F or bounds/cap violation. Set an execution latch; any nested settlement/recovery/sweep/admin entry while latched rejects. Rollback clears the latch on failure.
2. Snapshot every intent vault and fixed recipient. All batch vault balances must initially be zero. Record owner surplus as V0-F. Transfer exactly D from each intent vault to the corresponding batch vault. Reload balances: each reduction must equal D, each batch increase must equal sum D. This is the only intake of intent value.
3. Execute each admitted residual leg from the batch PDA. T10 freezes concrete controlled venue ABI, fee schedule, reserve model and policy binding; T16 integrates the actual CPI. Validate executable program, pool owner, authority/vault identities, canonical token program/state and all aliases. Only pinned accounts and typed arguments are forwarded; never owner recipients, intent state or intent PDA signer authority. No arbitrary instruction bytes or account list.
4. For each CPI, reload **all three** batch balances. Actual input reduction must equal X; actual output increase Y must satisfy Y >= minimum_output and Y > 0; third asset must not change. Reject any batch post-balance or Y >3×MAX_AMOUNT. Record E[a], signed external inflow minus outflow. Network fees are separate; venue fee effects are already in measured X/Y and cannot be deducted again. Snapshot/recheck excluded intent/recipient/state accounts. Reconcile actual venue vault deltas with the pinned T10/T16 fee model.
5. Derive y[i] pro rata from measured Y and x[i], then R_C, C and O. Each external participant must pass the external price band and each owner/asset must satisfy L <= O <= U, O/C <= MAX_AMOUNT. Apply the additional per-owner whole-slice value-loss guard. No successful aggregate permits a failed individual check.
6. Reload each batch pool Q. Require **exactly** `Q[a] = sum_i C[i,a]`, and `sum C - sum D = E` per mint. Internal I_D/I_C already cancel; this condition prevents a route from consuming internally owed value or fabricating unpaired credits. A mismatched quote cannot be patched by allocating unexplained money after CPI.
7. Transfer C from batch vaults to intent vaults, then O to each owner's fixed ATA. Reload and require recipient delta exactly O, each intent vault exactly its starting surplus and each batch vault exactly zero. Pre-existing recipient balances never contribute to minima. Zero O means a required zero delta, not omitted validation. Any final transfer failure or mismatch rolls back the entire transaction.
8. Mark intents Settled, booked claims zero; retain active intent/counter until complete surplus recovery/closure. Emit mandate/policy/snapshot hashes, every cross record, residual inputs/actual outputs/per-owner allocations and D/C/O. Clear latch. State/token changes commit atomically; a failed transaction may still charge network fees.

No-route case: residual arrays are empty, E=0, R_D/R_C=0, so D=I_D and C=I_C. Internal entries guarantee sum D=sum C per asset, and every stock and cash transfer has an identified counterparty. Zero residual for one stock means omit that stock's external record; a zero-X placeholder is rejected. An all-zero-flow proposal is valid only if all immutable final bounds and guards already accept F; it cannot satisfy a required rebalancing minimum or be advertised as savings from execution. Zero-funded slices are rejected at funding independently.

## 3. Pro-rata external allocation, rounding and dust

For a residual leg, X=sum x[i]>0 and measured Y>0:

`base[i] = floor(Y * x[i] / X)`

`remainder[i] = (Y * x[i]) mod X`

`leftover = Y - sum(base)`

Initialize y=base, then add exactly one raw unit to the first `leftover` participants sorted by descending remainder, ties by ascending raw owner bytes. Zero-input owners are excluded. `0 <= leftover < number_of_positive_inputs`. Checked u128 arithmetic is used. Reordering caller accounts cannot change results because validated owner keys fix ties. Any bound or per-leg price violation caused by rounding rejects the entire batch; do not silently reassign dust or waive a guard. Positive input receiving zero output rejects. This may make tiny residual trades infeasible, which is preferable to hidden subsidization.

Examples: Y=10, inputs=(1,1,1), owners A<B<C gives (4,3,3). Y=5, inputs=(1,2,0) gives (2,3,0). Rounding benefits/costs are displayed per owner, not presented as perfectly equal execution prices. Each y belongs to the owner who contributed x, and is included once in C/O and realized venue execution shortfall. Internal crosses use explicit integer q/k and perform no allocation rounding; if no integer cash amount fits the approved cross band, reject that proposed cross.

## 4. Conservation and explicit execution-cost attribution

For every asset, internal entries cancel: `sum I_D = sum I_C`. Each external input/output appears once: `sum R_C - sum R_D = E`. Therefore `sum O = sum F + E`, per mint. Actual recipient deltas equal O, final intent vaults equal surplus and batch vaults are zero. Fees within actual X/Y are not added to E again. Stock and cash units cannot be combined without section 5's valuation.

Define signed cross cash premium at the current snapshot as `premium = cash_value(k) - stock_value(q)`. Seller receives that premium and buyer pays exactly the same premium; display it as an internal allocation difference, **not a venue cost or system saving**. The per-cross band bounds it explicitly. For each external participant, derive signed venue execution shortfall `shortfall[i,leg] = value(x[i],input) - value(y[i],output)`. Sum over owners equals the leg's actual reference input value minus actual output value exactly; dust creates only the disclosed per-owner raw-unit differences. This number includes fee and slippage together; claim a separate fee only if the pinned ABI and actual venue deltas establish it without double counting. Negative shortfall means price improvement and is displayed as such, not clipped to zero.

For each owner, same-snapshot `value(F)-value(O)` must equal the sum of that owner's external shortfalls plus internal premiums **paid minus received**. This identity is independently checked in the executable proposal validator and receipts, and program accounting/price checks enforce the corresponding exact D/C flows. No arbitrary credit weights can replace either component. If a benchmark uses a different cost allocation, label it research-only until converted into these executable flows and validated identically for A/B/C.

Recovery after Cancelled returns each asset's complete current vault balance (F plus donations) to its fixed ATA independently. A failed transfer preserves that asset's claim. After Settled only surplus remains. Later donations remain recoverable before closure; old-nonce closed-vault recovery preserves owner control afterward. Rent is SOL with its own fixed beneficiary, outside this portfolio/cost ledger.

## 5. Fixture oracle, per-cross bands and whole-slice guard

V1 supports fixture mode only. A CrossFlow-owned `[b"prices", config_address]` PDA stores policy_hash, monotonically increasing sequence u64, configured fixture publisher, sorted asset/feed identities, prices, confidence, underlying_observed_at, published_at and market_closed. Only the configured publisher signer updates it; timestamps and sequence cannot regress or wrap. Funding/settlement validate exact account owner/PDA/policy/feed binding. A caller's `verified=true` is meaningless. Snapshot sequence in the settlement request must equal the state read; an update between quote and execution requires re-quoting. This is an authenticated **test publisher**, not equity market data.

T14 implements and tests this exact fixture interface before T05 funding. Required graph: T14 depends on T02+T04; T05 depends on T04+T14. T15 conditional Pyth access/authentication is **not** a funding prerequisite and may be explicitly excluded. Pyth remains rejected until T15 passes its real verification/admission gate.

Times are nonnegative Unix seconds; reject a negative on-chain Clock. For both stock observation timestamps: underlying <= published; each <= now+future_skew; now <= timestamp+max_age, all checked. Age60 equality passes under default age60, age61 fails; expiry equality fails. A fresh publication with stale underlying fails. market_closed rejects funding/settlement. Cash fixture timing follows the snapshot schedule, without claiming a real stablecoin feed.

Prices p are integer millionths of test USD per whole token, range1..10^12; confidence0..p. Require `c*10000 <= p*max_confidence_bps`. Cash p=1,000,000,c=0. Funding reference p0 equals that owner's fresh validated funding snapshot. Current-versus-funding reference movement separately obeys `abs(p-p0)*10000 <= p0*max_reference_move_bps` for every asset/owner. Neither freshness nor this movement check limits the price of an individual trade: the following per-record inequality does.

For raw amount x and decimals d in0..9 define exact common value `V(x,a)=x*p[a]*10^(9-d[a])`. Its unit is 10^-15 test USD; no division/rounding occurs. For **every** internal cross q stock/k cash define S=V(q,stock)>0 and K=V(k,cash)>0; require:

`S*(10000-max_cross_deviation_bps) <= K*10000 <= S*(10000+max_cross_deviation_bps)`

Policy v1 has max_cross_deviation_bps=100, admission range0..100. Equality is accepted on either boundary; one cash raw unit outside rejects. Also test stock-raw-unit boundary movement independently. A zero configured deviation requires exact equality; do not round a nonrepresentable cross into acceptance. This policy is committed in policy_hash and cannot be widened during escrow.

For every nonzero external participant use its actual stock amount and cash amount: on a sell q=x, k=y; on a buy q=y, k=x. Require the **same inequality with max_external_deviation_bps** (v1 default200, admission0..200), after allocation and before final transfers. This separately limits fees/slippage at each owner's actual execution price. The route minimum_output may be stricter, never weaker. Every trade's q/k is derived from actual contributed/allocated amounts; no whole-slice substitute and no unrelated funding can dilute a bad execution. The aggregate actual leg must also satisfy that band as a redundant independent assertion.

Additional whole-slice protection remains: at the same current snapshot let VF=sum V(F), VO=sum V(O); require `VO*10000 >= VF*(10000-max_value_loss_bps)`. This restricts total execution loss but is **not** equivalent to the per-cross or per-external checks. Three assets, MAX_AMOUNT10^12, price cap10^12 and maximum scale10^9 give VF/VO<=3×10^33; multiplying by10000 gives3×10^37 <2^128. An aggregate route input/output can be3×MAX_AMOUNT, so the largest band product is3×10^33×10200=3.06×10^37 <2^128. Still use checked arithmetic everywhere; surplus u64 balances are excluded from bounded valuation.

Counterexample required to reject: $10 stock reference, buyer funds $1,000 cash, seller funds $1,000 cash+one share, proposed internal q=one share/k=$11. Buyer ends$989+one share: only10bps total-slice loss; seller gains. Broad raw bounds, conservation and200bps whole-slice loss all pass. The cross price is10% high and MUST fail the100bps per-cross inequality. No large cash balance can legalize it.

T15's future Pyth adapter must authenticate native payload/verifier/feed and produce this T14 interface, retaining native exponents/confidence/timestamps in evidence. Unsupported exponents or normalization needing lossy truncation reject until an explicit conservative-rounding schema amendment is reviewed. Pyth uses a new committed policy/config identity, never silently reinterprets fixture mandates. T04 reserves estimates for full verifier+route transaction size/compute; only complete measured T15/T16/G2 evidence establishes supported capacity.

## 6. Implementation acceptance

Pure tests: shared bytes/hashes; integer boundaries; external pro-rata ties/permutations/zero inputs; per-cross and per-external equality/one-raw-unit-outside in both directions and mixed decimals; the $10/$11 counterexample; whole-slice equality; timing/confidence/movement boundaries; exact owner shortfall identity; no-route internal-only and one-zero-residual cases.

Program tests: fake owner/mint/config/PDA; wrong initializer before legitimate init; duplicate/reverse crosses; cross totals omitted from D/C; cash subsidy without matching record; internal versus external owner direction conflict; free-weight injection rejected; external output reallocated to a zero-input owner; actual X mismatch/Y belowminimum/thirdasset change; good aggregate hiding one owner failure; dust violating priceband; unmatched D/C pool residue; donations before/after closure; last-leg failure rollback; cancel/expiry/replay/pause recovery; config mutation with any claims; nonce/counter overflow; source-bound upgrade procedure. Expected balances must come from an independently written flow model, not the implementation under test.

## 7. T09 implemented internal batch (local validator evidence)

T09 implements steps 1, 2 (internal crosses only), 7 and 8 of the algorithm above. External
residual records are decoded for canonical-length proof and then rejected, because the committed
policy still carries `route_kind = 0` and zero route identities; T16 owns the admitted CPI.

Instruction `settle_batch(body: Vec<u8>)` takes the T11 canonical body
`[schema u8, batch_count u8, sequence u64, cross_count u8, crosses, residual_count u8, residuals]`
with a four-byte Anchor length prefix. Trailing bytes, an unknown schema, a batch count outside
1–3, more than six crosses and any residual record reject before account state is touched.

Internal crossings transfer directly between the two owners' own intent vaults. Both vault
authorities are funding intent PDAs derived from the stored nonce, so the fix the reviewer asked
for — derive, do not trust — holds without a pooled batch vault: each cross contributes exactly
`I_D[s,a] += q`, `I_C[b,a] += q`, `I_D[b,cash] += k`, `I_C[s,cash] += k`, and no caller-supplied
debit, credit or allocation-weight field exists. A pooled `[b"batch", config]` vault is not needed
for internal-only settlement and is deferred to T16, where a transient venue input must exist.

The raw instruction is authenticated exactly like `create_and_fund`: the current instruction must
be the top-level CrossFlow instruction whose data length is exactly the discriminator, the
four-byte body length and the body, so padded trailing bytes reject instead of being ignored.

Authority comes only from funded mandates. The batch instruction declares no signer account at
all: a submitter chooses crossings, never bounds, recipients or amounts, and the program still
requires every derived `O[i,a]` inside its signed `L/U`, at most `F` debit, and `sum(I_D) ==
sum(I_C)` per mint. Owners, owner states, intents, vaults and recipients must be unique, in
strictly ascending owner order, and derived rather than merely labelled. A batch of fewer than
two intents rejects: a single intents can carry no cross, so it would be a permissionless no-op
state transition. Single-owner settlement stays on the owner-signed `settle_thin` path.

After the crossings the program transfers each owner's `O` to that owner's stored canonical ATA
and then reloads every vault and recipient: each vault must end exactly at its owner-attributed
starting surplus and each recipient must gain exactly `O`. Any mismatch reverts the whole batch.
Intents move to `Settled` with cleared booked claims in the same transaction, so a second
settlement rejects with `Settle`.

Capacity: three owners and three assets need 29 accounts. With the measured 202-byte body the
legacy 1232-byte packet cannot carry it (a legacy encoding of the same instruction measured 1284
bytes), so the proposer must attach an address lookup table. The local evidence records the
measured serialized size, the consumed compute units and the lookup-table entry count, and T17
must repeat the measurement for the complete oracle-plus-route transaction before any capacity
claim is made for the composed workflow.

Evidence: `verification/evidence/T09-local-batch-output.json` is an isolated localnet transcript
with synthetic TEST PRICES, three funded owners, one explicit cross, fourteen target-program
rejections (ordering, duplicate group, above/below the signed bound, debit above funding,
round trip, cross price band, vault/recipient substitution, wrong mint, padded instruction,
snapshot sequence, residual record, pause, double settle) and a reconciled before/after balance
record. The identical instruction encodes to 1275 legacy bytes, above the 1232-byte packet
limit, which is why the proposer must attach a lookup table; the settled transaction measures
350 serialized bytes and 208,433 compute units. It is not devnet, not Pyth and not an
external-route demonstration.

## 8. T10 controlled residual venue

`programs/test-venue` is the labelled synthetic liquidity the core fallback calls for. It is not
an AMM, not a Meteora or Jupiter integration, and its reserves are test tokens. It publishes one
frozen quote model: exact-in, fee charged on the input, floored, against pairwise reserves.

- The pool address is the derived `[b"pool", mint0, mint1, mint2]` PDA for the sorted configured
  mints, and each pool vault is the canonical associated token account of that PDA. Neither the
  pool nor its vaults are caller-chosen.
- Reserves are the **measured vault balances**, never a separately stored number, so a donation
  cannot desynchronise the quote from the tokens the venue actually holds.
- The swap signer is CrossFlow's batch PDA. The venue spends only from that signer's canonical
  account for the input mint and pays only into its canonical account for the output mint, so a
  venue can never redirect funds to a third party.
- The handler re-reads the four token accounts after the two transfers and requires the exact
  measured deltas, and it rejects a measured output below the caller's `min_out`. Anchor caches a
  deserialized token account, so comparing the cached field would silently compare pre-transfer
  state; the venue reads the account data instead.

Evidence: `verification/evidence/T10-local-venue-output.json` records the seeded reserves, the
frozen quote, the measured output, the moved reserves, seven named target-program rejections
(empty reserve, substituted pool vault, redirected destination, minimum above the quote,
relabelled mint, equal direction, zero amount), 44,379 compute units and the built binary hash.
Composing this venue with CrossFlow settlement, the transient batch pool and the pro-rata
allocation remains **T16** and is not implemented; there is no devnet venue deployment.
