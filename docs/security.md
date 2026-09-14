# Security model

The supported runtime is a single-user local developer agent, not an OS sandbox or a remote multi-tenant service.

## Enforced boundaries

- API binds IPv4 loopback. Host must match localhost/127.0.0.1 and the actual port. Browser origins are exact allowlisted origins. Task data, approvals, kill and events require a bearer token. Public health contains only service/provider names. Random 256-bit tokens live in `.operator/api-token`; they are not embedded in frontend assets. POSIX mode is restrictive; Windows ACLs inherit the directory's protection. UI stores the token for the tab session.
- Strict Zod decision/tool unions prevent caller-selected risk or approval flags. Reads/searches are LOW, writes/patches MEDIUM, shell/restore HIGH. HIGH requires approval every time. Deny policy runs first. Approval binds task, canonical full call and purpose by SHA-256, expires and is consumed once. UI task grants bind tool and resource. Explicit task creation policy may allow a file-tool class across the workspace, never shell/restore.
- File tools reject absolute/traversal paths, sensitive components, Windows alternate streams/device aliases, symlinks/junctions and hardlinks. Text size is capped; binary/non-UTF-8 files are refused. Updates require a matching hash; creates require null expected hash. Patches require one literal occurrence. Exclusive temporary siblings and rename implement writes. Snapshots persist before mutation; restore checks current post-edit hash and workspace binding.
- Shell uses executable/argument arrays without an implicit shell, minimal environment, bounded output, deadlines and cancellation. Windows uses taskkill /T /F; POSIX uses process groups. Admission remains closed until cleanup resolves. Command failures preserve output/exit status. Windows batch commands require an explicit approved interpreter.
- Task step/deadline/error/repetition limits are enforced. Pause stops at boundaries, not midway through an active process. Cancel cannot later become success. Restart marks unfinished tasks interrupted rather than replaying effects. State and audit events commit together in SQLite. Known environment secrets and credential-shaped fields are redacted. Corrupt task structures fail closed and release the database handle.

## Residual risks

Approved shell programs have the user's privileges: they can access outside files, networks and disk credentials, modify verification tests, or escape process tracking. Working directory and environment scrubbing are not isolation. No containers, kernel network policy, Windows Job Objects or Linux cgroups are implemented. Tests cover ordinary child-process cleanup, not deliberately escaping daemons.

Portable Node checks cannot eliminate filesystem TOCTOU against hostile external writers. Workspaces/checkpoints must not be shared with hostile processes. Checkpoints contain plaintext source. Multi-file rollback is not atomic. Rename does not imply power-loss durability: fsync is not implemented. A crash after mutation but before result persistence can leave a snapshot missing from task history, requiring manual recovery.

Redaction is best effort, not a secret-detection guarantee. Source/model input may contain unknown secrets. Configured model endpoints receive selected content. There is no arbitrary HTTP tool. Prompt injection cannot grant permissions but can persuade a person to approve harmful work. Completion proves only supplied criteria; an empty file criterion checks readability. Writable tests are not an independent oracle.

An exclusive data-directory lock prevents two runtimes sharing one database. After an unclean crash, inspect the PID recorded in `.operator/runtime.lock` and remove the stale file only after confirming that process is gone. Recovery then marks unfinished tasks interrupted. Distinct data directories targeting the same workspace are not coordinated. No automatic history retention/pruning is implemented. Electron is a sandboxed viewer requiring the running web service, not a bundled autonomous runtime. Legacy Python and OS-control sources are unsupported; their old APIs must not be used.

## Dependency evidence

Run `pnpm test`, `pnpm test:browser`, `pnpm evaluate`, and `pnpm audit --prod`. Artifacts record actual results. Standard symlink creation can be skipped without Windows privilege; junction tests run separately.

Original Next 16.1.2 had critical [Windows server RCE](https://github.com/advisories/GHSA-p293-qw3h-jr36) and [AVIF processing RCE](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4) advisories. The supported web dependency is upgraded to 16.3.5. Consult the final audit artifact for remaining dependency findings. No exploit was attempted. Setup/tests preserve unrelated processes.
