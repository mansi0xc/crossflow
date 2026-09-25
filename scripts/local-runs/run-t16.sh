#!/usr/bin/env bash
#
# Local runtime run for this task. Requires:
#   CROSSFLOW_RUN_DIR  a writable scratch directory (ledgers, wallets, logs land here)
# and the repository's pinned toolchain on PATH (anchor, solana, python3, corepack).
# It starts and stops its own solana-test-validator and never touches devnet.
set -euo pipefail
cd /Users/mansitibrewal/chronicles/crossflow
SCRATCH="${CROSSFLOW_RUN_DIR:?set CROSSFLOW_RUN_DIR to a writable scratch directory}"
LEDGER="$SCRATCH/t16-ledger"
WALLET="$SCRATCH/t16-owner-a.json"
ENVJSON="$SCRATCH/t16-env.json"
MANIFEST=verification/evidence/T16-local-manifest.json
VENUE=Bq1FxNWHnmnZgJRi6fsRKrvLTbBf6uDTXjaawzdnkw1Q
RPC=http://127.0.0.1:8899
PNPM="corepack pnpm@10.17.1"
VALIDATOR_PID=""
cleanup() { [ -n "$VALIDATOR_PID" ] && kill "$VALIDATOR_PID" 2>/dev/null || true; }
trap cleanup EXIT

rm -rf "$LEDGER" "$ENVJSON" "$WALLET" "${WALLET%.json}-b.json" "${WALLET%.json}-c.json"
rm -f "$MANIFEST"
solana-test-validator --reset --ledger "$LEDGER" --rpc-port 8899 --faucet-port 9900 \
  --gossip-port 9901 --dynamic-port-range 9902-9940 --bind-address 127.0.0.1 --quiet >> "$SCRATCH/t16-validator.log" 2>&1 &
VALIDATOR_PID=$!
for i in $(seq 1 120); do solana --url "$RPC" cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana --url "$RPC" cluster-version

solana-keygen new --no-bip39-passphrase --silent -o "$WALLET"
INIT=$(solana-keygen pubkey "$WALLET")
solana --url "$RPC" airdrop 400 "$INIT" >/dev/null

echo "== synthetic mints and three owners =="
$PNPM exec tsx scripts/local-env.ts "$RPC" "$WALLET" "$ENVJSON" > "$SCRATCH/t16-env.log" 2>&1
CASH=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['cash'])")
STOCK1=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['stock1'])")
STOCK2=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['stock2'])")

echo "== route-enabled manifest =="
$PNPM exec tsx scripts/prepare-route-manifest.ts "$RPC" "$INIT" "$CASH" "$STOCK1" "$STOCK2" "$VENUE" "$MANIFEST" > "$SCRATCH/t16-manifest.log" 2>&1
cat "$SCRATCH/t16-manifest.log"

echo "== build and deploy both programs =="
rm -f target/deploy/crossflow.so
CROSSFLOW_DEPLOYMENT_MANIFEST="$MANIFEST" anchor build 2>&1 | tail -3
solana program deploy --url "$RPC" --program-id target/deploy/crossflow-keypair.json target/deploy/crossflow.so 2>&1 | tail -2
solana program deploy --url "$RPC" --program-id target/deploy/test_venue-keypair.json target/deploy/test_venue.so 2>&1 | tail -2

echo "== composed cross + residual settlement =="
$PNPM exec tsx scripts/demo-t16-route.ts "$RPC" "$MANIFEST" "$ENVJSON" verification/evidence/T16-local-route-output.json 2>&1 | tail -30
echo "DONE"
