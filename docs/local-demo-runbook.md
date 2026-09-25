# Local demo runbook

Everything below runs without a paid service, a funded wallet or mainnet. Devnet tooling refuses any
destination whose live genesis is not the reviewed devnet genesis.

## One-time

```sh
corepack pnpm@10.17.1 install --frozen-lockfile
corepack pnpm@10.17.1 exec playwright install chromium
```

## The fast checks

```sh
corepack pnpm@10.17.1 check:workspace                 # harness, secrets, RPC guard, schema vectors
corepack pnpm@10.17.1 exec vitest run                 # 117 TypeScript tests
corepack pnpm@10.17.1 test:ui                         # 10 browser tests, injected wallet + stubbed RPC
python3 -m unittest discover -s services/optimizer -p 'test_engines.py'
python3 scripts/evaluate-economics.py --split holdout
CROSSFLOW_DEPLOYMENT_MANIFEST=verification/evidence/T16-local-manifest.json cargo test -p crossflow -p test-venue --lib
corepack pnpm@10.17.1 verify:release
```

## The browser flow

```sh
corepack pnpm@10.17.1 serve:api    # loopback service on 8787, bound to one manifest
corepack pnpm@10.17.1 dev:web      # UI on 5173
```

Then open `http://127.0.0.1:5173`. To sign anything you need a wallet provider: Phantom, pointed at
the local validator (`http://127.0.0.1:8899`). The automated tests inject a stub instead, which is
why they can assert that the mandate on screen is the mandate the wallet was asked to sign.

## The on-chain runs

The local validator runs are driven by the harness scripts in the session scratchpad, which:

1. start `solana-test-validator` on a fresh ledger,
2. create the test mints and three owner wallets,
3. build the program against a prepared deployment manifest,
4. deploy and run the scenario, then
5. check the resulting evidence.

The commands each task actually runs are in `verification/tasks/<TASK>.json`; `verify:task -- <TASK>`
replays them and binds every source file, log and artifact hash into
`artifacts/tasks/<TASK>/<source-tree-hash>/`. The local runtime run scripts those manifests invoke
live in `scripts/local-runs/` and need `CROSSFLOW_RUN_DIR` set.

## Devnet

See `docs/operations/deployment.md`. Nothing is deployed by running the commands above: the devnet
scripts are separate and always validate the cluster identity first.

## If something does not reproduce

Say so. The evidence in `verification/evidence/` records the exact run it came from; a local pass
that cannot be reproduced should be disclosed rather than replaced with a screenshot.
