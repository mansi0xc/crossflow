#!/usr/bin/env bash
#
# Local runtime run for this task. Requires:
#   CROSSFLOW_RUN_DIR  a writable scratch directory (ledgers, wallets, logs land here)
# and the repository's pinned toolchain on PATH (anchor, solana, python3, corepack).
# It starts and stops its own solana-test-validator and never touches devnet.
set -euo pipefail
cd /Users/mansitibrewal/chronicles/crossflow
SCRATCH="${CROSSFLOW_RUN_DIR:?set CROSSFLOW_RUN_DIR to a writable scratch directory}"
LEDGER="$SCRATCH/t09-ledger"
WALLET="$SCRATCH/t09-owner-a.json"
ENVJSON="$SCRATCH/t09-env.json"
PROGRAM=CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh
RPC=http://127.0.0.1:8899
PNPM="corepack pnpm@10.17.1"
VALIDATOR_PID=""

cleanup() { [ -n "$VALIDATOR_PID" ] && kill "$VALIDATOR_PID" 2>/dev/null || true; }
trap cleanup EXIT

start_validator() {
  solana-test-validator --reset --ledger "$LEDGER" --rpc-port 8899 --faucet-port 9900 \
    --gossip-port 9901 --dynamic-port-range 9902-9940 --bind-address 127.0.0.1 \
    --quiet >> "$SCRATCH/t09-validator.log" 2>&1 &
  VALIDATOR_PID=$!
  for i in $(seq 1 120); do
    solana --url "$RPC" cluster-version >/dev/null 2>&1 && return
    sleep 1
  done
  echo "validator did not become ready" >&2
  exit 1
}

rm -rf "$LEDGER" "$ENVJSON" "$WALLET" "${WALLET%.json}-b.json" "${WALLET%.json}-c.json"
mkdir -p verification/evidence
rm -f verification/evidence/T09-local-manifest.json

echo "== validator =="
start_validator
solana --url "$RPC" cluster-version

solana-keygen new --no-bip39-passphrase --silent -o "$WALLET"
INIT_PK=$(solana-keygen pubkey "$WALLET")
solana --url "$RPC" airdrop 400 "$INIT_PK" >/dev/null

echo "== synthetic mints and three independent owners =="
$PNPM exec tsx scripts/local-env.ts "$RPC" "$WALLET" "$ENVJSON" > "$SCRATCH/t09-env.log" 2>&1
CASH=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['cash'])")
STOCK1=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['stock1'])")
STOCK2=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['stock2'])")
INIT=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['wallet'])")
echo "initializer=$INIT owners=$(python3 -c "import json;print(','.join(json.load(open('$ENVJSON'))['owners']))")"

echo "== manifest =="
$PNPM exec tsx scripts/prepare-local-manifest.ts "$RPC" "$INIT" "$CASH" "$STOCK1" "$STOCK2" verification/evidence/T09-local-manifest.json > "$SCRATCH/t09-manifest.log" 2>&1

echo "== rebuild and deploy =="
rm -f target/deploy/crossflow.so
CROSSFLOW_DEPLOYMENT_MANIFEST=verification/evidence/T09-local-manifest.json anchor build 2>&1 | tail -3
solana program deploy --url "$RPC" --program-id target/deploy/crossflow-keypair.json target/deploy/crossflow.so 2>&1 | tail -2

echo "== three-owner funded batch settlement =="
$PNPM exec tsx scripts/demo-t09-batch.ts "$RPC" verification/evidence/T09-local-manifest.json "$ENVJSON" verification/evidence/T09-local-batch-output.json 2>&1 | tail -40
echo "DONE"
