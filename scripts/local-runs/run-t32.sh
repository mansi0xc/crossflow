#!/usr/bin/env bash
#
# Local runtime run for this task. Requires:
#   CROSSFLOW_RUN_DIR  a writable scratch directory (ledgers, wallets, logs land here)
# and the repository's pinned toolchain on PATH (anchor, solana, python3, corepack).
# It starts and stops its own solana-test-validator and never touches devnet.
set -euo pipefail
cd /Users/mansitibrewal/chronicles/crossflow
SCRATCH="${CROSSFLOW_RUN_DIR:?set CROSSFLOW_RUN_DIR to a writable scratch directory}"
LEDGER="$SCRATCH/t32-ledger"
WALLET="$SCRATCH/t32-owner-a.json"
ENVJSON="$SCRATCH/t32-env.json"
MANIFEST=verification/evidence/T32-local-manifest.json
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
  --gossip-port 9901 --dynamic-port-range 9902-9940 --bind-address 127.0.0.1 --quiet >> "$SCRATCH/t32-validator.log" 2>&1 &
VALIDATOR_PID=$!
for i in $(seq 1 120); do solana --url "$RPC" cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana --url "$RPC" cluster-version

solana-keygen new --no-bip39-passphrase --silent -o "$WALLET"
INIT=$(solana-keygen pubkey "$WALLET")
solana --url "$RPC" airdrop 400 "$INIT" >/dev/null
$PNPM exec tsx scripts/local-env.ts "$RPC" "$WALLET" "$ENVJSON" > "$SCRATCH/t32-env.log" 2>&1

CASH=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['cash'])")
STOCK1=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['stock1'])")
STOCK2=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['stock2'])")
$PNPM exec tsx scripts/prepare-local-manifest.ts "$RPC" "$INIT" "$CASH" "$STOCK1" "$STOCK2" "$MANIFEST" > "$SCRATCH/t32-manifest.log" 2>&1

rm -f target/deploy/crossflow.so
CROSSFLOW_DEPLOYMENT_MANIFEST="$MANIFEST" anchor build 2>&1 | tail -2
solana program deploy --url "$RPC" --program-id target/deploy/crossflow-keypair.json target/deploy/crossflow.so 2>&1 | tail -2

echo "== start the service against this validator =="
CROSSFLOW_RPC_URL="$RPC" CROSSFLOW_DEVNET_MANIFEST="$MANIFEST" CROSSFLOW_PORT=8787 \
  $PNPM exec tsx services/api/src/server.ts >> "$SCRATCH/t32-service.log" 2>&1 &
SERVICE_PID=$!
for i in $(seq 1 60); do curl -fsS "$SERVICE/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$SERVICE/health" | head -3

echo "== fund the fixture through the chain =="
T32_PHASE=fund $PNPM exec tsx scripts/demo-t32-service.ts "$RPC" "$MANIFEST" "$ENVJSON" "$SERVICE" "$SCRATCH/t32-fund.json"

echo "== drive the service end to end =="
T32_PHASE=e2e $PNPM exec tsx scripts/demo-t32-service.ts "$RPC" "$MANIFEST" "$ENVJSON" "$SERVICE" verification/evidence/T32-local-service-output.json 2>&1
echo "DONE"
