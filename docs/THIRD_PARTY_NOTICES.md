# Third-party notices

This project uses the following components. Versions are pinned in `package.json`, `Cargo.toml`
and `Cargo.lock`; no third-party source was copied into this repository.

| Component | Version | License | Use |
|---|---|---|---|
| Anchor (`anchor-lang`, `anchor-spl`) | 1.1.2 | Apache-2.0 | Solana program framework and SPL CPI wrappers |
| `@solana/web3.js` | 1.98.4 | Apache-2.0 | Client, transaction building, local validator tooling |
| Solana SBF toolchain / Agave CLI | 3.1.10 | Apache-2.0 | Local validator, program deploy |
| `solana-sha256-hasher`, `solana-instructions-sysvar` | 3.1.0 / 3.0.1 | Apache-2.0 | Canonical hashing and instruction authentication |
| `rust-toolchain` | 1.89.0 | MIT/Apache-2.0 | Rust compiler pin |
| TypeScript | 5.9.3 | Apache-2.0 | Client and tooling types |
| Vitest | 5.0.1 | MIT | TypeScript test runner |
| tsx | 4.20.6 | MIT | TypeScript script execution |
| Node.js | 24.10.0 | MIT | Runtime for scripts and tooling |
| Python (standard library only) | 3.9.6 | PSF-2.0 | Economic engines and evaluation |

## Research references

- The cooperative transaction-cost paper cited by the execution plan
  (arXiv:2603.07881) motivates the mechanism. **No code was reused from it**; the reference
  implementation in `research/economics/reference.py` was written for this project and its
  assumptions are recorded in `research/economics/scenario-spec.md`.

## Scope

No dependency here is used for mainnet writes, paid data, hosting or signing services. No API key
or credential is required to run any committed command.
