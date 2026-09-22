# CrossFlow v1 threat model and T02 review contract

Specification candidate. No production audit, token-issuer compatibility, live-price integrity or winning-hackathon guarantee is implied. The solver, proposed cross records and residual input allocations, route quotes, frontend requests and arbitrary account metas are untrusted. A user approves a funded slice and explicit raw bounds; preferences outside those bounds are not secretly enforceable on-chain.

## Trust boundaries and capabilities

- Owner controls funding/cancellation/recovery signatures. Program-derived escrow authorities temporarily control funded tokens. Solver stores no owner keys. An owner can always cancel an unsettled intent and recover admitted transferable assets independently of solver/admin/price availability.
- Config admin can pause new funding and settlement. Version/feed/route/identity changes require zero outstanding claim-bearing intents. Admin cannot weaken existing bounds, redirect refunds or withdraw escrow.
- The fixture publisher can set TEST PRICES within checked format/time limits. It is a trusted simulation data source, not a financial data verifier. Cash's peg is assumed only in the fixture model. A compromised publisher can choose bad-but-policy-valid fixture prices; user raw bounds remain enforced. This is why fixture mode cannot carry an authentic-market-price claim.
- The controlled venue is synthetic liquidity. Its exact ABI and fee/reserve model are a T10 admission gate; T16 admits the actual integration. An upgradeable external program is an additional authority risk; use a pinned local/controlled program with disclosed upgrade status and no shared mutable admin route changes during escrow.
- Retained CrossFlow BPF upgrade authority can replace the program and bypass these on-chain rules. The program cannot veto an external upgrade. Keep the key local and separate, disclose it; operational deployment tooling must refuse upgrades while any claims exist, drain/recover first, and record tested binary/config identities. A compromised upgrade authority remains a limitation, not a solved threat.
- RPC can lie about network/state or delay responses. Verify expected genesis/program identities before every signing path; use confirmed/finalized chain reconciliation, retry lookup before rebuilding. The program binds configured genesis but cannot query it itself. UI must distinguish submitted/confirmed/finalized and never fabricate success.
- Token mints use legacy SPL only, no freeze authority and revoked mint authority after setup. No delegates/close authorities on admitted token accounts. Token-2022 capabilities, transfer hooks/fees, permanent delegates and issuer-paused tokens are excluded until separate admission/recovery tests. Program must still keep cancellation independent of token transfers.

## Attack matrix

| Attack / invariant | Prevention | Required independent test |
|---|---|---|
| Mainnet RPC or wrong program, S01/S24 | explicit expected genesis and deployment manifest; no global CLI fallback | mismatch before any signature/broadcast |
| First caller appoints admin, S02/S22 | compiled expected initializer/admin/initial policy and deployment identities, signer check and one-time config initialization | attacker guesses public deployment_id and initializes before legitimate operator |
| Forged owner/cancel, S02 | owner signer equals stored owner and derived persistent owner state | attacker signature with valid victim accounts |
| Policy changed after wallet review, S03/S22 | funding body includes expected policy hash; exact config bytes/hash; nonces and version | one-field mutation, changed live config before submission |
| Omitted asset/alternate encoding, S03/S08 | fixed three entries, strict encoding/length/order, canonical strings | duplicated/reordered mints, trailing bytes, unsafe JSON number |
| Replayed intent, S04 | persistent nonce, one active claim, status, never close owner state | closed intent old-nonce recreation, duplicate batch entry |
| Expired/cancel race, S05/S11 | exact clock boundary and locking, all-or-nothing state | cancel first; settle first; expiry equality |
| Solver drains broadly authorized portfolio, S06/S07 | per-cross stock/cash band + per-owner external execution band + raw bounds + current reference-value loss guard | good aggregate hides owner loss; D>F; one raw-unit breach |
| Cross cash subsidy hidden by large portfolio, S06/S07/S14 | each explicit stock/cash record checked against exact reference-value band; all records reconcile D/C; no free credit weights | $10 share crossed for$11 fails even though buyer loss is only10bps of its slice |
| External slippage assigned to another owner, S06/S09/S14 | actual outputs strictly pro rata to input contributions with disclosed deterministic raw-unit remainder; per-owner execution band | nonparticipant receives output; contributor receives disproportionate debit; one-unit dust breaches band |
| Rounding becomes solver fee, S08/S09 | external proceeds proportional to exact contributed inputs with largest-remainder dust, canonical tie keys, no leftover | reordered owners, tiny quantities, every external input zero or output diverted to a nonparticipant |
| Alias substitutes pool or recipient, S10/S15 | role graph identity/owner/executable checks; explicit alias allowlist | owner ATA = pool, duplicate vault, hostile token program |
| Fake quote/arbitrary CPI, S06/S11/S15 | typed pinned route, actual all-asset deltas, exact X, minimum Y, nothirdasset change | overspend/shortoutput/thirdasset effect, final leg fail |
| Donation corrupts bounds, S06/S09 | booked F separated from surplus; output delta from recipient snapshot | donation satisfies apparent minimum, drainsurplus attempt |
| Donation blocks predictable ATA, S12/S23 | accept valid pre-funded intent vault as surplus; pool donations fixed sweep; old nonce donation recovery | pre-fund future ATA, donate after settle/closure |
| Global pause/solver outage blocks refund, S12 | cancel does not transfer; independent per-asset withdrawal; no oracle/admin required | paused settle, missing ATA, one transfer fail |
| Forged or stale fixture, S13/S14 | exact publisher/PDA/feed/policy, both timestamps and confidence | forged account, swapped feed, stale underlying/fresh wrapper |
| Fixture accidentally becomes Pyth, S13/S20 | mode1 rejected untilT15; new config/domain and exact adapter contract | oracle switch, caller verifiedflag, hidden fallback |
| Silent config alteration/upgrade, S22/S24 | outstandingclaims counter/version; deployment upgrade procedure | change feed while settledsurplus remains; documented external-authoritylimit |
| Key leak or false receipt, S17/S18 | local signing only, secret scan, reconciliation | inspect built assets/logs; timeoutthenconfirmation |
| Misleading economics, S19/S20/S21 | same mandates/baselines; per-owner outcomes; modeled vs actual separate | loosen cooperativebounds, omit fees, hide disadvantage |
| Resource exhaustion, S23 |3owners/3assets/2legs; bounded integer input; external request caps | excessive lists/payloads, allocationoverflow, repeatedAPIcalls |

