# Surface audit

Scope: static inspection of `apps/web`, `apps/desktop`, `frontend`, `backend/main.py`, `packages/agent/src/control-brain.ts`, `packages/agent/src/pipeline.ts`, and the existing architecture document. No runtime actions, credentials, profiles, generated projects, or logs were opened. Engine, cognition, and agent storage enforcement are outside this audit. Findings describe the inspected baseline, not validation of subsequent repairs.

## Actual architecture

- The pnpm workspace includes `apps/*` and `packages/*`; it excludes `frontend` and `backend` (`pnpm-workspace.yaml`). The root scripts build shared types and start the Node agent, Next web UI, and Electron together.
- `apps/web/lib/agent.ts:1` calls the local Node API at port 7788 directly from the browser. It supplies no authentication header and opens `/logs/stream`. `/runs` creates `/pipeline/demo` runs, polls `/queue/status`, and approves/rejects actions (`apps/web/app/runs/page.tsx:100`). It is a local control UI; the inspected surface does not implement a hosted SaaS service or authenticated account boundary.
- Pairing asks the same agent for `/device/default-pairing`, stores the code in localStorage, and polls status (`apps/web/app/connect-device/page.tsx:37`). Electron automatically fetches and registers this code (`apps/desktop/src/renderer/renderer.ts:504`). This demonstrates discovery/registration, not proof of a separate trusted device or caller.
- Electron has a main process, context-isolated preload IPC, ordinary renderer, presence overlay, and glow window. Main manages an optional child agent, tray kill switch, health, and manual-input monitoring (`apps/desktop/src/main.cts:503`, `:562`; `src/preload.cts:12`). Both renderer scripts hardcode port 7788 even though the main process accepts `OPERATOR_AGENT_BASE`; custom ports therefore split the UI and main-process control paths.
- `ControlBrain` maintains in-memory session history and generic/agency/Instagram modes (`packages/agent/src/control-brain.ts:132`). It uses heuristics first for specialized workflows, optionally Ollama/OpenAI for generic commands, and returns `needs_input` or action descriptions/objectives/OS steps. It is a planner, not a durable execution or verification loop. Generated steps are schema-parsed, normalized, truncated to six steps, and one action is retained (`:474`).
- `pipeline.ts` constructs ordered action envelopes and templates. Demo work includes scaffold, dependency installation, git, preview, drafts, research, GitHub publish, and deploy (`:183`). Its lead mode opens supplied leads and compose tabs. These builders do not themselves execute or verify outcomes.
- Legacy `frontend/app/page.tsx:191` calls a different FastAPI server on port 8000. `backend/main.py` owns its own SQLite sessions/leads/action queue, synchronous subprocess/browser execution, and unrelated lowercase queue states. There is no inspected bridge to the Node stack. Both Next apps default to port 3000 and cannot occupy that port together.

## High-priority security and correctness findings

1. **Legacy API trusts arbitrary callers and identifiers.** Request bodies select `user_id`; routes expose state, artifacts, approvals, execution, and settings without authentication (`backend/main.py:124`, `:2026`, `:2140`). CORS permits two localhost origins but is not caller authentication. Any client that can reach this server can impersonate an identifier and alter its controls.
2. **Legacy workspace setting performs unrestricted writes immediately.** `resolve_workspace_root` accepts absolute and parent-relative paths (`backend/main.py:219`); `/session/workspace-root` immediately calls `mkdir` before any queued approval (`:2053`). Generated-file actions likewise trust stored paths (`:1448`). Establish canonical workspace containment and reject symlink/junction escapes before writes.
3. **Legacy kill switch cannot stop an active action.** It updates a database flag (`backend/main.py:2039`), checked only at entry to `execute_action` (`:1733`). `run_shell_command` uses blocking `subprocess.run` (`:1201`) and browser actions contain no shared cancellation path. The landing-copy claim that actions can be stopped mid-run (`:961`) is unsupported by this implementation.
4. **Legacy permission popup fails open.** Non-Windows platforms and popup errors both return true (`backend/main.py:1032`). A UI prompt cannot serve as a security boundary with this fallback; persist explicit approval and fail closed when an actual permission gate is required.
5. **Legacy action success ignores adapter failure.** `execute_action` marks every returned value completed (`backend/main.py:1760`) although git/dependency/publish handlers return `ok:false` and failure status strings (`:1612`). A returned failure needs to transition the queue to failed, with dependency blocking. Concurrent execution requests also perform read/check/update separately, allowing duplicate side effects without an atomic claim.
6. **External-message plan has no recipient verification checkpoint.** `ControlBrain.buildInstagramDmPlan` searches a recipient, presses Enter, types the message, and presses Enter to send (`packages/agent/src/control-brain.ts:272`). OCR labels and fixed delays do not establish the selected account identity or a verified send result. Parent audit must confirm execution authorization enforcement; this planner alone cannot ensure it.
7. **Electron has an HTML injection sink.** `renderer.ts:273` interpolates `runId` into `innerHTML`. Use DOM text nodes regardless of current server identifier validation. `main.cts` sets `contextIsolation:true` and `nodeIntegration:false`, which helps, but has no explicit navigation/window-open restrictions or IPC sender validation; renderer HTML has no CSP. A compromised renderer retains the exposed management IPC capabilities.
8. **Network research does not constrain destinations.** `backend/main.py:808` fetches research URLs and follows redirects without blocking loopback/private/link-local targets. Treat external search results and redirects as untrusted, and enforce destination policy before each request.
9. **Managed-agent lifecycle is development-dependent.** Electron spawns `pnpm ... dev:service` with `shell:true` from a repository-relative working directory and stops only its immediate process (`apps/desktop/src/main.cts:517`). The packaged portable executable includes only `dist` and package.json (`apps/desktop/package.json`), not the agent or runtime dependencies. A built installer is not evidence of a self-contained functional agent distribution.

