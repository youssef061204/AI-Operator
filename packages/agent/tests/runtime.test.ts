import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DecisionSchema,
  type ModelContext,
  type Provider,
  type Task,
} from "../src/runtime/contracts.js";
import { FixtureProvider, boundedContext } from "../src/runtime/providers.js";
import { AgentRuntime } from "../src/runtime/runtime.js";
import { TaskStore } from "../src/runtime/store.js";
import { ToolCallSchema } from "../src/runtime/tools.js";

type Fixture = {
  root: string;
  data: string;
  runtime: AgentRuntime;
  cleanup: () => Promise<void>;
};

async function fixture(
  decisions: unknown[],
  providers?: Provider[],
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const root = join(directory, "workspace");
  const data = join(directory, "data");
  await (await import("node:fs/promises")).mkdir(root, { recursive: true });
  const runtime = new AgentRuntime(
    new TaskStore(data),
    root,
    providers ?? [new FixtureProvider(decisions)],
  );
  return {
    root,
    data,
    runtime,
    cleanup: async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function request(
  verification: unknown[] = [
    { kind: "file_contains", path: "result.txt", text: "ok" },
  ],
  policy: Record<string, "ask" | "allow_task" | "deny"> = {},
  limits: Record<string, number> = {},
): Record<string, unknown> {
  return {
    objective: "Safely complete the fixture task",
    verification,
    policy,
    limits: { maxSteps: 8, timeoutMs: 5_000, maxErrors: 2, ...limits },
  };
}

async function waitFor<T>(
  get: () => T | undefined,
  label = "condition",
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("requires approval before a write and denial leaves no file", async () => {
  const f = await fixture([
    {
      kind: "act",
      reason: "write result",
      plan: ["write"],
      call: {
        tool: "write_file",
        path: "result.txt",
        content: "ok",
        expectedHash: null,
      },
    },
    { kind: "finish", summary: "done" },
  ]);
  try {
    f.runtime.events.on("event", (event) => {
      if (event.type === "approval_requested") {
        const approval = event.data.approval as { id: string; digest: string };
        f.runtime.decideApproval(event.taskId, {
          approvalId: approval.id,
          digest: approval.digest,
          decision: "approve",
        });
      }
    });
    const task = f.runtime.create(request());
    const complete = await f.runtime.wait(task.id);
    assert.equal(complete.status, "completed");
    assert.equal(await readFile(join(f.root, "result.txt"), "utf8"), "ok");
  } finally {
    await f.cleanup();
  }

  const denied = await fixture([
    {
      kind: "act",
      reason: "write result",
      plan: ["write"],
      call: {
        tool: "write_file",
        path: "result.txt",
        content: "ok",
        expectedHash: null,
      },
    },
  ]);
  try {
    denied.runtime.events.on("event", (event) => {
      if (event.type === "approval_requested") {
        const approval = event.data.approval as { id: string; digest: string };
        denied.runtime.decideApproval(event.taskId, {
          approvalId: approval.id,
          digest: approval.digest,
          decision: "deny",
        });
      }
    });
    const task = denied.runtime.create(request());
    assert.equal((await denied.runtime.wait(task.id)).status, "failed");
    await assert.rejects(readFile(join(denied.root, "result.txt"), "utf8"));
  } finally {
    await denied.cleanup();
  }
});

test("rejects stale approval digests and approval replay", async () => {
  const f = await fixture([
    {
      kind: "act",
      reason: "write",
      plan: ["write"],
      call: {
        tool: "write_file",
        path: "result.txt",
        content: "ok",
        expectedHash: null,
      },
    },
    { kind: "finish", summary: "done" },
  ]);
  try {
    let pending: { taskId: string; id: string; digest: string } | undefined;
    f.runtime.events.on("event", (event) => {
      if (event.type === "approval_requested") {
        const a = event.data.approval as { id: string; digest: string };
        pending = { taskId: event.taskId, id: a.id, digest: a.digest };
      }
    });
    f.runtime.create(request());
    const approval = await waitFor(() => pending, "approval");
    assert.throws(
      () =>
        f.runtime.decideApproval(approval.taskId, {
          approvalId: approval.id,
          digest: "0".repeat(64),
          decision: "approve",
        }),
      /Stale/i,
    );
    f.runtime.decideApproval(approval.taskId, {
      approvalId: approval.id,
      digest: approval.digest,
      decision: "approve",
    });
    assert.throws(
      () =>
        f.runtime.decideApproval(approval.taskId, {
          approvalId: approval.id,
          digest: approval.digest,
          decision: "approve",
        }),
      /No pending/i,
    );
    assert.equal((await f.runtime.wait(approval.taskId)).status, "completed");
  } finally {
    await f.cleanup();
  }
});

test("does not allow task policy to bypass HIGH calls and grants are resource-exact", async () => {
  const f = await fixture([]);
  try {
    assert.throws(
      () => f.runtime.create(request(undefined, { shell: "allow_task" })),
      /High-risk/i,
    );
  } finally {
    await f.cleanup();
  }

  const exact = await fixture([
    {
      kind: "act",
      reason: "first",
      plan: ["first"],
      call: {
        tool: "write_file",
        path: "a.txt",
        content: "a",
        expectedHash: null,
      },
    },
    {
      kind: "act",
      reason: "second",
      plan: ["second"],
      call: {
        tool: "write_file",
        path: "result.txt",
        content: "ok",
        expectedHash: null,
      },
    },
    { kind: "finish", summary: "done" },
  ]);
  try {
    let count = 0;
    let second: { taskId: string; id: string; digest: string } | undefined;
    exact.runtime.events.on("event", (event) => {
      if (event.type !== "approval_requested") return;
      const a = event.data.approval as { id: string; digest: string };
      count += 1;
      if (count === 1)
        exact.runtime.decideApproval(event.taskId, {
          approvalId: a.id,
          digest: a.digest,
          decision: "approve",
          scope: "task",
        });
      else second = { taskId: event.taskId, id: a.id, digest: a.digest };
    });
    const task = exact.runtime.create(request());
    const approval = await waitFor(() => second, "second resource approval");
    assert.equal(exact.runtime.get(task.id).status, "awaiting_approval");
    exact.runtime.decideApproval(approval.taskId, {
      approvalId: approval.id,
      digest: approval.digest,
      decision: "approve",
    });
    assert.equal((await exact.runtime.wait(task.id)).status, "completed");
  } finally {
    await exact.cleanup();
  }
});

test("recovers from malformed providers using an explicit fallback and bounds context", async () => {
  const f = await fixture(
    [],
    [
      new FixtureProvider([{ nope: true }]),
      new FixtureProvider([{ kind: "finish", summary: "verified" }]),
    ],
  );
  try {
    await writeFile(join(f.root, "result.txt"), "ok");
    const task = f.runtime.create(request());
    assert.equal((await f.runtime.wait(task.id)).status, "completed");
    assert.equal(
      f.runtime.store
        .events(task.id)
        .some((event) => event.type === "provider_error"),
      true,
    );
    const context: ModelContext = {
      objective: "x",
      plan: [],
      observations: Array.from({ length: 100 }, (_, step) => ({
        step,
        error: "z".repeat(1000),
      })),
      verification: [],
      stepsRemaining: 1,
    };
    assert.equal(
      boundedContext(context, 2_000).observations.length <
        context.observations.length,
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("fails repeated actions, max steps, deadlines, and false finish verification", async () => {
  const repeated = await fixture(
    Array.from({ length: 4 }, () => ({
      kind: "act",
      reason: "read",
      plan: ["read"],
      call: { tool: "read_file", path: "result.txt" },
    })),
  );
  try {
    await writeFile(join(repeated.root, "result.txt"), "ok");
    const task = repeated.runtime.create(request());
    assert.equal((await repeated.runtime.wait(task.id)).status, "failed");
    assert.match(repeated.runtime.get(task.id).error ?? "", /Repeated/i);
  } finally {
    await repeated.cleanup();
  }

  const maxSteps = await fixture([
    {
      kind: "act",
      reason: "read",
      plan: ["read"],
      call: { tool: "read_file", path: "result.txt" },
    },
  ]);
  try {
    await writeFile(join(maxSteps.root, "result.txt"), "ok");
    const task = maxSteps.runtime.create(
      request(undefined, {}, { maxSteps: 1 }),
    );
    assert.equal((await maxSteps.runtime.wait(task.id)).status, "failed");
    assert.match(maxSteps.runtime.get(task.id).error ?? "", /Maximum/i);
  } finally {
    await maxSteps.cleanup();
  }

  const deadlineProvider: Provider = {
    name: "ignores abort",
    decide: async () => new Promise(() => undefined),
  };
  const deadline = await fixture([], [deadlineProvider]);
  try {
    const task = deadline.runtime.create(
      request(undefined, {}, { timeoutMs: 100, maxErrors: 1 }),
    );
    assert.equal((await deadline.runtime.wait(task.id)).status, "failed");
  } finally {
    await deadline.cleanup();
  }

  const falseFinish = await fixture([
    { kind: "finish", summary: "not actually done" },
  ]);
  try {
    const task = falseFinish.runtime.create(
      request(
        [{ kind: "file_contains", path: "missing.txt", text: "ok" }],
        {},
        { maxErrors: 1 },
      ),
    );
    assert.equal((await falseFinish.runtime.wait(task.id)).status, "failed");
  } finally {
    await falseFinish.cleanup();
  }
});

test("retains failed shell observations, repairs the task, and pauses between actions", async () => {
  const f = await fixture([
    {
      kind: "act",
      reason: "observe failed command",
      plan: ["check"],
      call: {
        tool: "shell",
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        cwd: ".",
        timeoutMs: 1_000,
      },
    },
    {
      kind: "act",
      reason: "repair",
      plan: ["repair"],
      call: {
        tool: "write_file",
        path: "result.txt",
        content: "ok",
        expectedHash: null,
      },
    },
    { kind: "finish", summary: "repaired" },
  ]);
  try {
    let paused = false;
    f.runtime.events.on("event", (event) => {
      if (event.type === "approval_requested") {
        const a = event.data.approval as { id: string; digest: string };
        f.runtime.decideApproval(event.taskId, {
          approvalId: a.id,
          digest: a.digest,
          decision: "approve",
        });
      }
      if (event.type === "tool_result" && !paused) {
        paused = true;
        f.runtime.pause(event.taskId);
      }
    });
    const task = f.runtime.create(request());
    await waitFor(
      () => (f.runtime.get(task.id).status === "paused" ? true : undefined),
      "pause",
    );
    assert.equal(
      (f.runtime.get(task.id).observations[0].result as { exitCode: number })
        .exitCode,
      3,
    );
    f.runtime.resume(task.id);
    assert.equal((await f.runtime.wait(task.id)).status, "completed");
  } finally {
    await f.cleanup();
  }
});

test("cancellation wins over noncooperative providers and running shell commands", async () => {
  const noncooperative: Provider = {
    name: "noncooperative",
    decide: async () => new Promise(() => undefined),
  };
  const f = await fixture([], [noncooperative]);
  try {
    const task = f.runtime.create(request());
    await waitFor(
      () => (f.runtime.get(task.id).status === "running" ? true : undefined),
      "running task",
    );
    f.runtime.cancel(task.id);
    assert.equal((await f.runtime.wait(task.id)).status, "canceled");
  } finally {
    await f.cleanup();
  }

  const shell = await fixture([
    {
      kind: "act",
      reason: "wait",
      plan: ["wait"],
      call: {
        tool: "shell",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: ".",
        timeoutMs: 5_000,
      },
    },
  ]);
  try {
    shell.runtime.events.on("event", (event) => {
      if (event.type === "approval_requested") {
        const a = event.data.approval as { id: string; digest: string };
        shell.runtime.decideApproval(event.taskId, {
          approvalId: a.id,
          digest: a.digest,
          decision: "approve",
        });
      }
    });
    const task = shell.runtime.create(request());
    await waitFor(
      () =>
        shell.runtime.store
          .events(task.id)
          .some((event) => event.type === "tool_started")
          ? true
          : undefined,
      "shell start",
    );
    shell.runtime.cancel(task.id);
    assert.equal((await shell.runtime.wait(task.id)).status, "canceled");
  } finally {
    await shell.cleanup();
  }
});

test("refuses concurrent creation while command cleanup is still active", async () => {
  const f = await fixture([
    {
      kind: "act",
      reason: "wait",
      plan: ["wait"],
      call: {
        tool: "shell",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: ".",
        timeoutMs: 5_000,
      },
    },
  ]);
  try {
    f.runtime.events.on("event", (event) => {
      if (event.type === "approval_requested") {
        const a = event.data.approval as { id: string; digest: string };
        f.runtime.decideApproval(event.taskId, {
          approvalId: a.id,
          digest: a.digest,
          decision: "approve",
        });
      }
    });
    const task = f.runtime.create(request());
    await waitFor(
      () =>
        f.runtime.store
          .events(task.id)
          .some((event) => event.type === "tool_started")
          ? true
          : undefined,
      "running command",
    );
    f.runtime.cancel(task.id);
    assert.throws(() => f.runtime.create(request()), /cleanup|busy/i);
    await f.runtime.wait(task.id);
  } finally {
    await f.cleanup();
  }
});

test("store interrupts active tasks on restart, redacts audits, and fails closed on corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-store-"));
  try {
    const store = new TaskStore(directory);
    assert.throws(() => new TaskStore(directory), /locked/);
    const task = {
      ...request(),
      id: "task-active",
      status: "running",
      plan: [],
      steps: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deadline: Date.now() + 10_000,
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
    } as Task;
    store.save(task, "audit", {
      authorization: "Bearer very-secret-token-value",
      nested: { apiKey: "private" },
    });
    assert.deepEqual(store.events(task.id).at(-1)?.data, {
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]" },
    });
    store.close();
    const restarted = new TaskStore(directory);
    assert.equal(restarted.list()[0].status, "interrupted");
    restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const corrupt = await mkdtemp(join(tmpdir(), "agent-corrupt-"));
  try {
    const db = new DatabaseSync(join(corrupt, "runtime.db"));
    db.exec(
      "CREATE TABLE tasks(id TEXT PRIMARY KEY, body TEXT NOT NULL); INSERT INTO tasks VALUES('bad', '{not json}');",
    );
    db.close();
    assert.throws(() => new TaskStore(corrupt));
  } finally {
    await rm(corrupt, { recursive: true, force: true });
  }
});

test("rejects unknown tool schemas and malformed decisions", () => {
  assert.equal(
    ToolCallSchema.safeParse({ tool: "http", url: "https://example.test" })
      .success,
    false,
  );
  assert.equal(
    DecisionSchema.safeParse({
      kind: "act",
      reason: "bad",
      plan: [],
      call: { tool: "unknown" },
    }).success,
    false,
  );
});

test("pending approval expires with task deadline without side effects", async () => {
  const f = await fixture([
    {
      kind: "act",
      reason: "write",
      plan: [],
      call: {
        tool: "write_file",
        path: "result.txt",
        content: "ok",
        expectedHash: null,
      },
    },
  ]);
  try {
    const task = f.runtime.create(request(undefined, {}, { timeoutMs: 100 }));
    const done = await f.runtime.wait(task.id);
    assert.equal(done.status, "failed");
    assert.equal(done.approval, undefined);
    await assert.rejects(readFile(join(f.root, "result.txt"), "utf8"));
    assert.ok(done.observations.some((observation) => observation.error));
  } finally {
    await f.cleanup();
  }
});

test("cancellation after a file effect retains its checkpoint and canceled state", async () => {
  const f = await fixture([
    {
      kind: "act",
      reason: "write",
      plan: [],
      call: {
        tool: "write_file",
        path: "result.txt",
        content: "ok",
        expectedHash: null,
      },
    },
  ]);
  try {
    const execute = f.runtime.tools.execute.bind(f.runtime.tools);
    let id = "";
    f.runtime.tools.execute = async (call, signal) => {
      const result = await execute(call, signal);
      f.runtime.cancel(id);
      return result;
    };
    const task = f.runtime.create(
      request(undefined, { write_file: "allow_task" }),
    );
    id = task.id;
    const done = await f.runtime.wait(id);
    assert.equal(done.status, "canceled");
    assert.equal(done.checkpoints.length, 1);
    assert.equal(await readFile(join(f.root, "result.txt"), "utf8"), "ok");
  } finally {
    await f.cleanup();
  }
});
