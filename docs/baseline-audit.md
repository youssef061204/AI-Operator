# Baseline audit — 2026-09-14

The supplied directory is not a Git checkout (`git status`, branch and HEAD all fail). No commit or branch can be recorded. Existing work is preserved: `artifacts/baseline/source-inventory.json` records SHA-256 hashes; a local source backup excludes secrets, profiles, dependencies and generated outputs. Do not publish the backup archive.

## Inventory and commands

Active pnpm workspace: Next.js 16 / React 19 web, Electron 34 desktop, Node TypeScript agent, shared Zod contracts. Legacy Python FastAPI backend and separate Next frontend remain. The agent contains a 159 KB execution engine, template cognition loop, OS control reasoner, synchronous SQLite persistence and REST/WebSocket transport. No test files, test scripts, CLI, formatter or evaluation harness existed in the active workspace.

Commands: `pnpm install --frozen-lockfile`, `pnpm dev`, `pnpm -r lint` (actually TypeScript checks), `pnpm -r build`, `pnpm desktop:build`. Node on this machine: 24.13.0; pnpm: 10.6.0. SQLite uses Node's built-in experimental module.

Both initial lint and build failed with missing `node_modules/typescript/bin/tsc`. Exact output and exit codes are in `artifacts/baseline/`. Dependency repair is recorded separately from the untouched baseline. There were no unit/integration/E2E/browser suites to run. No task success-rate baseline is available; do not infer one from absent tests. A later safe reproduction against the retained engine (`behavior.json`) confirms that empty caller permissions bypass approval and a canceled dry-run becomes SUCCESS after its adapter returns. No live OS, publishing or network action was attempted in that reproduction.

Backup verification matched all 75 inventoried source hashes. `source-baseline.zip` reconstructs original directory paths and is ignored by Git; `backup-verification.json` records the check. The original flat archive is also retained locally.

## Local-only material

An `.env` exists and was not printed, copied or changed. Database files, browser profiles (including cookies and sessions), generated sites, nested agent data directories, virtualenv, installer binaries and logs exist. Original ignore rules miss backend and nested data directories. No files can currently be committed because Git metadata is absent.

## Findings

Real mechanisms: SQLite actions/settings/logs, event broadcasts, typed action inputs, child processes, PowerShell OS input and screenshots, Ollama requests, frontend approval buttons. Presence of adapters is not evidence of successful live OS or model execution.

Misleading/incomplete: README approvals default ON but code defaults OFF and startup disables approvals when autonomous runtime is set. Empty caller-supplied permissions bypass approval. Synthesized tools are canned echo scripts marked sandboxed despite unrestricted Node execution. Specialists are strings. Goal completion is based on queued action statuses, not objective verification. Browser/Lovable actions throw disabled errors. Fake leads are generated from templates. Kill marks canceled then resets the processing flag while the old execution can still finish and mark success. Child timeout kills only the immediate process; output is accumulated without a bound. Filesystem paths are not confined. Wildcard CORS and unauthenticated APIs expose execution/settings/approvals. Pairing is a database lookup, not authentication. Detailed surface audit is in `surface-audit.md`.
