# Usability and accessibility evidence (T27)

## What was checked, and how

`tests/ui/accessibility.spec.ts` walks the interface structurally rather than by screenshot:

| Check | Method | Result |
|---|---|---|
| The whole path is keyboard-operable | Tab from load reaches the skip link first; each step is a real `button`; a scenario is chosen and the approval step opened with Enter alone | PASS |
| Status and errors carry text, not colour | The error region contains the word "Error" and has `role="alert"`; the cluster label is always visible | PASS |
| Body text meets WCAG AA contrast | Contrast is computed from the rendered colours of every `p`, `li`, `td`, `h1–h3`, `label` and `button`, against its effective background, requiring 4.5:1 (3:1 at 24px and above) | PASS |
| Inputs are labelled | Each of the nine numeric fields has an accessible name and no field relies on a placeholder | PASS |
| Nothing critical is tooltip-only | No element in the tree carries a `title`; the explanations are visible paragraphs | PASS |
| Long values and narrow viewports | At 380px wide, a full base58 address wraps instead of forcing a horizontal scrollbar | PASS |

## Plain-language explanations

`apps/web/src/components/Explainer.tsx` states, in visible text and without jargon:

- funded escrow — the money leaves the wallet into a vault the program controls, and can only be
  settled inside the signed bounds or cancelled and withdrawn;
- rent — a refundable deposit, returned when the intent closes, not a fee;
- the signed bounds — two numbers per asset, raw units, and the hash computed from those bytes;
- internal crossing — moving an asset between participants without touching an outside venue;
- recovery — cancel, withdraw each asset, close, with no dependency on the operator, the solver or
  the service;
- the three approaches — what each one actually does;
- test assets and test prices — devnet mints with revoked authorities, a labelled fixture
  publisher, no mainnet, no audit.

## Defects this found and fixed

1. A full base58 address forced ~3px of horizontal scroll at phone width. Fixed by allowing long
   identifiers to break rather than by widening the tolerance.
2. Running the whole browser suite exhausted the service's per-client rate limit, so recovery tests
   failed only in combination. The limit is now configurable and is raised for the suite; the
   isolation problem was real and would have hit an operator running several tabs.

## Limits of this evidence

Structural assertions are not a substitute for an unfamiliar human completing the path, which the
plan's own acceptance test calls for and which has not been run. There is no screen-reader session,
no zoom or text-scaling check beyond the narrow viewport, and no automated accessibility engine
(it was not installed). The checks are evidence, not a conformance certificate.
