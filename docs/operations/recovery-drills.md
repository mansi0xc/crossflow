# Recovery and fault drills (T26)

Each drill breaks one dependency and records what the system does. The rule applied throughout: a
failure must become an explicit, safe state — never a false success, never a lost recovery route,
never a silent retry that could double-sign.

| Drill | Injected fault | Expected and observed |
|---|---|---|
| Service unreachable | every HTTP endpoint returns 503 | Recovery still works: intents are read from chain and cancel / withdraw / close stay available (`tests/ui/recovery.spec.ts`, "recovery works with the service entirely offline") |
| Chain unreachable during funding | RPC aborts after review, before signing | An explicit error; no signature recorded; no "funded" claim; nothing is signed (`tests/ui/faults.spec.ts`) |
| Numerical engine times out | `/plans` returns a timeout rejection | The plan fails closed; no comparison table and no settlement path is offered |
| Service rate limits | `/plans` returns 429 | The error is surfaced on screen, the comparison step stays disabled, and the cluster label remains visible |
| Intent expired | funded intent past its expiry | Cancellation is still offered, because expiry makes settlement invalid rather than consuming the intent |
| Submit path fails after cancellation | RPC aborts during withdrawal | The error is shown and the remaining per-asset withdrawal controls stay in place |
| Pause | settlement and funding paused | Cancellation and per-asset withdrawal are explicitly unaffected (on-chain evidence: T07 transcript) |

## Rehearsal procedure

```sh
corepack pnpm@10.17.1 test:ui          # includes the fault drills
corepack pnpm@10.17.1 verify:task -- T26
```

## Limits of these drills

They exercise the browser and service boundaries with a stubbed RPC and an injected wallet. They do
not simulate a real extension failing, a network partition mid-transaction, an RPC that returns
inconsistent results, or devnet congestion. On-chain recovery liveness is evidenced separately by
the T07 transcript and the devnet probe's cancel → withdraw → close sequence.
