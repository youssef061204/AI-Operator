# Defensible interview material

Use measured artifacts and source code when presenting this project. Do not describe the original template tools as autonomous specialists or a sandbox. Current scope is a local developer agent.

## Three resume bullets

- Rebuilt a local developer-agent runtime with 7 validated tools, bounded observe/act/verify execution, cancellation, and transactional SQLite persistence; verified behavior with 23 passing automated tests and a passing browser E2E test.
- Implemented digest-bound, expiring approvals and hash-checked edits/rollback, achieving 0 permission violations and 42/42 expected outcomes across 14 scripted-provider scenarios repeated 3 times.
- Built a reproducible evaluation harness covering debugging, failure recovery, refusals, and rollback; completed 1 live Qwen 2.5 7B bug-fix smoke task while keeping its result separate from deterministic test outcomes.

## Ten questions and answers

1. **Why replace the original engine?** The baseline had caller-controlled permissions and a cancellation race. An in-memory dry-run reproduction records RUNNING despite approval mode, then CANCELED becoming SUCCESS. Its synthesized tools were echo scripts. Separating a typed runtime was easier to reason about than extending that monolith.
2. **What makes this an agent loop?** Each model decision chooses one typed tool; its observed output or error is included in the next decision. The model can revise a public plan after failure. A finish request triggers independent runtime checks against user-supplied criteria.
3. **What is deterministic around the model?** Decision validation, permission checks, task transitions, step/deadline/repetition bounds, exact action fingerprints and completion criteria. A FixtureProvider drives these seams without claiming to measure LLM intelligence.
4. **How do approvals prevent stale execution?** They include task ID, canonical full call and purpose in a SHA-256 digest, have a unique ID and expiry, and are consumed once. Hash preconditions separately reject stale file contents. High-risk calls cannot receive a task-wide bypass.
5. **Is shell execution sandboxed?** No. It uses literal argv, a minimal environment, output caps and process-tree termination. Approved commands retain user privileges and can escape filesystem guards. Containers or OS enforcement would be needed for hostile arbitrary programs.
6. **How does cancellation work?** AbortController propagates through provider/tool work; terminal states cannot transition to completion. A runtime retains workspace admission until cleanup resolves. Pause stops at boundaries rather than pretending to freeze arbitrary processes.
7. **What does rollback guarantee?** A plaintext snapshot exists before each file edit. Restore checks workspace and current after-hash before replacing or deleting the file. It preserves unrelated external edits by refusing conflicts. It is not multi-file transactional or fully power-loss durable.
8. **What is persisted and how is restart handled?** SQLite commits task snapshots and event records together. Structured history and metrics persist. Restart marks unfinished tasks interrupted and never blindly replays a command with uncertain side effects. Corruption fails closed.
9. **How did you evaluate reliability?** Fourteen scenarios repeat three times using real temporary repositories and subprocesses. Expected refusals count as safe outcomes, not task completions. JSON artifacts include timings, steps, tool errors, violations and rollback assertions. A separate live local Qwen task fixed a bug and passed a test after recovering from an initial timeout.
10. **What would you improve next?** OS-enforced command isolation, multi-process workspace ownership, durable recovery of snapshots after crash windows, bounded/paginated retention, broader live-model evaluations, and stronger trusted verification. I would add browser/desktop tools only with explicit action-specific safety tests.