## Lifecycle and authority review questions

1. Does funding reconstruct the same canonical mandate the owner reviewed, using expected_policy_hash and validated ATA/PDA derivations? Compact payload size alone is not proof.
2. Can any approved field change after funding? Do internal crosses enforce the exact stock-versus-cash inequality and do residual contributions alone determine output allocation? If implementation caches identities, it must validate them; if it resolves config, it must prove policy immutability/hash match.
3. Can failed funding leave a nonce increment, partially funded intent or claim counter? All must rollback together.
4. Can cancel/withdraw work with expired/stale prices and paused funding/settlement? Is the same recipient recreated instead of redirected?
5. Can cancelled/settled surplus be lost when closing? Is owner-state nonce permanent? Can closed-vault recovery revive settlement? It must not.
6. Do actual vault and recipient deltas equal the independent book? Does one-unit late failure rollback the entire batch?
7. Can route account metas or callbacks reach intent authority/state/recipient? If an adapter needs arbitrary accounts or programs, reject integration until the contract is revised/reviewed.
8. Are all counter/nonce/timestamp/valuation calculations checked? Does every raw unit have a deterministic owner?
9. Can an admin mutate policy with settled-but-unrecovered claims? Counter decrements only on complete intent closure.
10. Does a UI advertise total-wallet or percentage/risk guarantees the program does not enforce? Such claims must be removed or implemented explicitly.

## Remaining gates and limitations

T05 funding depends on both T04 and T14: the fixture oracle and price guard must exist before fresh-snapshot funding can run. Conditional Pyth T15 need not precede funding. T02 can close only after independent review of these semantics and vectors, resolving blocking ambiguity. It does not close T04 cross-language/PDA/capacity checks, T05–T10 runtime lifecycle/accounting, T14 fixture interface/price guards, T15 conditional authenticated Pyth, T10 controlled venue and T16 residual integration or G2 money-path review. Golden vectors are encoding fixtures with synthetic public identities, not executable transactions or live addresses.

Funding and settlement are separate transactions; operator availability and compatible counterparties are not guaranteed. Any valid bounded solver proposal made of price-checked paired crosses and pro-rata external executions may win settlement, so submitted previews are estimates until chain reconciliation. There is no best-execution or per-owner-savings guarantee. Owner can recover, but needs devnet SOL for signatures/rent. Repeated hostile donations can impose recovery/rent friction; bounded per-asset recovery and donation separation prevent appropriation, not all denial of service. RPC outage can delay access. Lost owner key cannot be recovered by admin. Upgrade authority remains explicit external trust. These limitations belong in the eventual demo/runbook.

## T02 re-review changes

F1 replaces arbitrary credit weights with paired internal records, exact per-cross price bands, input-proportional external outputs, individual external price bands and explicit execution-cost attribution. Policy adds two committed u16 caps. F2 maps controlled ABI to T10, integrated routes to T16, fixture interface to T14 and conditional Pyth to T15. F3 requires T14 before T05 without blocking on optional Pyth. F4 binds one-time initialization to compiled expected initializer/admin/deployment/policy constants in the reviewed manifest. New price-bound and subsidy-counterexample vectors test specification arithmetic; runtime enforcement is still pending.
