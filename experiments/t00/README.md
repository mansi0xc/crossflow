# T00 disposable compatibility example

This is an Anchor-generated counter plus small client probes. It is **not CrossFlow** and is not intended for mainnet or public deployment. Preserve its lockfiles as compatibility evidence; T04 chooses the actual application workspace layout. Anchor template provenance: installed Anchor CLI 1.1.2 from [otter-sec/anchor](https://github.com/otter-sec/anchor), Apache-2.0.

From `experiments/t00/t00_probe`, run `anchor build` then `cargo test --locked`. From `experiments/t00/client`, run `corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts` and `node probe.mjs`.

To repeat the full local-runtime test, start a **fresh empty** disposable validator ledger with the compiled program loaded. Read its public program ID from `t00_probe/target/idl/t00_probe.json`. The run used RPC 18899, WebSocket 18900, faucet 18950, gossip 18901 and dynamic ports 18902–18940. Do not reuse another project's validator or reset a ledger you did not create for this experiment.

Example command after substituting the actual public program ID and a new temporary ledger directory:

```sh
solana-test-validator --ledger /private/tmp/NEW-EMPTY-T00-LEDGER --rpc-port 18899 --faucet-port 18950 --gossip-port 18901 --dynamic-port-range 18902-18940 --bind-address 127.0.0.1 --bpf-program PROGRAM_ID_FROM_IDL target/deploy/t00_probe.so --quiet
```

Read the genesis from that experiment-owned ledger with `agave-ledger-tool --ledger /private/tmp/NEW-EMPTY-T00-LEDGER genesis-hash`. Pass that exact public hash as `CROSSFLOW_T00_LOCAL_GENESIS` when running `node local-runtime.mjs` from the client directory. A missing, public-network or mismatched identity is rejected before funding/signing. Run `node --test safety.test.mjs` for these regression cases. It generates an ephemeral local-only payer in memory, initializes/increments the counter, verifies wrong-authority rejection and saves a local receipt. Stop the validator you started afterward. A fresh ledger is required because this tiny generated program uses a single counter PDA. Do not confuse its local signatures with devnet evidence.

Known warnings and dependency advisories are in `docs/decisions/preflight.md`. The SBF binary itself is not committed; build logs, hashes and actual execution evidence are archived separately. No keypairs, seed phrases, node_modules, target directories or validator ledgers belong in source control.
