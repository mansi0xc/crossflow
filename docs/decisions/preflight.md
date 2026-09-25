# T00 review packet — environment and feasibility

Date: 22 September 2026. Repository: `/Users/mansitibrewal/chronicles/crossflow`.

**Update after user review: T00 accepted for continued execution; devnet funding prerequisite resolved using the authorized CLI wallet (20.95376933 devnet SOL observed). Dependency-safe concurrent work is now authorized. Historical findings below describe the original checkpoint.** This is a preflight, not a completed CrossFlow application or security audit.

## What changed

Copied the approved master plan and planning records into the requested empty repository. Added a zero-dependency preflight script, configuration and negative tests. Preserved a source-only disposable Anchor counter/client example under `experiments/t00/` with dependency locks, so the toolchain result can be reproduced. Added `.gitignore`, a secrets-free environment example and repository execution rules.

The user explicitly selected Phantom and labelled fixture prices. Pyth access/integration is excluded for now; no key was requested in chat, subscription purchased or sponsor qualification claimed.

## Checks actually performed

| Check | Result | Meaning / limitation |
|---|---|---|
| Local tools and disk | PASS | Node 24.10.0; Anchor 1.1.2; Solana CLI 3.1.10; host Cargo 1.91.1; SBF tools 1.52/Rust 1.89.0; Python 3.9.6; approximately 251 GiB initially available |
| Package manager | PASS with explicit pin | `corepack pnpm@10.17.1` works; unqualified latest selection failed in the installed launcher. No global default was changed |
| Rust/SBF build | PASS | Disposable Anchor 1.1.2 program compiled, IDL produced, direct dependencies and full Cargo lock retained |
| Local test runtime | PASS | Two Rust tests passed, including actual initialize/increment execution in LiteSVM 0.10.0 |
| JavaScript client | PASS | Anchor client 1.1.2 and web3.js 1.98.4 import, encode from compiled IDL and serialize an unsigned instruction |
| Full local validator | PASS | Same binary initialized and incremented on Solana test-validator 3.1.10; wrong-authority transaction rejected and count unchanged |
| Network/budget negative cases | PASS | 26 policy tests reject mainnet/testnet/lookalike/authenticated URLs, wrong genesis, paid/card-required services, invalid response and oracle substitution; 10 additional probe-safety tests cover exact local identity and rejection classification |
| Public devnet read access | PASS | Exact devnet genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`; RPC health `ok` |
| Free devnet faucet | FAILED / prerequisite open | Two spaced requests for 0.1 test SOL to a fresh disposable wallet failed. CLI says rate limiting is a possible cause, not a confirmed diagnosis |
| Phantom availability | USER-CONFIRMED | User reports Phantom; browser connection and signing remain untested until wallet-flow work |
| Pyth | EXCLUDED BY USER | Fixture prices are explicitly approved. No authenticated Pyth claim |
| Hosting/cost | PASS for local-only route | Local demo requires no new paid service. No free public hosting account/quotas have been verified or promised |

The preflight script performs read-only chain checks. Its PASS does **not** prove other scripts or future transaction builders enforce the same policy. Those paths get their own gates in T04/T23 and later tasks. The T00 acceptance manifest keeps faucet/wallet limitations separate from the script's narrower result.

## Problems found and handled

1. Corepack's default selected pnpm 12.5.1 but could not locate its expected executable. Use the verified explicit 10.17.1 command; T04 must pin it in the future workspace manifest.
2. Exact-pinning the generated Anchor template's keypair version 3.0.1 conflicted with LiteSVM 0.10.0's `^3.1` requirement. Corrected the disposable example to exact 3.1.0 using official registry metadata; the resulting locked stack built and executed.
3. The SBF postprocessor warned that standard runtime functions were unknown. The same compiled binary then successfully executed in LiteSVM and the full local validator, including invoked program operations. This provides runtime evidence for this example; the warning is retained in the build log and is not suppressed or treated as universal compatibility proof.
4. The initial JS advisory scan reported two high TOML issues and two moderate transitive issues. A narrowly scoped `@anchor-lang/core>toml: 4.2.0` override removes the two high findings; SDK encoding and full local-runtime checks still pass. The final audit retains two moderate findings, documented below. We do not call the lock vulnerability-free.
5. The first local-validator attempt used a faucet port that conflicted with the derived WebSocket port. The isolated runbook now separates RPC 18899, WebSocket 18900 and faucet 18950; the successful test used the corrected setup. The temporary validator was stopped afterward.

## Independent-review fixes

The first independent review found an unpinned local-validator identity, overly broad rejection classification and missing archived JS output. Fixed all three: derive expected genesis from the owned ledger and match before any write; require structured Anchor error 6000 plus the expected program failure log; preserve raw JS encoding output and IDL/binary hashes. Ten new regression tests pass, and the corrected full local runtime was rerun successfully on a fresh ledger. The independent recheck resolved all three findings, reran all 36 Node tests, verified 22 source hashes and 12 evidence hashes, and confirmed the ledger-derived expected genesis matches the runtime receipt. See [independent review](../../.planning/T00-REVIEW.md).

## Remaining issues and stop conditions

**F-01 — Free devnet funding unavailable in this run.** No public devnet deployment is authorized to proceed without a successful free funding check and adequate test SOL. T00 has not demonstrated funded public-devnet readiness. Local research and specification work do not require test SOL, but moving to another task still requires the user's review/continue instruction. Retry the official faucet later or use the user's Phantom devnet faucet workflow; never purchase SOL or switch networks. Do not repeatedly hammer the endpoint.

**D-01 — Two moderate transitive advisories remain.** `uuid@8.3.2` is flagged for buffer bounds in v3/v5/v6 with a supplied buffer; the examined Jayson client request path generates IDs using v4. `stream-json@1.9.1` is flagged for nested-input filtering complexity; the tested web3 browser-client transport uses complete-response JSON parsing rather than exposing Jayson's streaming server. These observations bound this disposable local probe; they are not a waiver for future services. T04 must revisit the dependency graph and T22 must assess reachability in the real app before public release. Do not expose Jayson server/streaming APIs to untrusted input using this lock.

**D-02 — Optional native peer warning.** The installed optional `utf-8-validate` version does not satisfy a nested ws peer range. Actual local RPC/WebSocket flows passed. T04 must intentionally configure compatible optional native packages or explicitly disable them and rerun wallet/transport tests; do not carry an unexplained warning into the release.

**W-01 — Phantom not yet exercised.** Wallet choice is established; browser signing, devnet selection and fresh-wallet recovery are later acceptance tests. Do not describe them as already passed.

**S-01 — Schedule must be reforecast.** Execution started after the old 11:00 IST anchor. More importantly, the user's new mandatory review after every task supersedes the old assumption of concurrent tasks. The old 53–74-hour dependency-path calculation is therefore not a current promise. Record actual elapsed work and review waits at each checkpoint. The original cards total 118–162 focused hours before unexpected work; that cannot simply be assumed to fit the remaining elapsed window. Keep optional DBC unscheduled, preserve safety checks and discuss any necessary scope amendment using concrete evidence.

No funds were spent. No mainnet request, signature or deployment was made. Only a disposable local counter was executed; no CrossFlow escrow, optimizer, venue or UI exists yet.

## Rules/deadline recheck

The [official Stocklana page](https://hackathons.solana.com/hackathons/stocklana), checked today, lists closing on 25 September at 16:00 ET: **26 September 2026 at 01:30 IST**. Internal readiness remains 25 September at 19:30 IST. The main competition looks for a real user/problem, working end-to-end demonstration, a reason to use Solana and execution quality. One team submission; disclose reused open-source work. Technical integration is not sponsor acceptance.

[Pyth Terminal](https://docs.pyth.network/price-feeds/pro/pyth-terminal) advertises a no-card free trial. Its exact entitlement was not tested because the user selected fixture prices. Keep that decision reversible at a later reviewed task; never silently change oracle mode.

## Your review checkpoint

Review this file, the independent review report and the evidence manifest. T00 is presented with the explicit open faucet prerequisite and dependency warnings; it is not an all-green public-deployment gate. No next task starts until you respond. The next proposed task is T01, the economic scenario specification, which can run locally after your review; that would not authorize a devnet deployment or waive F-01.

## Funding and execution-policy resolution

The user authorized the existing CLI wallet and removed routine per-task approval pauses. The verified wallet balance and rent samples were captured in the session scratch directory at the time; that artefact is **not committed**, because it recorded a live wallet balance and the repository deliberately carries no wallet state. The authorization itself is recorded here and in `../../../AGENTS.md`, and `scripts/check-deployment.ts` re-reads the live authority and balance on demand. The failed disposable-wallet faucet attempts remain historical evidence; they no longer block funded devnet readiness. Later deployment/security checks are still mandatory. Pyth is deferred until core setup is ready. T01/T02 may proceed concurrently with their normal review gates.
