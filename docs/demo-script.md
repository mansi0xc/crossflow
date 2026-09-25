# Demo script and rehearsal checklist

Three minutes. Every number quoted here is in `verification/evidence/`; if a step cannot be run,
say so rather than substituting a screenshot.

## Narrative

**0:00–0:25 — The problem.** Three strategy accounts, each with its own mandate. Two of them want
opposing trades in the same name. Executed separately, both pay spread and impact for a trade that
could have happened between them.

**0:25–1:05 — The difference.** Show the three approaches side by side with their numbers:
independent execution, plain netting of the same orders, and cooperative joint adjustment. Point at
the held-out table and read the honest line out loud: the cooperative gain is positive in four of
six eligible scenarios and only 36 of 72 sensitivity points keep it positive. Say that the internal
crossing is what holds up, not the cooperative premium.

**1:05–1:55 — The workflow.** Fund three intents from three owners, each with signed raw-unit
bounds. Show the signed bounds, then settle the batch: one explicit cross plus one residual leg
against the venue. Show the receipt: every owner's realized output, the measured venue reserves
moving by exactly the leg, and the pools back at zero.

**1:55–2:25 — The safety property.** Reject something. Show an output above the signed maximum and
a cross price outside the committed band both reverting. Then cancel an intent and withdraw each
asset separately to show recovery needs no solver and no admin.

**2:25–3:00 — Limits.** Say plainly: fixture oracle, not Pyth; synthetic pool, not a market; the UI
is local only and has never been driven with the real Phantom extension; no audit; devnet probe
rather than a released product. Point at the claims ledger.

## Rehearsal checklist

- [ ] `corepack pnpm@10.17.1 check:workspace` passes.
- [ ] The local runs named in the script have been re-executed on the frozen commit, not replayed
      from a recording. If a run cannot be reproduced, say so on camera.
- [ ] Every number shown comes from `verification/evidence/`, and the file is named on screen.
- [ ] The rejection path is shown live, not described.
- [ ] Recovery is shown live: cancel, then per-asset withdrawal, then close.
- [ ] The words "test assets", "synthetic liquidity" and "no audit" appear in the video, not only
      in the slides.
- [ ] No private key, seed phrase or funded wallet is ever on screen. Devnet addresses only.
- [ ] The limitations slide matches `docs/claims-ledger.csv` row for row.
- [ ] Recording is re-run from a clean checkout so the video cannot show a stale artifact.
- [ ] Duration and file format checked against the portal's requirements.

## Fallbacks

| If | Then |
|---|---|
| Devnet RPC is rate-limited | Use the committed devnet evidence and say it is a recorded run; the local runs are the live segment |
| A local run will not reproduce | Fix it before recording, or disclose the failure on camera |
| Time overruns | Cut the cooperative-economics detail, never the rejection or recovery segment |
