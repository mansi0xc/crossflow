# Execution state

Updated: 22 September 2026, Asia/Kolkata.

- Execution repository: `/Users/mansitibrewal/chronicles/crossflow`.
- Current task: T00 only, READY_FOR_USER_REVIEW_WITH_OPEN_PREREQUISITE.
- Product implementation: not started; disposable compatibility example and preflight tooling only.
- User checkpoint policy: after each task's checks, stop for user review. No next task without explicit continue after that checkpoint.
- Next task: T01, NOT_STARTED. No advance until explicit user review and T00 signoff/scope decision; devnet funding is not waived by proceeding with local-only research.
- Oracle: labelled fixture prices, explicitly selected by user; Pyth excluded for now.
- Wallet: Phantom, user-confirmed; browser signing not yet tested.
- Network: local validator and verified devnet only. No mainnet writes.
- Spending: zero new spend authorized or incurred.
- T00 evidence: local build and runtime pass; pinned JS client pass; 36 Node checks and two Rust tests pass; independent review findings resolved. Free devnet faucet requests failed; public deployment funding remains unresolved.
- Deadline: 26 September 2026 01:30 IST; internal readiness 25 September 19:30 IST.
- Schedule: original parallel-task estimate is superseded by sequential user review; reforecast after each checkpoint using actual work and review time.
- Resume: read AGENTS.md, current task card, result/evidence and latest user review before taking action. Do not infer approval from a previous in-task continue message.

- Review packet: `docs/decisions/preflight.md`; independent review: `.planning/T00-REVIEW.md`; exact artifact pointer: `.planning/T00-EVIDENCE.json`.
- T00 is not an unconditional public-devnet readiness PASS. Failed faucet checks remain recorded; no public deployment until free funding is verified.
