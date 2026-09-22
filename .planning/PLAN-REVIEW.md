# Independent execution-plan review

**Reviewed:** 22 September 2026. **Final disposition:** ready to begin gated execution; **zero open blockers, one schedule warning**. This was a documentation review only. No application was implemented, run, deployed, security-tested or audited.

## Scope and method

Reviewed CROSSFLOW-EXECUTION-PLAN.md and .planning/TASKS.md, PROJECT.md, REQUIREMENTS.md, ROADMAP.md, RESEARCH.md and STATE.md. Rechecked revisions against the original findings. Applied goal-backward coverage, dependency analysis, threat-boundary analysis and failure-oriented acceptance checks. The supplied CodeGraph rule was considered; no indexed code or project skill directory was present.

This is an adapted whole-project planning review, not certification of native GSD phase PLAN.md frontmatter/XML. Phase-specific Nyquist, PATTERNS and CONTEXT format checks are not applicable to these project-wide documents; their substance was assessed through task checks, the invariant matrix, explicit user decisions and the master gates. It does not imply that `$gsd-execute-phase` can consume this ledger unchanged.

## Verified planning properties

| Dimension | Result |
|---|---|
| Task completeness | 33 cards each name files, concrete actions, positive/negative checks and completion/failure conditions |
| Dependencies | All referenced tasks exist; no cycle; every listed wave equals the longest dependency depth |
| Requirement coverage | All 20 requirements mapped; conditional R07 and optional R18 have explicit exclusion rules |
| Invariant coverage | All 24 invariants map to implementation tasks and targeted planned checks |
| Functional wiring | T32 connects browser, real optimizer, independent integer validation, chain discovery, batch construction, operator signing and status reconciliation |
| Security boundaries | On-chain authority/accounting checks distinguished from off-chain economics, UI preferences and retained upgrade-authority trust |
| Recovery | Transfer-free cancellation, per-asset claims, surplus recovery, nonce persistence and missing-ATA recovery are explicit |
| Economic validity | Equal feasible mandates/state/costs, independent and netted baselines, held-out evaluation, per-owner outcomes and negative cases required |
| External constraints | Local/devnet writes only; zero new spend; Pyth entitlement and DBC compatibility are gates, not assumed capabilities |
| Capacity and release | Early complete-envelope estimate and scoped probe separated from final actual composed execution; repeated devnet and release gates required |

The read-only graph calculation gave **53–74 focused hours on the critical path** and **118–162 total focused hours across parallel tasks**. The first full core devnet task completes after an estimated 42–58 critical-path hours. These are sums of plan estimates, not measured implementation durations; queueing and unexpected rework are additional.

## Findings and resolutions

| ID | Original severity | Finding | Resolution verified |
|---|---|---|---|
| PC01 | BLOCKER | No executable service/orchestration connecting isolated engines and screens | T32 specifies API routes, numerical transport, canonical integer validation, funded-intent discovery, settlement signing/status, limits and adversarial checks; T19/T22 depend on it |
| PC02 | BLOCKER | Config authority had policy prose but no explicit implementation | T05 adds expected-initializer config creation; T07 implements admin/version/open-claim policy, pause behavior and rejection tests; external BPF upgrade authority is honestly disclosed |
| PC03 | BLOCKER | Settlement could complete without implementing oracle composition | T06/T09 depend on T14; T09 explicitly invokes the guard and tests stale/forged/wrong-feed rejection inside actual settlement |
| PC04 | BLOCKER | Cancellation, partial asset recovery and unsolicited surplus lacked task acceptance | T06–T09 now test transfer-free cancellation, independent withdrawals, blocked claim retention, replay, donation accounting and terminal surplus recovery; T07 adds owner ATA recreation |
| PC05 | BLOCKER | Stale calendar and late first capacity check | Rebased 22 September 11:00 IST start; T04 full-envelope sizing, T06/T23 scoped devnet probe and T17/T24 final composed proof are distinct; no early probe is passed off as integration |
| PC06 | WARNING | Thin schedule reserve | Risk explicitly retained below; DBC is not scheduled by default; reforecasting, scope cuts and safety/submission buffers are mandatory |

Capacity fallback was also reconciled: three wallets/two stocks remains the target; a smaller demo requires a documented R11/task/scenario amendment and fresh economic/demo checks. It must retain at least two independently constrained portfolios and one stock plus cash. One wallet is only a technical probe, not proof of cooperation.

## Remaining warning

```yaml
issues:
  - id: PC06
    severity: WARNING
    dimension: schedule_resilience
    task: project
    status: acknowledged_with_mitigation
    description: "The assumed start leaves 80.5 hours to internal readiness, only 6.5 hours beyond the upper critical-path estimate, before unexpected rework or review queues."
    fix_hint: "Rebase at actual execution start; reforecast every two active hours. Keep DBC unscheduled unless the validated core finishes early enough for its complete review/regression cycle. Cut optional scope before consuming safety checks, rest or the submission buffer."
```

## Limits of this result

Free Pyth equity access, compatible toolchains, positive economic results, exact runtime capacity and devnet availability remain unproved empirical gates. Writing this plan does not resolve them. A gated failure must trigger its stated fallback or revision, never a fabricated PASS. Finite adversarial tests and AI review do not constitute a production audit or formal proof.

No blocking omission remains in the reviewed plan. That means it is ready to **start T00 and earn each gate through evidence**. It does not mean CrossFlow already works, is secure, has paying users or will win.

Reviewed substantive snapshot: master SHA-256 `a38679c7445fb696180520a77262d7ae7ace2dddfb01e4dabaee26173a67563b`; task ledger SHA-256 `83ebe4c3b55e024c28fcf9c07cbbcd8725fb1ed0031575c91641eb279ab8a667`. Later substantive changes require affected review; status/footer/link-only edits do not certify new implementation.
