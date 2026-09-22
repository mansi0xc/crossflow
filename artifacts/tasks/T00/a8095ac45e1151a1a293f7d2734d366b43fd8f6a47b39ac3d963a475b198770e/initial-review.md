---
phase: T00
reviewed: 2026-09-22
depth: standard
files_reviewed: 20
files_reviewed_list:
  - scripts/preflight.mjs
  - tests/preflight/policy.test.mjs
  - preflight.config.json
  - experiments/t00/README.md
  - experiments/t00/client/local-runtime.mjs
  - experiments/t00/client/probe.mjs
  - experiments/t00/client/package.json
  - experiments/t00/client/pnpm-lock.yaml
  - experiments/t00/t00_probe/Anchor.toml
  - experiments/t00/t00_probe/Cargo.toml
  - experiments/t00/t00_probe/Cargo.lock
  - experiments/t00/t00_probe/programs/t00_probe/Cargo.toml
  - experiments/t00/t00_probe/programs/t00_probe/src/lib.rs
  - experiments/t00/t00_probe/programs/t00_probe/src/state.rs
  - experiments/t00/t00_probe/programs/t00_probe/src/error.rs
  - experiments/t00/t00_probe/programs/t00_probe/src/constants.rs
  - experiments/t00/t00_probe/programs/t00_probe/src/instructions.rs
  - experiments/t00/t00_probe/programs/t00_probe/src/instructions/initialize.rs
  - experiments/t00/t00_probe/programs/t00_probe/src/instructions/increment.rs
  - experiments/t00/t00_probe/programs/t00_probe/tests/test_initialize.rs
findings:
  critical: 1
  warning: 2
  info: 0
  total: 3
status: issues_found
task_disposition: REWORK_THEN_USER_REVIEW_WITH_DEVNET_FUNDING_BLOCKED
---

# T00 independent source and evidence review

## Narrative Findings (AI reviewer)

Adapted the GSD explicit-file review method to the whole-project T00 ledger; this is not a completed native GSD phase workflow. Repository base: `/Users/mansitibrewal/chronicles/crossflow`. No implementation edits, package installation, network requests or subsequent task execution were performed by this reviewer. Lockfiles were checked for dependency pins/integrity and advisory context, not audited as dependency source code.

### CR-01 — BLOCKER: local transaction probe does not establish the intended validator identity

**File:** `/Users/mansitibrewal/chronicles/crossflow/experiments/t00/client/local-runtime.mjs:7-19`

**Issue:** The writing probe connects to a fixed localhost port and accepts every genesis except the two explicitly denied hashes. An unrelated validator or a local proxy to testnet passes, then receives an airdrop request and, if funded, signed transactions. Localhost alone does not establish that this is the fresh validator owned by this experiment. This violates the repository's local-or-verified-devnet restriction. A read-only reproduction confirmed that the testnet genesis passes the current checks. This does not establish that the archived run used the wrong chain.

**Fix:** Require an explicit expected genesis obtained from the experiment-owned fresh ledger, validate it before RPC calls, and require exact equality before funding/signing. Reject known public cluster identities for this local-only probe. Add mocked tests proving missing identity, mismatch, and testnet cannot reach any airdrop/sign/send operation; retain the matching local positive case. Update the runbook and rerun the local probe.

### WR-01 — WARNING: authorization rejection test accepts unrelated transport failures

**File:** `/Users/mansitibrewal/chronicles/crossflow/experiments/t00/client/local-runtime.mjs:28-31`

**Issue:** The fallback `String(error).includes('Unauthorized')` accepts an HTTP 401 Unauthorized or unrelated error as proof that the program's authority constraint rejected the attacker. The unchanged counter also holds when an RPC transport fails before program execution. A read-only reproduction confirmed this false-positive classification.

**Fix:** Require the structured Anchor custom error (name and expected numeric code), preferably with the emitting program identity. Preserve the rejection details in the report. Test that HTTP 401, timeout and unrelated program errors fail the authorization check, and rerun the actual wrong-authority simulation/execution.

### WR-02 — WARNING: archived serialization evidence is only an asserted result

**File:** `/Users/mansitibrewal/chronicles/crossflow/artifacts/tasks/T00/a8095ac45e1151a1a293f7d2734d366b43fd8f6a47b39ac3d963a475b198770e/manifest.json:88-92`

**Issue:** The manifest records `node probe.mjs` exit zero and labels serialization PASS, but the archive contains no corresponding stdout/report. The probe produces useful bytes/encoding assertions, yet the preserved packet cannot independently establish their observed output. The T00 evidence contract requires exact command output.

**Fix:** Rerun the pinned probe against the built IDL, preserve its stdout and exit code, and reference/hash that report in the evidence manifest. Record IDL and binary hashes beside the result so the artifact pair is identifiable. This is missing evidence, not proof the check failed.

## Evidence assessment and disposition

I independently reran the 25 policy tests: 25 passed, zero skipped. Their endpoint, budget and read-only RPC negative tests are meaningful for `preflight.mjs`; they do not protect the separate writing probe. The archived Rust log contains two passing tests: one generated program-ID test and one initialize/increment integration test. They are not two independent security tests. The inspected Rust authority check and bounded counter arithmetic did not yield another defect within this disposable example's scope.

All 20 archived source hashes match current files. Recomputed aggregate: `a8095ac45e1151a1a293f7d2734d366b43fd8f6a47b39ac3d963a475b198770e`. Key reviewed hashes:

- `scripts/preflight.mjs`: `dacb297ffdc45cb04fcf444ec492e5518556d869bfdacd8c631ee3763a5a77a2`
- `local-runtime.mjs`: `1959c5a3bb196b7f5c76e02b7952ba5c1f98204f9943a6473ac9d080c49d7432`
- `probe.mjs`: `892bfffc1d477936f0e8bd260ffb61a6cfd4cfe08b7b464f13b6c7e67a646e04`

The source digest proves correspondence with the supplied manifest, not authenticity of past runs or a verified build-to-binary relationship. I did not rebuild dependencies or rerun the validator. Archived build/runtime evidence supports compatibility of this counter; it does not validate CrossFlow.

**T00 requires rework for the three findings, followed by a user review checkpoint.** Both documented public faucet attempts failed; funded public-devnet readiness remains **BLOCKED**, never PASS. A successful free funding check and sufficient test SOL remain required before public deployment. Local follow-on research could proceed only after an explicit user review/continue decision that preserves this blocker; this report does not authorize T01.

Pyth is excluded by the user's fixture-price choice. Phantom browser signing is untested. The final JS advisory report has two moderate findings; no Rust advisory audit was performed. The documented bounded dependency exceptions must be revisited for the real application. None of these limitations should be presented as a product security certification.