## Claims that need correction or evidence

- `pipeline.ts:45` fabricates eight realistic business names, domains, emails, and descending scores. They are not discovered or verified leads. `normalizeLead` also guesses missing email addresses and scores. Synthetic records need explicit provenance and must never become real outreach targets by default.
- Lead-mode draft copy says "I looked at" / "I reviewed" a supplied website although the builder merely formats strings. Remove claims of research unless the run carries actual research evidence.
- Legacy `start_sandbox_session` only returns `sandbox_ready` plus a whitelist (`backend/main.py:1445`). No sandbox is created there. The UI must not claim isolation based on that result.
- Legacy `/chat` recognizes `run`, `launch`, `go`, or `do it` anywhere in a message, while its instructions say to end a message with RUN (`backend/main.py:2203`). Ordinary descriptions can trigger queue creation unexpectedly.
- Legacy chat reports "Pipeline executed" immediately after queue creation (`backend/main.py:2254`); it has not completed the queued desktop work.
- Existing `docs/ARCHITECTURE.md` covers only an MVP Node path. Its audit redaction, queue transition, and kill guarantees require engine/storage evidence, and it omits the second stack, control brain, permission scope, packaging prerequisites, and trust boundaries.

## Interfaces to preserve or migrate deliberately

| Surface | Contract |
| --- | --- |
| Web agent client | `/device/default-pairing`, `/device/status`, `/pipeline/demo`, `/queue/status`, `/action/approve`, `/action/reject`, WebSocket `/logs/stream` |
| Desktop renderer | Above plus `/settings`, `/permissions/grant`, `/auth/bootstrap`, `/pipeline/lead-mode`, `/operator/pause`, `/operator/resume`, cognition endpoints, `/kill` |
| Desktop overlay | `/control/execute`, `/control/reset-session`, presence IPC |
| Preload IPC | Agent start/stop/kill, resume-after-input, open main, presence mode/size/update; event subscriptions return cleanup functions |
| Brain planner | Session ID + message -> `needs_input` question or `queued` actions with objective and optional typed OS steps |
| Pipeline builder | Typed pipeline request -> run ID, project path, plan, action envelopes with permission strings and risk labels |
| Legacy UI/API | Caller user ID; `/chat`, `/state/{user_id}`, `/queue/*`, `/session/*`, preview/artifacts/CRM/log routes; independent data/state model |

## Build and verification inventory

- Root: `pnpm build` recursively builds workspace packages; `pnpm lint` recursively runs configured lint commands. Neither includes legacy frontend/backend.
- Web: `pnpm --filter @operator-assist/web build`; its `lint` script is TypeScript `--noEmit`, not an ESLint security check.
- Desktop: `pnpm --filter @operator-assist/desktop lint`, `pnpm --filter @operator-assist/desktop build:ts`; full `build` also invokes electron-builder and produces portable Windows output.
- Legacy frontend: run its `npm run build` and `npm run lint` from `frontend` separately. Backend syntax can be checked without importing application side effects using Python's `ast.parse` on `backend/main.py`.
- No test/spec files were found by the scoped repository file search excluding dependencies, output, profiles, and generated content. No tests or live applications were run for this read-only audit. Key future tests should exercise authentication, canonical workspace containment, duplicate execution claims, adapter failure propagation, kill during a child process, and terminal action verification with fake adapters.
