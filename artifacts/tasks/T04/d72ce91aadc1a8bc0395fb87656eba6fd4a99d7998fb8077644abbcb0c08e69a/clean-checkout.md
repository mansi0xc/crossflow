# T04 clean-checkout and negative checks

Source commit: `ac4916b80e8db6a3bacc6ac3afb0d63170367dca`.

1. `git clone --local --no-hardlinks /Users/mansitibrewal/chronicles/crossflow /private/tmp/crossflow-t04-clean-check` succeeded; the clean checkout resolved to the source commit above.
2. `corepack pnpm@10.17.1 install --ignore-scripts --frozen-lockfile --offline` succeeded with 105 reused packages, zero downloaded, and an up-to-date lockfile.
3. `corepack pnpm@10.17.1 run check:workspace` succeeded in that checkout: 18 Node policy/verifier tests, 21 Vitest cross-language vectors, and TypeScript no-emit typecheck.
4. In only the disposable checkout, `package.json` was changed from `@solana/web3.js` 1.98.4 to 1.98.3 without changing the lockfile. The same frozen install exited 1 with `ERR_PNPM_OUTDATED_LOCKFILE` and reported the exact mismatch. `git restore package.json` restored the clone cleanly.
5. `node --import tsx scripts/probe-capacity.ts --mandatory-padding=900` exited 1, showing the mandatory settlement instruction exceeded the 1232-byte packet buffer. No transaction was sent.

These checks prove source/lock consistency and the stated local test selection. They do not prove the three-owner real runtime transaction, actual ALT, compute consumption, or oracle payload size. CI has not run on a hosted runner.
