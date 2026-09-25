# Deployment and recovery runbook (T23)

Local validator and Solana devnet only. No mainnet path exists in this repository: `Anchor.toml`
defaults to `localnet`, `.env.example` is local-only, and every write path runs
`scripts/network-guard.mjs` first, which rejects a non-TLS URL, a mainnet or testnet hostname, a
lookalike hostname, credentials, a query string and any destination whose live genesis is not the
expected one.

## Identities

| Role | Where it lives | Notes |
|---|---|---|
| Program identity | `target/deploy/crossflow-keypair.json` → `~/.config/solana/crossflow-program-devnet.json` | Public program ID `CW1jt…XbRkh`. Never printed, copied or committed |
| Devnet operator / initializer / admin / fixture publisher | `~/.config/solana/id.json` (the approved wallet) | Must equal `APPROVED_DEVNET_INITIALIZER`; the compiled manifest pins it |
| Controlled venue | `target/deploy/test_venue-keypair.json`, program `Bq1F…kw1Q` | Local only so far; not deployed to devnet |
| Demo owners | `scripts/devnet-assets.ts` generates two extra keypairs into a scratchpad env file | Public keys appear in evidence; secret keys never do |

The compiled program embeds a deployment manifest (`programs/crossflow/build.rs`). A build with
no `CROSSFLOW_DEPLOYMENT_MANIFEST` disables public initialization entirely, and a devnet manifest
is rejected unless the genesis, program ID and authority are exactly the reviewed ones.

## Deploy sequence

```sh
# 1. Create the devnet test mints and owner accounts, and make the mints immutable.
corepack pnpm@10.17.1 exec tsx scripts/devnet-assets.ts "$SCRATCH/t24-devnet-env.json"

# 2. Bind the committed policy to those mints and write the deployment identity.
corepack pnpm@10.17.1 exec tsx scripts/deploy-devnet.ts          # add --dry-run to inspect only

# 3. Build against that identity, then deploy the reviewed artifact.
CROSSFLOW_DEPLOYMENT_MANIFEST=verification/evidence/T24-devnet-manifest.json anchor build
solana program deploy --url https://api.devnet.solana.com \
  --program-id target/deploy/crossflow-keypair.json target/deploy/crossflow.so

# 4. Verify identity before and after any write.
corepack pnpm@10.17.1 exec tsx scripts/check-deployment.ts

# 5. Isolated probe (scoped-probe exception: funding, one bounded batch, rejections, recovery).
corepack pnpm@10.17.1 exec tsx scripts/devnet-scenarios.ts \
  verification/evidence/T24-devnet-manifest.json "$SCRATCH/t24-devnet-env.json" \
  verification/evidence/T24-devnet-output.json
```

`scripts/deploy-devnet.ts` refuses to overwrite an existing deployment whose committed policy
differs, because funded intents are bound to the policy they were signed under. Changing the
policy or the deployment identity requires a **new** deployment ID and fresh user authorization;
never migrate escrow automatically.

## Recoverable actions

- **Pause** funding and/or settlement (`set_pause`). Pausing never blocks cancellation or an
  owner's per-asset withdrawal, so an incident cannot trap refunds.
- **Owner refunds.** Cancel makes the intent refundable without moving tokens; each asset is then
  withdrawn separately to the owner's canonical account, and closing returns rent only once every
  vault is empty and every claim is cleared.
- **Redeploy a corrected build.** Safe only when no funded intents exist under the current
  identity; the upgrade authority signs, and outstanding intents must be recovered first.

## Irreversible or trust-bearing actions

- Deploying with a retained upgrade authority means the holder can replace the program at the
  same address. That is a real trust assumption and is disclosed in the release manifest.
- Revoking a mint or freeze authority on a test asset is permanent; the asset must then be
  replaced rather than repaired.
- Closing an intent is final. Recovery of donations to a closed vault is available afterwards
  through `recover_closed_vault` for the recorded owner only.

## Costs

Rent is a recoverable deposit, not a fee: the per-intent vault and intent accounts are closed
back to the owner once claims are empty. Network fees for failed transactions are not refunded.
Spending is devnet SOL only, and no paid service is used anywhere in this pipeline.


## Traceability of the deployed program (S24)

A deployment is only trustworthy if the bytes running on the cluster are the bytes this repository
builds. The program embeds its deployment identity at compile time, so a build from the same
manifest must reproduce the live program exactly.

`scripts/check-deployment.ts` now fetches the program data account, hashes the ELF that follows its
45-byte metadata header, and compares it with `target/deploy/crossflow.so`. A mismatch raises
`BINARY_MISMATCH` rather than being reported as a footnote: a live program that differs from the
reviewed build is a different program.

The check reports `deployed_binary_sha256` and `local_binary_matches_deployed`. On the current
devnet deployment both the on-chain policy hash and the binary hash match the committed manifest
and the local build.


## What the live deployment is, and is not

The devnet program is deployed under a policy with **routing disabled** (`route_kind = 0`). It
therefore exercises the internal-crossing path only: funding, an atomic three-owner batch that
crosses orders between owners, rejection, and owner recovery. The composed residual route (`T16`) has
**never run on devnet**; its evidence is from an isolated local validator against the synthetic
venue, and the release manifest says so.

The policy hash stored on chain is compared with the committed manifest on every check, so a
disagreement — including a change to the route configuration — fails the check rather than being
reported as a footnote. The deployed bytecode is compared with a local build for the same reason.

Changing the live deployment to a route-enabled policy would require a new deployment identity,
because a config account carries its policy for the life of the deployment. That has not been done:
the current identity's evidence is bound to it, and replacing it would invalidate that transcript
rather than extend it.
