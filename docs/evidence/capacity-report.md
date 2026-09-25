# Capacity report (T28)

Every figure below is **measured**, and each names the transcript it came from. Nothing here is an
estimate, and nothing is extrapolated from another machine.

## Supported batch

| Case | Owners | Compute | Serialized (v0) | Lookup entries | Source |
|---|---|---|---|---|---|
| Internal batch | 3 | 205,117 | 350 B | 33 | `verification/evidence/T09-local-batch-output.json` |
| Composed cross + residual leg | 3 | 330,095 | 451 B | 43 | `verification/evidence/T16-local-route-output.json` |
| Same, driven over HTTP through the service | 3 | 209,617 | 350 B | 33 | `verification/evidence/T32-local-service-output.json` |
| Devnet probe | 3 | 161,316 | – | 33 | `verification/evidence/T24-devnet-output.json` |

The devnet figure is lower because that probe settles a single internal cross with no residual leg
and no service round trip; it is not evidence that devnet is cheaper.

## Why a lookup table is mandatory, not an optimisation

A three-owner settlement does not fit the legacy packet. The identical instruction encodes to
**1,275 legacy bytes** against a **1,232-byte** packet limit, which is why the proposer must attach
an address lookup table. This is a hard requirement of the supported configuration, not a size
optimisation, and it is why the local runs create and root a table before sending.

## The boundary

| Case | Outcome | Where enforced |
|---|---|---|
| 3 owners | Settles | Measured in every transcript above |
| 4 owners | Refused | The canonical encoder refuses `batch_count` 4; the program's own bound is unit-tested separately |

The refusal is checked at the first gate that can see it (the encoder), and the program enforces the
same bound independently — `tests/program/atomic-batch.test.ts` covers the maximum body and the
oversized case.

## Lifecycle reliability (T28 soak)

Twelve full cycles of fund → cancel → withdraw per asset → close against a local validator:

| Measure | Value |
|---|---|
| Cycles / steps | 12 / 60 |
| Steps OK | 60 |
| Program refusals | 0 |
| Transport failures | 0 |
| Max compute in a cycle | 210,260 |
| Total compute | 3,951,582 |
| Slowest cycle | ~2.9 s (dominated by local confirmation waits) |
| Owner-lamport delta, cycles 3+ | −25,000 per cycle, which is the five transaction fees |
| Owner-state rent, paid once per owner | 1,684,320 lamports (permanent, not recoverable) |
| Intents left open | 0 |

The larger delta on cycles 0–2 is the permanent per-owner state account, not leakage: every intent
closed, so every intent's rent returned.

## What these numbers do not say

They do not establish devnet route capacity (never measured), behaviour on a real venue, throughput
under concurrent operators, or that four owners would work if the bound were raised. Compute
headroom above the measured figures is not spare capacity for another leg: a second residual leg
needs another venue CPI and more accounts. And the economic bound bites before the technical one —
the demonstrable residual size is limited by the committed ±200 bps per-owner execution band, not by
transaction size.
