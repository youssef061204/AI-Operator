# ADR 001: replace the core runtime, preserve usable presentation infrastructure

Status: accepted. Decision: option C.

The original engine mixes templates, shell strings, Windows UI automation, permission bypasses and task state in one large class. Incremental patching would preserve false completion semantics and ambiguous authorization boundaries. A full repository rewrite would discard useful packaging and UI dependencies without evidence of benefit.

Implement a small developer runtime under `packages/agent/src/runtime`: strict decision/tool schemas, explicit task transitions, provider injection, bounded recent observations, server-owned approval policy, filesystem checkpoints, cancellation and transactional task/event storage. Serve it through an authenticated localhost API and a task UI. Keep the old source for historical comparison with its standalone server disabled by default. No existing database migration: new runtime uses a separate data directory and schema.

Tradeoffs: fewer supported actions; arbitrary approved commands still run with the user's OS privileges. File guards are not kernel isolation and cannot eliminate races against hostile external processes. Deterministic fixture providers test orchestration, not LLM competence. Restart interrupts active tasks instead of replaying uncertain side effects. Approval policy must never be inferred from model prose. Completion requires successful runtime verification against user-supplied criteria, not a model completion flag alone.

Migration: capture baseline, repair setup, implement tools and runtime separately against explicit interfaces, wire API/UI/CLI, add security regressions and evaluations, run full build, replace unsupported documentation claims with measured evidence. Preserve user data and historical source; no Git commits possible in this supplied non-checkout directory.
