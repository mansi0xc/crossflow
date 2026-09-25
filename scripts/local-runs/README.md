# Local runtime runs

Each script reproduces one task's committed runtime evidence from a checkout. They are the
executable form of `docs/local-demo-runbook.md`.

```sh
export CROSSFLOW_RUN_DIR=$(mktemp -d)
bash scripts/local-runs/run-t32.sh          # service end-to-end
bash scripts/local-runs/run-t09.sh          # internal three-owner batch
bash scripts/local-runs/run-t16.sh          # composed cross + residual route
bash scripts/local-runs/run-t24.sh          # isolated public-devnet probe
```

Each script:

1. starts its own `solana-test-validator` on a fresh ledger and stops it on exit,
2. creates test mints and owner wallets under `CROSSFLOW_RUN_DIR`,
3. prepares a deployment manifest, builds the program against it and deploys,
4. runs the scenario, and
5. writes the evidence into `verification/evidence/`.

`run-t24.sh` is the only one that touches a public network. It targets devnet, rebinds the
deployment identity when the committed policy changes, refuses to replace a deployment with
outstanding claim intents, and validates the cluster genesis before anything is signed. It never
touches mainnet.

After a run, check the evidence with the matching checker:

```sh
node scripts/check-t09-runtime-evidence.mjs
node scripts/check-t16-runtime-evidence.mjs
node scripts/check-t32-local-evidence.mjs
```

Or run the whole per-task check set with `corepack pnpm@10.17.1 verify:task -- <TASK>`.
