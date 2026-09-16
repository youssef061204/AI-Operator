# Final engineering report

Status: portfolio-ready architecture with deterministic safety evidence and one frozen 50-task Gemini capability run.

1. **Before / after:** replaced two duplicate applications and a monolithic automation engine with one typed runtime, one Next.js UI, a task workspace broker, an execution backend, and a distinct benchmark. Unsupported sources moved under `historical/` and are excluded from builds.
2. **Agent:** Gemini 3.8 Flash proposes strict JSON actions; the runtime owns validation, risk, approvals, execution, cancellation, repetition/deadline bounds, verification, metrics, and completion.
3. **Isolation:** every production task gets a detached Git worktree. Docker commands receive one CPU, 512 MiB memory, 128 PIDs, no network, dropped capabilities, no new privileges, a read-only root, and only the task workspace mount.
4. **Changesets:** verified work freezes into an exact multi-file proposal. Accept/revert preflight every file and journal progress; conflicts preserve external changes and enter recovery state.
5. **UX:** `pnpm dev` loads ignored env files, checks prerequisites/ports, and opens a one-use connection. The UI shows objective, plan, approvals, results, proposed files, accept/discard/revert, and generated evaluation evidence. Raw digests stay in advanced details.
6. **Providers:** supported product configuration is Gemini-only, defaulting to `gemini-3.8-flash`. Per-call telemetry records actual model, latency, input/output tokens, estimated cost, and sanitized failure. No silent provider fallback exists.
7. **Benchmark:** 50 distinct coding tasks span 10 categories. Candidate code cannot see graders and is graded in a no-network Docker container. Integrity requires every broken baseline to fail and every reference solution to pass.
8. **Measured safety results:** 42/42 deterministic runtime outcomes, 0 permission violations, 100% rollback assertions, 50/50 benchmark-integrity cases, one passing browser E2E, and 0 dependency advisories. Final unit pass: 32 cases, 31 passed, 1 Windows privilege skip, 0 failed.
9. **Live model result:** `gemini-3.8-flash` passed 33/50 independently graded tasks (66.0%) in one frozen run: 74.3% easy and 46.7% medium. Median latency was 12.19 s and p95 was 50.90 s. The run used 96,203 input and 13,550 output tokens at an estimated $0.1230. It recorded zero 429s, 5xx responses, retries, persistent HTTP failures, timeouts, step-limit failures, repeated-action failures, and schema parse failures. Two model actions were denied by policy; no denied action executed.
10. **Limitations:** Docker shares the host kernel; batch files are not simultaneously visible; portable filesystem checks cannot defeat every hostile race; worktree snapshots reject unsupported links/binaries; local events need broader retention controls; benchmark fixtures are intentionally small.
11. **Reproduce:** `pnpm install --frozen-lockfile`; `docker pull node:24.13.0-bookworm-slim`; add `GEMINI_API_KEY` to `.env`; then run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:browser`, `pnpm evaluate`, `pnpm benchmark:integrity`, `pnpm benchmark -- --model gemini-3.8-flash --limit 50`, `pnpm build`, and `pnpm audit`.
12. **Resume metrics:** 66.0% live coding success across 50 tasks and 10 categories; 42/42 deterministic safety outcomes; 0 deterministic permission violations; 100% rollback assertions; 50/50 grader-integrity checks; 32 automated cases with 0 failures; 527 audited dependencies with 0 advisories.

Recommended bullets are maintained in [interview-guide.md](interview-guide.md).
