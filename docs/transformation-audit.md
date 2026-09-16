# Transformation audit and implementation record

## Existing system

Supported TypeScript runtime: seven guarded tools, strict model decisions, exact expiring approvals, bounded execution, cancellation, SQLite task/event transactions, file checkpoints. Express loopback API, Next task console, CLI; Electron viewer adds no lifecycle management. Legacy Python/frontend/engine modules duplicate unsupported behavior. Fourteen scripted scenarios repeated three times test orchestration, not coding capability. One live smoke exposes its editable verifier and even describes the repair.

## Preserve

Server-owned risk, validation, optimistic file hashes, explicit command approvals, cancellation terminality, bounded outputs, persistent evidence and honest separation of deterministic versus model results.

## Replace or strengthen

Native commands lack isolation; shared working tree risks developer changes; single-file rollback is not a task transaction; model usage is combined and incomplete; UI exposes tokens and raw internals; history is only superficially bounded. Typecheck aliases lint. Windows CI needs repository LF policy (already added). Legacy sources confuse the supported contract.

## Decisions

1. Task workspaces use detached no-checkout Git worktrees populated from bounded safe working files, including dirty content. Git hooks/filters are never part of preparation. The user's index and branch remain untouched.
2. Docker execution is the application default: fixed broker-owned resources, no network by default, no Docker socket, only task workspace mounted. Native is explicit and retains host privileges. No claim of perfect isolation.
3. Changesets freeze after execution stops. Acceptance/reversion preflight all paths and journal exact bytes outside the task mount. Multi-file visibility is not atomic; conflict/recovery states are explicit.
4. Secure local bootstrap exchanges a short-lived one-use fragment capability for a browser session; no unauthenticated permanent-token endpoint.
5. At least 50 distinct coding tasks have independently stored graders, known-bad and reference checks, and separate live-model artifacts. Candidate code executes outside the parent harness, preferably Docker. Unmeasured results stay unmeasured.
6. Providers share structured decisions and per-call usage identity. No implicit model routing or fake agent roles.

## Implementation checklist

- [x] Audit runtime/tools/store/API/UI/desktop/providers/tests/evaluation/CI/docs/dependencies
- [ ] Execution broker and real Docker invariant tests
- [ ] Git workspaces and durable conflict-aware changesets
- [ ] Runtime integration and explicit provider telemetry
- [ ] Secure setup and simplified task/diff UI
- [x] 50-task benchmark catalog, independent graders, and generated integrity artifact
- [ ] Live-model capability comparison dashboard (requires measured model runs)
- [ ] Trusted verification / context and structured edits
- [ ] Legacy cleanup, script semantics, retention, CI
- [ ] Clean checkout builds, local model measurement, browser flow
- [ ] Adversarial review and synchronized final docs

Security-sensitive integration remains centrally reviewed. Parallel workers own the independent workspace broker, benchmark harness and UI/API surfaces. This document records a plan, not completion evidence.
