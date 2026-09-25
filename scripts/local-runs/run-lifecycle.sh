#!/usr/bin/env bash
#
# T05/T06/T07 local lifecycle runs.
#
# Regenerates the committed transcripts: the thin/full lifecycle (T06) and the lifecycle/config work
# (T07) from one complete run, and the funding transcript (T05) from a separate run with its own
# deployment identity. Two identities are needed because the program embeds its deployment manifest
# at compile time, and the complete lifecycle rotates the config it started with.
#
# Requires CROSSFLOW_RUN_DIR and the pinned toolchain on PATH.
set -euo pipefail
cd /Users/mansitibrewal/chronicles/crossflow
SCRATCH="${CROSSFLOW_RUN_DIR:?set CROSSFLOW_RUN_DIR to a writable scratch directory}"
LEDGER="$SCRATCH/lifecycle-ledger"
WALLET="$SCRATCH/lifecycle-operator.json"
PNPM="corepack pnpm@10.17.1"
RPC=http://127.0.0.1:8899
VALIDATOR_PID=""
cleanup() { [ -n "$VALIDATOR_PID" ] && kill "$VALIDATOR_PID" 2>/dev/null || true; }
trap cleanup EXIT

rm -rf "$LEDGER" "$WALLET" "$SCRATCH/lifecycle-mints.json"
solana-test-validator --reset --ledger "$LEDGER" --rpc-port 8899 --faucet-port 9900 \
  --gossip-port 9901 --dynamic-port-range 9902-9940 --bind-address 127.0.0.1 --quiet >> "$SCRATCH/lifecycle-validator.log" 2>&1 &
VALIDATOR_PID=$!
for i in $(seq 1 120); do solana --url "$RPC" cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana --url "$RPC" cluster-version

solana-keygen new --no-bip39-passphrase --silent -o "$WALLET"
INIT=$(solana-keygen pubkey "$WALLET")
solana --url "$RPC" airdrop 500 "$INIT" >/dev/null
$PNPM exec tsx scripts/local-env.ts "$RPC" "$WALLET" "$SCRATCH/lifecycle-mints.json" > "$SCRATCH/lifecycle-env.log" 2>&1
CASH=$(python3 -c "import json;print(json.load(open('$SCRATCH/lifecycle-mints.json'))['mints']['cash'])")
STOCK1=$(python3 -c "import json;print(json.load(open('$SCRATCH/lifecycle-mints.json'))['mints']['stock1'])")
STOCK2=$(python3 -c "import json;print(json.load(open('$SCRATCH/lifecycle-mints.json'))['mints']['stock2'])")

deploy_with() { # <manifest>
  rm -f "$1" target/deploy/crossflow.so
  $PNPM exec tsx scripts/prepare-local-manifest.ts "$RPC" "$INIT" "$CASH" "$STOCK1" "$STOCK2" "$1" > "$SCRATCH/lifecycle-manifest.log" 2>&1
  CROSSFLOW_DEPLOYMENT_MANIFEST="$1" anchor build 2>&1 | tail -1
  solana program deploy --url "$RPC" --program-id target/deploy/crossflow-keypair.json target/deploy/crossflow.so 2>&1 \
    | grep -oE '[1-9A-HJ-NP-Za-km-z]{80,90}' | head -1
}

# Phase A: T06 and T07 share one complete lifecycle run.
T06_MANIFEST=verification/evidence/T06-local-manifest.json
DEPLOY_A=$(deploy_with "$T06_MANIFEST")
echo "phase A deploy: $DEPLOY_A"
$PNPM exec tsx scripts/demo-local.ts "$RPC" "$T06_MANIFEST" "$WALLET" --step complete > verification/evidence/T06-local-demo-output.json
cp verification/evidence/T06-local-demo-output.json verification/evidence/T07-local-demo-output.json
cp "$T06_MANIFEST" verification/evidence/T07-local-manifest.json
# Assembled before the next build, so the recorded binary hash is the one that produced the run.
$PNPM exec tsx scripts/assemble-lifecycle-report.ts "$T06_MANIFEST" verification/evidence/T06-local-demo-output.json "$DEPLOY_A" verification/evidence/T06-local-runtime.json

# Phase B: T05 needs its own identity, because the lifecycle above rotated its config.
T05_MANIFEST=verification/evidence/T05-local-manifest.json
DEPLOY_B=$(deploy_with "$T05_MANIFEST")
echo "phase B deploy: $DEPLOY_B"
$PNPM exec tsx scripts/demo-local.ts "$RPC" "$T05_MANIFEST" "$WALLET" > "$SCRATCH/lifecycle-funding-output.json"
$PNPM exec tsx scripts/assemble-funding-report.ts "$T05_MANIFEST" "$SCRATCH/lifecycle-funding-output.json" "$DEPLOY_B" verification/evidence/T05-local-runtime.json
echo "DONE"
