#!/usr/bin/env bash
#
# T28 local soak. Requires CROSSFLOW_RUN_DIR and the pinned toolchain on PATH.
set -euo pipefail
cd /Users/mansitibrewal/chronicles/crossflow
SCRATCH="${CROSSFLOW_RUN_DIR:?set CROSSFLOW_RUN_DIR to a writable scratch directory}"
LEDGER="$SCRATCH/soak-ledger"
WALLET="$SCRATCH/soak-owner-a.json"
ENVJSON="$SCRATCH/soak-env.json"
MANIFEST=verification/evidence/T28-local-manifest.json
RPC=http://127.0.0.1:8899
PNPM="corepack pnpm@10.17.1"
VALIDATOR_PID=""
cleanup() { [ -n "$VALIDATOR_PID" ] && kill "$VALIDATOR_PID" 2>/dev/null || true; }
trap cleanup EXIT

rm -rf "$LEDGER" "$ENVJSON" "$WALLET" "${WALLET%.json}-b.json" "${WALLET%.json}-c.json"
rm -f "$MANIFEST"
solana-test-validator --reset --ledger "$LEDGER" --rpc-port 8899 --faucet-port 9900 \
  --gossip-port 9901 --dynamic-port-range 9902-9940 --bind-address 127.0.0.1 --quiet >> "$SCRATCH/soak-validator.log" 2>&1 &
VALIDATOR_PID=$!
for i in $(seq 1 120); do solana --url "$RPC" cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana --url "$RPC" cluster-version

solana-keygen new --no-bip39-passphrase --silent -o "$WALLET"
INIT=$(solana-keygen pubkey "$WALLET")
solana --url "$RPC" airdrop 400 "$INIT" >/dev/null
$PNPM exec tsx scripts/local-env.ts "$RPC" "$WALLET" "$ENVJSON" > "$SCRATCH/soak-env.log" 2>&1

CASH=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['cash'])")
STOCK1=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['stock1'])")
STOCK2=$(python3 -c "import json;print(json.load(open('$ENVJSON'))['mints']['stock2'])")
$PNPM exec tsx scripts/prepare-local-manifest.ts "$RPC" "$INIT" "$CASH" "$STOCK1" "$STOCK2" "$MANIFEST" > "$SCRATCH/soak-manifest.log" 2>&1

rm -f target/deploy/crossflow.so
CROSSFLOW_DEPLOYMENT_MANIFEST="$MANIFEST" anchor build 2>&1 | tail -2
solana program deploy --url "$RPC" --program-id target/deploy/crossflow-keypair.json target/deploy/crossflow.so 2>&1 | tail -2

echo "== soak the lifecycle =="
$PNPM exec tsx scripts/soak.ts "$RPC" "$MANIFEST" "$ENVJSON" docs/evidence/soak-report.json --profile release
echo "DONE"
