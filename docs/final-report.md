# Final engineering report

Status: portfolio-ready architecture and deterministic evidence; live Gemini capability remains unmeasured until `GEMINI_API_KEY` is present in this repository's local environment.

1. **Before / after:** replaced two duplicate applications and a monolithic automation engine with one typed runtime, one Next.js UI, a task workspace broker, an execution backend, and a distinct benchmark. Unsupported sources moved under `historical/` and are excluded from builds.
2. **Agent:** Gemini 3.8 Flash proposes strict JSON actions; the runtime owns validation, risk, approvals, execution, cancellation, repetition/deadline bounds, verification, metrics, and completion.
3. **Isolation:** every production task gets a detached Git worktree. Docker commands receive one CPU, 512 MiB memory, 128 PIDs, no network, dropped capabilities, no new privileges, a read-only root, and only the task workspace mount.
4. **Changesets:** verified work freezes into an exact multi-file proposal. Accept/revert preflight every file and journal progress; conflicts preserve external changes and enter recovery state.
5. **UX:** `pnpm dev` loads ignored env files, checks prerequisites/ports, and opens a one-use connection. The UI shows objective, plan, approvals, results, proposed files, accept/discard/revert, and generated evaluation evidence. Raw digests stay in advanced details.
6. **Providers:** supported product configuration is Gemini-only, defaulting to `gemini-3.8-flash`. Per-call telemetry records actual model, latency, input/output tokens, estimated cost, and sanitized failure. No silent provider fallback exists.
7. **Benchmark:** 50 distinct coding tasks span 10 categories. Candidate code cannot see graders and is graded in a no-network Docker container. Integrity requires every broken baseline to fail and every reference solution to pass.
8. **Measured results:** 42/42 deterministic runtime outcomes, 0 permission violations, 100% rollback assertions, 50/50 benchmark-integrity cases, one passing browser E2E, and 0 dependency advisories. Final unit pass: 31 cases, 28 passed, 3 explicit environment skips, 0 failed. Docker tests also passed 2/2 earlier with the daemon running.
9. **Live model status:** the prior Qwen and Gemini 2.5 development attempts are not portfolio metrics. Gemini 3.8 capability has no result because the current `.env` and process environment contain no `GEMINI_API_KEY`. Run the command below after adding the key.
10. **Limitations:** Docker shares the host kernel; batch files are not simultaneously visible; portable filesystem checks cannot defeat every hostile race; worktree snapshots reject unsupported links/binaries; local events need broader retention controls; benchmark fixtures are intentionally small.
11. **Reproduce:** `pnpm install --frozen-lockfile`; `docker pull node:24.13.0-bookworm-slim`; add `GEMINI_API_KEY` to `.env`; then run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:browser`, `pnpm evaluate`, `pnpm benchmark:integrity`, `pnpm benchmark:live -- --model gemini-3.8-flash --limit 50`, `pnpm build`, and `pnpm audit`.
12. **Resume metrics:** 7 guarded tools; 42 safety cases; 0 permission violations; 50 coding tasks across 10 categories; 50/50 grader-integrity checks; 31 automated unit cases plus browser E2E; 527 audited dependencies with 0 advisories. Do not state a Gemini success rate until a complete live artifact exists.

Recommended bullets are maintained in [interview-guide.md](interview-guide.md).
