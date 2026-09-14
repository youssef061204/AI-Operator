import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  TaskRequestSchema,
  DecisionSchema,
  terminal,
  transition,
  type Task,
  type TaskEvent,
  type Provider,
  type Approval,
  type ModelContext,
} from "./contracts.js";
import { WorkspaceTools, type ToolCall } from "./tools.js";
import { TaskStore, redact } from "./store.js";
import { boundedContext } from "./providers.js";

export function digest(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, canonical(x)]),
      );
    return v;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
interface Control {
  abort: AbortController;
  wake?: () => void;
  approval?: { resolve: () => void; reject: (e: Error) => void };
  grants: Set<string>;
  work: Promise<void>;
}
export class AgentRuntime {
  readonly events = new EventEmitter();
  readonly tools: WorkspaceTools;
  private tasks = new Map<string, Task>();
  private controls = new Map<string, Control>();
  constructor(
    readonly store: TaskStore,
    workspace: string,
    readonly providers: Provider[],
  ) {
    if (!providers.length)
      throw new Error("At least one model provider is required");
    this.tools = new WorkspaceTools(
      workspace,
      path.join(store.directory, "checkpoints"),
    );
    for (const task of store.list()) this.tasks.set(task.id, task);
  }
  list(): Task[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => this.public(t));
  }
  get(id: string): Task {
    return this.public(this.require(id));
  }
  private public(task: Task): Task {
    return structuredClone(redact(task)) as Task;
  }
  private require(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Unknown task");
    return task;
  }
  private emit(
    task: Task,
    type: string,
    data: Record<string, unknown> = {},
  ): void {
    const event = this.store.save(task, type, data);
    this.events.emit("event", event satisfies TaskEvent);
  }
  private status(task: Task, status: Task["status"]): void {
    transition(task, status);
    this.emit(task, "state", { status });
  }
  private assertIdle(): void {
    if (
      this.controls.size ||
      [...this.tasks.values()].some((t) => !terminal(t.status))
    )
      throw new Error(
        "Workspace busy; wait for active work and process cleanup to finish",
      );
  }
  create(input: unknown): Task {
    this.assertIdle();
    const request = TaskRequestSchema.parse(input);
    const now = Date.now();
    const task: Task = {
      ...request,
      id: randomUUID(),
      status: "queued",
      plan: [],
      steps: 0,
      createdAt: now,
      updatedAt: now,
      deadline: now + request.limits.timeoutMs,
      observations: [],
      checkpoints: [],
      metrics: {
        modelCalls: 0,
        toolCalls: 0,
        toolErrors: 0,
        modelMs: 0,
        toolMs: 0,
        tokens: 0,
      },
    };
    for (const [tool, policy] of Object.entries(task.policy)) {
      if (
        ![
          "read_file",
          "list_files",
          "search",
          "write_file",
          "patch_file",
          "shell",
          "restore",
        ].includes(tool)
      )
        throw new Error(`Unknown policy tool: ${tool}`);
      if (
        policy === "allow_task" &&
        ![
          "read_file",
          "list_files",
          "search",
          "write_file",
          "patch_file",
        ].includes(tool)
      )
        throw new Error("High-risk tools always require exact approval");
    }
    this.tasks.set(task.id, task);
    this.emit(task, "request", {
      objective: task.objective,
      verification: task.verification,
      policy: task.policy,
    });
    this.launch(task, () => this.loop(task));
    return this.public(task);
  }
  private launch(task: Task, work: () => Promise<void>): void {
    const control: Control = {
      abort: new AbortController(),
      grants: new Set(),
      work: Promise.resolve(),
    };
    this.controls.set(task.id, control);
    const timer = setTimeout(
      () => {
        control.abort.abort(new Error("Task deadline exceeded"));
        control.wake?.();
      },
      Math.max(1, task.deadline - Date.now()),
    );
    control.work = Promise.resolve()
      .then(async () => {
        this.check(task);
        this.status(task, "running");
        await work();
      })
      .catch((error) => {
        if (!terminal(task.status)) {
          task.error = String(
            redact(error instanceof Error ? error.message : String(error)),
          );
          delete task.approval;
          this.status(task, "failed");
          this.emit(task, "error", { error: task.error });
        }
      })
      .finally(() => {
        clearTimeout(timer);
        control.approval = undefined;
        control.wake?.();
        this.controls.delete(task.id);
      });
  }
  private check(task: Task): void {
    this.controls.get(task.id)?.abort.signal.throwIfAborted();
    if (terminal(task.status)) throw new Error("Task is terminal");
    if (Date.now() >= task.deadline) throw new Error("Task deadline exceeded");
  }
  private async gate(task: Task): Promise<void> {
    this.check(task);
    while (task.status === "paused") {
      const control = this.controls.get(task.id)!;
      await new Promise<void>((resolve) => {
        control.wake = resolve;
      });
      control.wake = undefined;
      this.check(task);
    }
  }
  private async authorize(
    task: Task,
    call: ToolCall,
    reason: string,
    purpose: Approval["purpose"],
  ): Promise<void> {
    await this.gate(task);
    const control = this.controls.get(task.id)!;
    const details = this.tools.describe(call);
    const policy = task.policy[call.tool] ?? "ask";
    if (policy === "deny") throw new Error(`Policy denies ${call.tool}`);
    if (details.risk === "LOW") return;
    const grant = digest({ tool: call.tool, resources: details.resources });
    if (
      details.risk !== "HIGH" &&
      (policy === "allow_task" || control.grants.has(grant))
    )
      return;
    const approval: Approval = {
      id: randomUUID(),
      digest: digest({ taskId: task.id, call, purpose }),
      call: structuredClone(call),
      reason,
      ...details,
      expiresAt: Math.min(task.deadline, Date.now() + 120000),
      purpose,
    };
    task.approval = approval;
    this.status(task, "awaiting_approval");
    // Install resolver before notifying UI/test listeners.
    const wait = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => control.approval?.reject(new Error("Approval expired")),
        Math.max(1, approval.expiresAt - Date.now()),
      );
      const abort = () =>
        control.approval?.reject(new Error("Approval interrupted"));
      control.abort.signal.addEventListener("abort", abort, { once: true });
      const clean = () => {
        clearTimeout(timer);
        control.abort.signal.removeEventListener("abort", abort);
      };
      control.approval = {
        resolve: () => {
          clean();
          resolve();
        },
        reject: (e) => {
          clean();
          reject(e);
        },
      };
    });
    this.emit(task, "approval_requested", { approval });
    try {
      await wait;
      this.check(task);
      if (approval.digest !== digest({ taskId: task.id, call, purpose }))
        throw new Error("Stale approval: action changed");
    } finally {
      control.approval = undefined;
      delete task.approval;
    }
    await this.gate(task);
  }
  decideApproval(
    id: string,
    input: {
      approvalId: string;
      digest: string;
      decision: "approve" | "deny";
      scope?: "once" | "task";
    },
  ): Task {
    const task = this.require(id);
    const control = this.controls.get(id);
    const approval = task.approval;
    if (!approval || !control?.approval || task.status !== "awaiting_approval")
      throw new Error("No pending approval");
    if (
      approval.id !== input.approvalId ||
      approval.digest !== input.digest ||
      Date.now() >= approval.expiresAt
    )
      throw new Error("Stale or expired approval");
    if (input.scope === "task" && approval.risk === "HIGH")
      throw new Error("High-risk actions require approval every time");
    const pending = control.approval;
    control.approval = undefined;
    this.emit(task, "approval_response", {
      approvalId: approval.id,
      decision: input.decision,
      scope: input.scope ?? "once",
    });
    if (input.decision === "deny")
      pending.reject(new Error("Operator denied action"));
    else {
      if (input.scope === "task")
        control.grants.add(
          digest({ tool: approval.call.tool, resources: approval.resources }),
        );
      this.status(task, "running");
      pending.resolve();
    }
    return this.public(task);
  }
  pause(id: string): Task {
    const task = this.require(id);
    if (task.status !== "running")
      throw new Error(
        "Pause requires a running task; resolve pending approval first",
      );
    this.status(task, "paused");
    return this.public(task);
  }
  resume(id: string): Task {
    const task = this.require(id);
    if (task.status !== "paused") throw new Error("Task is not paused");
    this.status(task, "running");
    this.controls.get(id)?.wake?.();
    return this.public(task);
  }
  cancel(id: string): Task {
    const task = this.require(id);
    if (terminal(task.status)) return this.public(task);
    const control = this.controls.get(id);
    control?.abort.abort(new Error("Canceled by operator"));
    control?.wake?.();
    delete task.approval;
    task.error = "Canceled by operator";
    this.status(task, "canceled");
    return this.public(task);
  }
  private async execute(
    task: Task,
    call: ToolCall,
    reason: string,
    purpose: Approval["purpose"] = "action",
  ): Promise<Record<string, unknown>> {
    try {
      await this.authorize(task, call, reason, purpose);
    } catch (error) {
      const message = String(
        redact(error instanceof Error ? error.message : String(error)),
      );
      task.observations.push({ step: task.steps, call, error: message });
      this.emit(task, "action_rejected", { call, error: message, purpose });
      throw error;
    }
    this.check(task);
    this.emit(task, "tool_started", { call, purpose });
    const start = performance.now();
    task.metrics.toolCalls++;
    let result: Record<string, unknown> | undefined;
    try {
      result = await this.tools.execute(
        call,
        this.controls.get(task.id)!.abort.signal,
      );
      // Preserve rollback evidence even when cancellation wins after the filesystem effect.
      if (typeof result.checkpointId === "string")
        task.checkpoints.push(result.checkpointId);
      this.check(task);
      if (call.tool === "shell" && result.exitCode !== 0)
        throw new Error(
          `Command exited ${result.exitCode}: ${String(result.stderr ?? "").slice(0, 4000)}`,
        );
      task.observations.push({ step: task.steps, call, result });
      this.emit(task, "tool_result", {
        call,
        result,
        purpose,
        durationMs: performance.now() - start,
      });
      return result;
    } catch (error) {
      task.metrics.toolErrors++;
      const message = String(
        redact(error instanceof Error ? error.message : String(error)),
      );
      task.observations.push({
        step: task.steps,
        call,
        result,
        error: message,
      });
      this.emit(task, "tool_error", {
        call,
        result,
        error: message,
        purpose,
        durationMs: performance.now() - start,
      });
      throw error;
    } finally {
      task.metrics.toolMs += performance.now() - start;
    }
  }
  private async model(
    task: Task,
    context: ModelContext,
  ): Promise<ReturnType<typeof DecisionSchema.parse>> {
    let last: unknown;
    for (const provider of this.providers) {
      this.check(task);
      const start = performance.now();
      task.metrics.modelCalls++;
      try {
        const signal = this.controls.get(task.id)!.abort.signal;
        const output = await abortable(
          provider.decide(context, signal),
          signal,
        );
        this.check(task);
        task.metrics.tokens +=
          Number.isFinite(output.tokens) && output.tokens! > 0
            ? output.tokens!
            : 0;
        const decision = DecisionSchema.parse(output.decision);
        this.emit(task, "model_decision", {
          provider: provider.name,
          decision,
        });
        return decision;
      } catch (error) {
        last = error;
        this.emit(task, "provider_error", {
          provider: provider.name,
          error: String(
            redact(error instanceof Error ? error.message : String(error)),
          ),
        });
      } finally {
        task.metrics.modelMs += performance.now() - start;
      }
    }
    throw new Error(
      `All providers failed: ${last instanceof Error ? last.message : String(last)}`,
    );
  }
  private async loop(task: Task): Promise<void> {
    let errors = 0;
    const repeats = new Map<string, number>();
    while (task.steps < task.limits.maxSteps) {
      await this.gate(task);
      task.steps++;
      let decision;
      try {
        decision = await this.model(
          task,
          boundedContext({
            objective: task.objective,
            plan: task.plan,
            observations: task.observations,
            verification: task.verification,
            stepsRemaining: task.limits.maxSteps - task.steps,
          }),
        );
      } catch (error) {
        this.check(task);
        task.observations.push({
          step: task.steps,
          error: error instanceof Error ? error.message : String(error),
        });
        if (++errors >= task.limits.maxErrors) throw error;
        continue;
      }
      await this.gate(task);
      if (decision.kind === "finish") {
        try {
          await this.verify(task);
        } catch (error) {
          this.check(task);
          task.observations.push({
            step: task.steps,
            error: `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
          });
          this.emit(task, "verification_failed", {
            error: task.observations.at(-1)?.error,
          });
          if (
            ++errors >= task.limits.maxErrors ||
            /denied|expired|Policy/.test(String(error))
          )
            throw error;
          continue;
        }
        await this.gate(task);
        task.summary = decision.summary;
        this.status(task, "completed");
        return;
      }
      task.plan = decision.plan;
      const key = digest(decision.call);
      const count = (repeats.get(key) ?? 0) + 1;
      repeats.set(key, count);
      if (count > 3) throw new Error("Repeated action limit exceeded");
      try {
        await this.execute(task, decision.call, decision.reason);
        errors = 0;
      } catch (error) {
        this.check(task);
        if (
          ++errors >= task.limits.maxErrors ||
          /denied|expired|Policy/.test(String(error))
        )
          throw error;
      }
    }
    throw new Error("Maximum agent steps exceeded");
  }
  private async verify(task: Task): Promise<void> {
    for (const criterion of task.verification) {
      await this.gate(task);
      if (criterion.kind === "file_contains") {
        const result = await this.execute(
          task,
          { tool: "read_file", path: criterion.path },
          "Verify user-supplied file criterion",
          "verification",
        );
        if (
          typeof result.content !== "string" ||
          !result.content.includes(criterion.text)
        )
          throw new Error(`File criterion not met: ${criterion.path}`);
      } else {
        const result = await this.execute(
          task,
          {
            tool: "shell",
            command: criterion.command,
            args: criterion.args,
            cwd: criterion.cwd,
            timeoutMs: 30000,
          },
          "Run user-supplied verification command",
          "verification",
        );
        if (result.exitCode !== 0)
          throw new Error(`Verification command exited ${result.exitCode}`);
      }
    }
    this.emit(task, "verification_passed", {
      criteria: task.verification.length,
    });
  }
  restore(parentId: string, checkpointId: string): Task {
    this.assertIdle();
    if (this.controls.size)
      throw new Error("Previous process cleanup is still running");
    const parent = this.require(parentId);
    if (!parent.checkpoints.includes(checkpointId))
      throw new Error("Checkpoint does not belong to task");
    const now = Date.now();
    const task: Task = {
      ...structuredClone(parent),
      id: randomUUID(),
      objective: `Restore checkpoint ${checkpointId}`,
      status: "queued",
      plan: ["Approve restoration", "Restore guarded snapshot"],
      steps: 0,
      createdAt: now,
      updatedAt: now,
      deadline: now + 120000,
      observations: [],
      checkpoints: [],
      policy: {},
      summary: undefined,
      error: undefined,
      approval: undefined,
      metrics: {
        modelCalls: 0,
        toolCalls: 0,
        toolErrors: 0,
        modelMs: 0,
        toolMs: 0,
        tokens: 0,
      },
    };
    this.tasks.set(task.id, task);
    this.emit(task, "request", { parentId, checkpointId });
    this.launch(task, async () => {
      await this.execute(
        task,
        { tool: "restore", checkpointId },
        "Restore a previous file version; refuses conflicting edits",
        "restore",
      );
      this.check(task);
      task.summary = "Checkpoint restored with precondition checks";
      this.status(task, "completed");
    });
    return this.public(task);
  }
  async wait(id: string): Promise<Task> {
    await this.controls.get(id)?.work;
    return this.get(id);
  }
  async close(): Promise<void> {
    for (const id of this.controls.keys()) this.cancel(id);
    await Promise.all([...this.controls.values()].map((c) => c.work));
    this.store.close();
  }
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
