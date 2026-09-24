# Submission checklist

Status: **not submitted.** This planning and build work authorises no publication or portal
submission; the user performs that. Nothing here should be marked complete until the artefact
exists.

## Required artefacts

| Item | Exists? | Where |
|---|---|---|
| Runnable source | yes | repository root |
| Problem and user statement | yes | `docs/submission-draft.md` |
| Architecture description | yes | `README.md`, `docs/spec/*` |
| Dependency and licence attribution | yes | `docs/THIRD_PARTY_NOTICES.md` |
| Environment template without secrets | yes | `.env.example` |
| Devnet program / config / transaction identities | yes (probe) | `verification/evidence/T24-devnet-manifest.json`, `T24-devnet-output.json` |
| Benchmark / evaluation instructions | yes | `scripts/evaluate-economics.py`, `docs/evidence/economic-report.md` |
| Limitations section | yes | `README.md`, `docs/submission-draft.md` |
| Claim-to-evidence ledger | yes | `docs/claims-ledger.csv` |
| Demo video | **no** | to be recorded from `docs/demo-script.md` |
| Public repository / demo link | **no** | publication not authorised |
| Final handoff note | `docs/final-handoff.md` | |

## Pre-submission checks

- [ ] `corepack pnpm@10.17.1 check:workspace` passes on the frozen commit.
- [ ] `python3 -m unittest discover -s services/optimizer -p 'test_engines.py'` and
      `python3 scripts/evaluate-economics.py --split holdout` reproduce the committed report.
- [ ] `verify:task` has been run for T09, T10 and T16 with the current commit, and the manifests
      under `artifacts/tasks/` show `CHECKS_PASS_REVIEW_PENDING` with a named reviewer.
- [ ] No secret, key or credential appears in the repository, the evidence or the video.
- [ ] Every sentence in the submission draft maps to a row of `docs/claims-ledger.csv`.
- [ ] Every excluded item is named as excluded: Pyth, the real venue, the UI, mainnet, audit.
- [ ] Reachability of any intended public link is verified in a fresh browser.
- [ ] The deadline and portal requirements were re-read on the day of submission.

## Deliberately not claimed

Winning, commercial demand, production readiness, security certification, issuer-backed assets,
universal cost savings, or exact reproduction on another machine's validator.
