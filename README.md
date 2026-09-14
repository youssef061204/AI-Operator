# AI Operator

A local-first developer agent with explicit tool permissions, guarded edits, checkpoints, transactional events, and reproducible evaluations. The supported runtime is under `packages/agent/src/runtime`; the original desktop-automation engine is retired.

## Measured results

| Evidence | Result | Scope |
|---|---:|---|
| Deterministic evaluation | 42/42 expected outcomes across 14 scenarios and 3 runs; 0 permission violations | Scripted model decisions exercising real file/process tools; not an LLM success rate |
| Automated tests | 23 passed, 1 skipped; browser E2E passed | Windows standard symlink test requires privileges; junction defense passed |
| Live local model | 1/1 bug-fix task completed; test passed | One Qwen 2.5 7B run, 70.29 s including a recovered timeout; no general success-rate claim |
| Dependency audit | 0 production and development advisories | pnpm audit after dependency upgrades |

The strongest claim is **reproducible safety behavior**, rather than speed: the evaluation includes denied actions, injected tool failures, cancellation, stale edits, and rollback. [Read the evaluation method](docs/evaluation.md) and [machine-readable results](artifacts/evaluation/latest.json).

## Run

Prerequisites: Node **24.13+ (24.x)**, pnpm **10.6**, and an installed Ollama model for live tasks. Deterministic tests do not need a model.

```powershell
pnpm install --frozen-lockfile
pnpm rebuild electron esbuild sharp unrs-resolver
ollama pull qwen2.5:7b-instruct
$env:OPERATOR_MODEL = 'qwen2.5:7b-instruct'
# Optional: select an existing project directory. Defaults to this repository.
$env:OPERATOR_WORKSPACE = 'C:\path\to\your\project'
pnpm dev
```

Open `http://localhost:3000`. Read `.operator/api-token` locally and paste it into **Access token**. Create an objective and an explicit file verification criterion. Review exact actions before approving them. The token and database stay local and are ignored by Git. The runtime does not automatically load the old `.env` file.

Use a second terminal for Ollama if it is not already running: `ollama serve`. Do not launch a second server on an occupied port. Setup never kills another application's processes.

```powershell
pnpm cli --help
pnpm cli tasks
pnpm cli create examples/task.json
pnpm cli show TASK_ID
pnpm cli events TASK_ID
pnpm cli cancel TASK_ID
```

`examples/task.json` is a read-only repository-inspection request; edit its verification criteria for your workspace. CLI approval takes a JSON file with the pending `approvalId`, `digest`, `decision` (`approve`/`deny`) and `scope` (`once`/`task`). It cannot bypass high-risk approvals.

## Verify and evaluate

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm exec playwright install chromium
pnpm test:browser
pnpm evaluate
pnpm test:live
pnpm build
pnpm audit --prod
```

Browser tests reserve 3010 and 7788 and use temporary fixture data; they refuse to reuse an existing service. `test:live` uses a local Ollama model, takes up to three minutes, and creates a temporary bug-fix fixture. Its automatic approvals are restricted to that fixture's file and exact verification command. It is not a general auto-approve mode.

Evaluation JSON is generated in `artifacts/evaluation/latest.json`, with `docs/evaluation.md` generated from the measurements. These are real filesystem/process tasks with scripted provider decisions, not LLM success-rate claims. A separate `live-smoke.json` records a real local-model test. No dashboard numbers are hardcoded.

## What is implemented

- Observe/act/verify loop with strict decisions, public plans, step/deadline/error/repetition limits, provider fallback, pause and cancellation.
- Seven tools: bounded file read, file list, literal repository search, hash-guarded write, unique-literal patch, explicit-argument process execution, checkpoint restore.
- Server-owned risk policy; exact, expiring, one-use approvals; task grants for file resources; deny policy; high-risk commands and restoration always require approval.
- Persistent snapshots with stale-edit protection; restoration refuses overwriting externally changed files.
- SQLite task state and events committed together; interrupted tasks are not replayed on restart; event replay and authenticated NDJSON streaming.
- Authenticated loopback API, tab-session token entry, actual observations/metrics, task controls and checkpoint review.
- Local Ollama provider and deterministic fixture seam. Task-local persisted memory and bounded character-budget context.

## Configuration

| Variable | Default / purpose |
|---|---|
| `OPERATOR_WORKSPACE` | Repository root; must exist |
| `OPERATOR_DATA_DIR` | Repository `.operator` directory |
| `OPERATOR_PORT` | 7788, loopback only |
| `OPERATOR_API_TOKEN` | Optional explicit token, at least 32 characters; otherwise generated locally |
| `OPERATOR_MODEL` | qwen2.5-coder:7b; select your installed Ollama model |
| `OPERATOR_MODEL_URL` | http://127.0.0.1:11434 |
| `OPERATOR_FALLBACK_MODEL` | Optional explicit fallback model |
| `OPERATOR_FALLBACK_URL` | http://127.0.0.1:11434 |
| `NEXT_PUBLIC_AGENT_URL` | http://127.0.0.1:7788; web build-time API URL |

No credentials are required for local Ollama. Remote endpoints receive selected source context. There is no commercial-provider adapter or generic HTTP/browser/desktop tool in the supported runtime.

## Desktop and production builds

`pnpm build` compiles the agent/CLI/shared package, builds Next, and produces an unsigned Windows portable Electron viewer under `apps/desktop/release`. The viewer requires the runtime and web app already running at their default ports. It does not bundle Node/Ollama or start a hidden execution service.

For a compiled local deployment, run these in separate terminals after building:

```powershell
pnpm --filter @operator-assist/agent start
pnpm --filter @operator-assist/web start
```

Optional viewer: `pnpm --filter @operator-assist/desktop dev` after `pnpm dev` is running. The browser console is the primary supported interface.

## Boundaries and evidence

Approved commands have your OS privileges. Workspace guards are not kernel isolation; hostile external filesystem races and escaping daemons are not fully contained. Verification proves the criteria you supplied, not every aspect of a prose objective. Checkpoints are plaintext, file-scoped and not crash-atomic across multiple files. See [security](docs/security.md).

[Baseline audit](docs/baseline-audit.md) · [Original architecture](docs/architecture-current.md) · [Decision](docs/adr/001-core-architecture.md) · [Current architecture](docs/architecture.md) · [Evaluation](docs/evaluation.md) · [Interview guide](docs/interview-guide.md)

Legacy `backend`, `frontend`, old Node engine/cognition/control files and old desktop renderers remain for historical review. They are not part of the supported execution path. The old Node server is disabled. Do not run the old unauthenticated Python service. Existing `.env`, browser profiles, databases, generated sites and binaries were not deleted.
