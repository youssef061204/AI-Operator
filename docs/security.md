# Security model

AI Operator is a single-user local developer tool. Its default command boundary is Docker, backed by task-specific Git isolation and explicit human approval. It is not a remote multi-tenant service or a proof against every container/kernel vulnerability.

## Enforced boundaries

- The API binds IPv4 loopback and checks Host and exact Origin. The launcher creates a random, single-use, five-minute fragment capability; the browser exchanges it for an HttpOnly SameSite session. CLI calls use the persistent random bearer. Cookie-authenticated mutations require a trusted Origin.
- Strict Zod unions validate model decisions and tools. Risk is server-owned. Denial runs first; medium actions use exact resource grants; high-risk commands always require a digest-bound, expiring, one-use approval.
- File tools reject absolute/traversal paths, sensitive components, Windows alternate streams/device aliases, symlinks, junctions, hardlinks, binary data, oversized files, and stale hashes.
- Every isolated task works on a broker-owned detached worktree populated by raw bounded copies. Git checkout hooks, attributes filters, fsmonitor, textconv, the active index, and the active branch are not used.
- Docker execution uses literal executable/argument arrays, a task-workspace-only bind mount, no Docker socket, no network by default, one CPU, 512 MiB memory, a 128 PID limit, dropped capabilities, `no-new-privileges`, a read-only root, bounded output, and forced cleanup after timeout/cancel.
- Completion requires runtime verification. Changes are frozen only after command cleanup. Accept/revert preflight every file hash before effects and journal each applied path. External conflicts are preserved and surface `recovery_required` rather than being overwritten.
- Cancellation cannot later become completion. SQLite task and event state commits together. Restarts interrupt uncertain work. Known credential patterns and process-environment secrets are redacted before persistence.

## Residual risks

Docker shares the host kernel. A Docker daemon or kernel compromise is outside this application's boundary. Enabling the explicit native backend gives approved processes the user's host privileges. Enabling container networking permits repository code to communicate externally.

Portable Node checks cannot remove every filesystem race with a hostile concurrent writer. Batch acceptance is crash-recoverable, but files become visible one rename at a time; it is not a filesystem-wide atomic transaction. If compensation finds an external edit, the broker preserves it and requires manual recovery.

The worktree copies only bounded UTF-8 regular files and rejects unsupported links/binaries. Submodules and repositories that require checkout filters need an explicit future design. Checkpoint and changeset blobs contain source code in the private operator data directory.

Gemini receives context selected by the runtime. Prompt injection cannot grant permission, but it can try to persuade the operator to approve a harmful action. Redaction is best effort; repositories containing secrets should still exclude them from agent-readable paths. The API key remains in the ignored process environment and is never placed in browser assets or evaluation artifacts.

Trusted verification must be immutable relative to the model. The benchmark supplies graders outside the candidate workspace and runs candidate code in a no-network container. Ordinary user tasks can still choose editable tests as criteria; the UI must describe that weaker trust level accurately.

## Reproduce

Run `pnpm test`, `pnpm test:browser`, `pnpm evaluate`, `pnpm benchmark:integrity`, `pnpm build`, and `pnpm audit`. Docker-specific tests skip when the daemon is unavailable; a recorded passing Docker run is required before claiming that boundary on a release machine.
