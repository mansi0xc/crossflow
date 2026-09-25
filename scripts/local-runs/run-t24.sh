#!/usr/bin/env bash
#
# Local runtime run for this task. Requires:
#   CROSSFLOW_RUN_DIR  a writable scratch directory (ledgers, wallets, logs land here)
# and the repository's pinned toolchain on PATH (anchor, solana, python3, corepack).
# It starts and stops its own solana-test-validator and never touches devnet.
set -euo pipefail
cd /Users/mansitibrewal/chronicles/crossflow
SCRATCH="${CROSSFLOW_RUN_DIR:?set CROSSFLOW_RUN_DIR to a writable scratch directory}"
PNPM="corepack pnpm@10.17.1"
RPC=https://api.devnet.solana.com
MANIFEST=verification/evidence/T24-devnet-manifest.json
export CROSSFLOW_DEVNET_ENV=""
ENVJSON="$SCRATCH/t24-devnet-env.json"
PROGRAM=CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh
OPERATOR=$(solana address)

echo "== operator $OPERATOR =="
solana balance --url "$RPC"

echo "== prepare devnet test assets =="
export CROSSFLOW_DEVNET_ENV="$ENVJSON"
$PNPM exec tsx scripts/devnet-assets.ts "$ENVJSON"

echo "== prepare devnet identity =="
$PNPM exec tsx scripts/deploy-devnet.ts

echo "== build the bound devnet artifact =="
CROSSFLOW_DEPLOYMENT_MANIFEST="$MANIFEST" anchor build 2>&1 | tail -3

echo "== deploy the bound build to devnet =="
# Always deploy: the program embeds its deployment manifest, so a skipped upgrade would leave the
# on-chain policy behind the committed one.
solana program deploy --url "$RPC" --program-id target/deploy/crossflow-keypair.json target/deploy/crossflow.so 2>&1 | tail -3
solana program show "$PROGRAM" --url "$RPC" | head -4

echo "== isolated devnet probe =="
$PNPM exec tsx scripts/devnet-scenarios.ts "$MANIFEST" "$ENVJSON" verification/evidence/T24-devnet-output.json 2>&1 | tail -40
echo "DONE"
