# Ranked improvement plan

| Priority | Finding | Decision |
|---|---|---|
| P0 | Unauthenticated execution, wildcard CORS, permission self-attestation | Replace transport; bearer token, origin/host checks, server-side tool risk |
| P0 | Stale/mutable approvals, cancellation overwritten by success | Immutable decision digests and explicit terminal states |
| P0 | Unconfined writes and no rollback | Guard paths, hash preconditions, atomic writes and persistent snapshots |
| P0 | Shell injection/environment leakage/orphan processes | Argument arrays, minimal environment, bounded output, process-tree cleanup; document no OS sandbox |
| P1 | Template plans claim autonomy and fake tool success | Replace core with structured observe/act loop and verification evidence |
| P1 | No model abstraction, hard budgets or recovery tests | Provider interface, fallback, schema validation, deadline/step/error limits |
| P1 | No tests or evaluations | Deterministic fixtures exercising real tools and API; report measured artifacts |
| P2 | Mixed legacy stacks, broken install, misleading commands/docs | Quarantine legacy execution, repair dependencies, document supported path |
| P2 | Unbounded history and weak observability | Bounded context and durable structured events with task metrics |
| P3 | Decorative presence and fake specialists | Replace primary task view with actual status, approval and audit controls |

No vector database, generic browser automation or new vision system is justified by the evidence. Retain historical sources for review but remove them from the supported default execution path. Network/model latency and real-model task quality need separate measurements from deterministic local fixtures.
