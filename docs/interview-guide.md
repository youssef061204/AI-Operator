# Defensible interview material

Use measured artifacts and source code when presenting this project. Do not describe the original template tools as autonomous specialists or a sandbox. Current scope is a local developer agent.

## Three resume bullets

- Built a Gemini 3.8 Flash software-engineering agent with 7 validated tools, bounded observe/act/verify execution, transactional SQLite events, and a browser approval/diff workflow; ran 31 automated cases with 0 failures (28 passed, 3 environment skips) in the final pass.
- Designed Git worktree isolation and conflict-aware multi-file changesets with durable recovery, plus a Docker execution broker enforcing CPU, memory, PID, timeout, capability, mount, and network limits.
- Created a 50-task coding benchmark across 10 software-engineering categories with independent hidden graders; validated all 50 cases by rejecting each broken baseline and accepting each reference solution, while separately passing 42/42 runtime-safety outcomes with 0 permission violations.

## Ten questions and answers

1. **Why replace the original engine?** The baseline had caller-controlled permissions and a cancellation race. An in-memory dry-run reproduction records RUNNING despite approval mode, then CANCELED becoming SUCCESS. Its synthesized tools were echo scripts. Separating a typed runtime was easier to reason about than extending that monolith.
2. **What makes this an agent loop?** Each model decision chooses one typed tool; its observed output or error is included in the next decision. The model can revise a public plan after failure. A finish request triggers independent runtime checks against user-supplied criteria.
3. **What is deterministic around the model?** Decision validation, permission checks, task transitions, step/deadline/repetition bounds, exact action fingerprints and completion criteria. A FixtureProvider drives these seams without claiming to measure LLM intelligence.
4. **How do approvals prevent stale execution?** They include task ID, canonical full call and purpose in a SHA-256 digest, have a unique ID and expiry, and are consumed once. Hash preconditions separately reject stale file contents. High-risk calls cannot receive a task-wide bypass.
5. **Is shell execution sandboxed?** By default it runs in Docker with resource limits, no network, a read-only root, dropped capabilities, and only the isolated task workspace mounted. Docker still shares the host kernel. An explicit native backend exists and retains user privileges.
6. **How does cancellation work?** AbortController propagates through provider/tool work; terminal states cannot transition to completion. A runtime retains workspace admission until cleanup resolves. Pause stops at boundaries rather than pretending to freeze arbitrary processes.
7. **What does rollback guarantee?** The broker freezes a task changeset, preflights every destination hash, journals progress, and compensates interrupted application. Accept and revert preserve conflicting external edits. Renames are visible one file at a time, so this is crash-recoverable batch application rather than filesystem-wide atomic visibility.
8. **What is persisted and how is restart handled?** SQLite commits task snapshots and event records together. Structured history and metrics persist. Restart marks unfinished tasks interrupted and never blindly replays a command with uncertain side effects. Corruption fails closed.
9. **How did you evaluate reliability?** Fourteen runtime scenarios repeat three times with real tools, producing 42/42 expected safe outcomes. A separate 50-task coding suite uses broken fixtures, reference solutions, and graders outside the model workspace. Fixture integrity and live Gemini capability remain separate metrics.
10. **What would you improve next?** Run the complete 50-task Gemini sample once credentials are available, add container image pinning/signature policy, use OS-specific stronger isolation, paginate retained events, and add larger multi-package fixtures without weakening hidden verification.
