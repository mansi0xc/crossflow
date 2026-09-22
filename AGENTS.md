# CrossFlow execution rules

- Execute one task at a time. After completing its work and checks, stop at READY_FOR_USER_REVIEW and present evidence, failures and remaining risks. Do not start the next task until the user explicitly says to continue. Silence is not approval. This user instruction supersedes the earlier parallel-task schedule; independent checks within the current task do not authorize another task.
- Start/resume by reading `.planning/STATE.md`, `CROSSFLOW-EXECUTION-PLAN.md` and the current card in `.planning/TASKS.md`.
- Use local validator or verified Solana devnet only. No mainnet signing, deployment, trading or funding. Do not rely on the global Solana CLI configuration.
- No new monetary spending, paid APIs, card-required trials or paid hosting without separate user authorization.
- The user selected Phantom and explicitly chose labelled test prices for now. Pyth is excluded until access and actual integration are separately verified; no cosmetic sponsor claims.
- Keep test outcomes truthful. A preflight pass is not a product security audit. Record omitted, failed and conditional checks.
- Never put signing keys, seed phrases or API credentials in code, artifacts or chat. No push, publication or hackathon submission is currently authorized.
- In this repository, use CodeGraph before textual code searches only if a `.codegraph/` directory exists at this repository root. Do not infer indexing from a parent folder's index.
