#!/usr/bin/env bash
#
# Optimizer-driven execution: an unseen portfolio proposed, approved, settled and reconciled.
#
# Needs the route-enabled policy and the controlled venue, because the second cycle routes a
# residual externally. Requires CROSSFLOW_RUN_DIR and the pinned toolchain on PATH.
set -euo pipefail
cd /Users/mansitibrewal/chronicles/crossflow
SCRATCH="${CROSSFLOW_RUN_DIR:?set CROSSFLOW_RUN_DIR to a writable scratch directory}"
LEDGER="$SCRATCH/optimizer-ledger"
WALLET="$SCRATCH/optimizer-operator.json"
ENVJSON="$SCRATCH/optimizer-env.json"
MANIFEST=verification/evidence/T33-local-manifest.json
VENUE=Bq1FxNWHnmnZgJRi6fsRKrvLTbBf6uDTXjaawzdnkw1Q
RPC=http://127.0.0.1:8899
SERVICE=http://127.0.0.1:8787
PNPM="corepack pnpm@10.17.1"
VALIDATOR_PID=""
SERVICE_PID=""
cleanup() { [ -n "$SERVICE_PID" ] && kill "$SERVICE_PID" 2>/dev/null || true; [ -n "$VALIDATOR_PID" ] && kill "$VALIDATOR_PID" 2>/dev/null || true; }
trap cleanup EXIT

rm -rf "$LEDGER" "$ENVJSON" "$WALLET" "${WALLET%.json}-b.json" "${WALLET%.json}-c.json"
rm -f "$MANIFEST"
solana-test-validator --reset --ledger "$LEDGER" --rpc-port 8899 --faucet-port 9900 \
  --gossip-port 9901 --dynamic-port-range 9902-9940 --bind-address 127.0.0.1 --quiet >> "$SCRATCH/optimizer-validator.log" 2>&1 &
VALIDATOR_PID=$!
for i in $(seq 1 120); do solana --url "$RPC" cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana --url "$RPC" cluster-version

solana-keygen new --no-bip39-passphrase --silent -o "$WALLET"
INIT=$(solana-keygen pubkey "$WALLET")
solana --url "$RPC" airdrop 500 "$INIT" >/dev/null
$PNPM exec tsx scripts/local-env.ts "$RPC" "$WALLET" "$ENVJSON" > "$SCRATCH/optimizer-env.log" 2>&1
CASH=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['cash'])")
STOCK1=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['stock1'])")
STOCK2=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['stock2'])")

$PNPM exec tsx scripts/prepare-route-manifest.ts "$RPC" "$INIT" "$CASH" "$STOCK1" "$STOCK2" "$VENUE" "$MANIFEST" > "$SCRATCH/optimizer-manifest.log" 2>&1

rm -f target/deploy/crossflow.so
CROSSFLOW_DEPLOYMENT_MANIFEST="$MANIFEST" anchor build 2>&1 | tail -1
solana program deploy --url "$RPC" --program-id target/deploy/crossflow-keypair.json target/deploy/crossflow.so 2>&1 | tail -1
solana program deploy --url "$RPC" --program-id target/deploy/test_venue-keypair.json target/deploy/test_venue.so 2>&1 | tail -1

echo "== start the service for this deployment =="
CROSSFLOW_RPC_URL="$RPC" CROSSFLOW_DEVNET_MANIFEST="$MANIFEST" CROSSFLOW_PORT=8787 CROSSFLOW_RATE_LIMIT=2000 \
  $PNPM exec tsx services/api/src/server.ts >> "$SCRATCH/optimizer-service.log" 2>&1 &
SERVICE_PID=$!
for i in $(seq 1 60); do curl -fsS "$SERVICE/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$SERVICE/health" | head -3

echo "== proposal, approval, settlement and reconciliation =="
$PNPM exec tsx scripts/demo-optimizer-execution.ts "$RPC" "$MANIFEST" "$ENVJSON" "$SERVICE" verification/evidence/T33-optimizer-execution-output.json
echo "DONE"
