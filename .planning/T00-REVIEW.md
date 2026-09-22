---
phase: T00
reviewed: 2026-09-22
depth: standard
files_reviewed: 22
files_reviewed_list:
  - scripts/preflight.mjs
  - tests/preflight/policy.test.mjs
  - preflight.config.json
  - experiments/t00/README.md
  - experiments/t00/client/local-runtime.mjs
  - experiments/t00/client/probe.mjs
  - experiments/t00/client/safety.mjs
  - experiments/t00/client/safety.test.mjs
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
  critical: 0
  warning: 0
  info: 0
  total: 0
resolved_findings: 3
status: clean
task_disposition: READY_FOR_USER_REVIEW_WITH_OPEN_PREREQUISITE
---

# T00 independent source and evidence review

## Narrative Findings (AI reviewer)

Adapted the GSD explicit-file review method to the whole-project T00 ledger; this is not a completed native GSD phase workflow. Repository base: `/Users/mansitibrewal/chronicles/crossflow`. No implementation edits, package installation, network requests or subsequent task execution were performed by this reviewer. Lockfiles were checked for dependency pins/integrity and advisory context, not audited as dependency source code.

### CR-01 — BLOCKER — RESOLVED: local transaction probe did not establish the intended validator identity

**File:** `/Users/mansitibrewal/chronicles/crossflow/experiments/t00/client/local-runtime.mjs:7-19`

**Issue:** The writing probe connects to a fixed localhost port and accepts every genesis except the two explicitly denied hashes. An unrelated validator or a local proxy to testnet passes, then receives an airdrop request and, if funded, signed transactions. Localhost alone does not establish that this is the fresh validator owned by this experiment. This violates the repository's local-or-verified-devnet restriction. A read-only reproduction confirmed that the testnet genesis passes the current checks. This does not establish that the archived run used the wrong chain.

**Fix:** Require an explicit expected genesis obtained from the experiment-owned fresh ledger, validate it before RPC calls, and require exact equality before funding/signing. Reject known public cluster identities for this local-only probe. Add mocked tests proving missing identity, mismatch, and testnet cannot reach any airdrop/sign/send operation; retain the matching local positive case. Update the runbook and rerun the local probe.

**Recheck:** `safety.mjs:7-19` now enforces a supplied non-public genesis and exact RPC equality. `local-runtime.mjs:10-36` encloses funding, key generation and transaction submission inside that guard. The updated runbook obtains identity from the owned ledger; archived ledger extraction matches the fresh local receipt. Negative and positive guard tests pass.

### WR-01 — WARNING — RESOLVED: authorization rejection test accepted unrelated transport failures

**File:** `/Users/mansitibrewal/chronicles/crossflow/experiments/t00/client/local-runtime.mjs:28-31`

**Issue:** The fallback `String(error).includes('Unauthorized')` accepts an HTTP 401 Unauthorized or unrelated error as proof that the program's authority constraint rejected the attacker. The unchanged counter also holds when an RPC transport fails before program execution. A read-only reproduction confirmed this false-positive classification.

**Fix:** Require the structured Anchor custom error (name and expected numeric code), preferably with the emitting program identity. Preserve the rejection details in the report. Test that HTTP 401, timeout and unrelated program errors fail the authorization check, and rerun the actual wrong-authority simulation/execution.

**Recheck:** `safety.mjs:22-26` requires Unauthorized/6000 plus the exact expected program's custom-error log. Tests reject HTTP 401, timeout, wrong code and wrong program. The fresh runtime receipt contains the expected structured error and program logs.

### WR-02 — WARNING — RESOLVED: archived serialization evidence was only an asserted result

**File:** `/Users/mansitibrewal/chronicles/crossflow/artifacts/tasks/T00/a8095ac45e1151a1a293f7d2734d366b43fd8f6a47b39ac3d963a475b198770e/manifest.json:88-92`

**Issue:** The manifest records `node probe.mjs` exit zero and labels serialization PASS, but the archive contains no corresponding stdout/report. The probe produces useful bytes/encoding assertions, yet the preserved packet cannot independently establish their observed output. The T00 evidence contract requires exact command output.

**Fix:** Rerun the pinned probe against the built IDL, preserve its stdout and exit code, and reference/hash that report in the evidence manifest. Record IDL and binary hashes beside the result so the artifact pair is identifiable. This is missing evidence, not proof the check failed.

**Recheck:** The replacement archive includes hashed `js-serialization.json` (145-byte unsigned serialization, zero requests/transactions) and manifest IDL/binary hashes with recorded command success.

## Evidence assessment and disposition

Targeted recheck independently ran 26 policy tests and 10 probe-safety tests: 36 passed, zero skipped. The writing probe now has its own tested guard. Unchanged Rust evidence contains one generated program-ID test and one initialize/increment integration test, not two independent security tests. No unresolved source defect was found in the reviewed scope.

All 22 current source hashes and 12 archived evidence hashes match the replacement manifest. Recomputed aggregate: `52ff2d9809a1997586524456f75c59293fb3dd31f72ea5e7d780b45a2005ef43`. Key reviewed hashes:

- `scripts/preflight.mjs`: `1ef30ba87416b149ea2a32b145910489d2f3b3c450708f950f9c1fca4c7634dd`
- `local-runtime.mjs`: `a16cfc45d01a0f827df9a2f7b196080ff6e9b0e087220141c513c81df132e68e`
- `safety.mjs`: `11264c8cdf5fa43ccf76dd5112e5b9809ec6512ea948ef0e517bce5604a84465`

The source digest proves correspondence with the supplied manifest, not authenticity of past runs or a verified build-to-binary relationship. I did not rebuild dependencies or rerun the validator. Archived build/runtime evidence supports compatibility of this counter; it does not validate CrossFlow.

**All three findings are resolved; T00 is READY_FOR_USER_REVIEW_WITH_OPEN_PREREQUISITE.** Frontmatter `clean` describes this bounded source review, not unconditional task acceptance. Both documented public faucet attempts failed; funded public-devnet readiness remains **BLOCKED**, never PASS. Successful free funding and sufficient test SOL remain required before deployment. Local follow-on research requires explicit user review/continue preserving that blocker; this report does not authorize T01.

Pyth is excluded by the user's fixture-price choice. Phantom browser signing is untested. The final JS advisory report has two moderate findings; no Rust advisory audit was performed. The documented bounded dependency exceptions must be revisited for the real application. None of these limitations should be presented as a product security certification.
