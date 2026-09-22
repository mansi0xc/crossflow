# CrossFlow execution rules

- Latest user instruction (22 September): proceed autonomously with dependency-safe concurrent task execution and occasional status reports. Routine per-task user approval pauses are revoked. Keep every task acceptance check and independent review; pause only for a genuine blocker or an action outside existing authorization. Parallel agents may own disjoint tasks/files and must not revert each other. This supersedes earlier review-after-every-task instructions.
- Start/resume by reading `.planning/STATE.md`, `CROSSFLOW-EXECUTION-PLAN.md` and the current card in `.planning/TASKS.md`.
- Use local validator or verified Solana devnet only. No mainnet signing, deployment, trading or funding. Do not rely on the global Solana CLI configuration.
- No new monetary spending, paid APIs, card-required trials or paid hosting without separate user authorization.
- The user selected Phantom and labelled test prices. Defer Pyth until core setup is ready; retain the oracle interface/capacity planning now and revisit actual access/verification before final demo freeze. It remains unimplemented until verified.
- The user authorizes the existing local Solana CLI wallet identified by `solana address` for CrossFlow devnet work. Expected public address: FSyL13FTp3Yrgdo8VWpoNtpL8FS5FcSGL3tdNp1sjw2t. Recheck identity and explicit devnet genesis before any signing. Use signing tools locally; never display, copy into artifacts, or publish the private key. Authorization does not extend to mainnet or unrelated assets/programs.
- Keep test outcomes truthful. A preflight pass is not a product security audit. Record omitted, failed and conditional checks.
- Never put signing keys, seed phrases or API credentials in code, artifacts or chat. No push, publication or hackathon submission is currently authorized.
- In this repository, use CodeGraph before textual code searches only if a `.codegraph/` directory exists at this repository root. Do not infer indexing from a parent folder's index.
