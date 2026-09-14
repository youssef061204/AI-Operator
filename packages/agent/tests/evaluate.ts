import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../src/runtime/runtime.js";
import { TaskStore } from "../src/runtime/store.js";
import { FixtureProvider } from "../src/runtime/providers.js";
import { hash } from "../src/runtime/tools.js";
import type { Task, TaskEvent } from "../src/runtime/contracts.js";

const act = (call: unknown) => ({
  kind: "act",
  reason: "Execute the fixture task step",
  plan: ["Inspect", "Change if needed", "Verify"],
  call,
});
const finish = { kind: "finish", summary: "Fixture criteria satisfied" };
const readme = { kind: "file_contains", path: "README.md", text: "fixture" };
type Scenario = {
  name: string;
  category: string;
  decisions: unknown[];
  verification?: unknown[];
  deny?: boolean;
  stale?: boolean;
  cancel?: boolean;
  fallback?: boolean;
  expected: Task["status"];
  check?: (root: string, task: Task, runtime: AgentRuntime) => Promise<void>;
};
const scenarios: Scenario[] = [
  {
    name: "repository-search",
    category: "understanding",
    decisions: [
      act({ tool: "search", query: "add", path: "." }),
      act({ tool: "read_file", path: "math.cjs" }),
      finish,
    ],
    expected: "completed",
    check: async (_r, t) =>
      assert.ok(
        t.observations.some(
          (o) =>
            o.call?.tool === "search" &&
            JSON.stringify(o.result).includes("math.cjs"),
        ),
      ),
  },
  {
    name: "hash-guarded-code-edit",
    category: "editing",
    decisions: [
      act({ tool: "read_file", path: "math.cjs" }),
      act({
        tool: "patch_file",
        path: "math.cjs",
        oldText: "a-b",
        newText: "a+b",
        expectedHash: hash("exports.add=(a,b)=>a-b;"),
      }),
      finish,
    ],
    verification: [{ kind: "file_contains", path: "math.cjs", text: "a+b" }],
    expected: "completed",
  },
  {
    name: "debug-failing-test",
    category: "debugging",
    decisions: [
      act({
        tool: "shell",
        command: process.execPath,
        args: ["test.cjs"],
        cwd: ".",
        timeoutMs: 30000,
      }),
      act({ tool: "read_file", path: "math.cjs" }),
      act({
        tool: "patch_file",
        path: "math.cjs",
        oldText: "a-b",
        newText: "a+b",
        expectedHash: hash("exports.add=(a,b)=>a-b;"),
      }),
      finish,
    ],
    verification: [
      {
        kind: "command",
        command: process.execPath,
        args: ["test.cjs"],
        cwd: ".",
      },
    ],
    expected: "completed",
    check: async (_r, t) => assert.ok(t.metrics.toolErrors >= 1),
  },
  {
    name: "missing-file-recovery",
    category: "reliability",
    decisions: [
      act({ tool: "read_file", path: "missing.txt" }),
      act({ tool: "read_file", path: "README.md" }),
      finish,
    ],
    expected: "completed",
  },
  {
    name: "timeout-recovery",
    category: "reliability",
    decisions: [
      act({
        tool: "shell",
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: ".",
        timeoutMs: 50,
      }),
      finish,
    ],
    expected: "completed",
    check: async (_r, t) => assert.equal(t.metrics.toolErrors, 1),
  },
  {
    name: "approval-denied-no-write",
    category: "safety",
    decisions: [
      act({
        tool: "write_file",
        path: "denied.txt",
        content: "should not exist",
        expectedHash: null,
      }),
    ],
    deny: true,
    expected: "failed",
    check: async (root) =>
      assert.rejects(fs.access(path.join(root, "denied.txt"))),
  },
  {
    name: "stale-approval-rejected",
    category: "safety",
    decisions: [
      act({
        tool: "write_file",
        path: "approved.txt",
        content: "approved",
        expectedHash: null,
      }),
      finish,
    ],
    stale: true,
    expected: "completed",
  },
  {
    name: "workspace-escape-rejected",
    category: "safety",
    decisions: [
      act({
        tool: "write_file",
        path: "../escape.txt",
        content: "unsafe",
        expectedHash: null,
      }),
      finish,
    ],
    expected: "completed",
    check: async (root) =>
      assert.rejects(fs.access(path.join(root, "..", "escape.txt"))),
  },
  {
    name: "malformed-model-recovery",
    category: "recovery",
    decisions: [{ kind: "act", call: { tool: "unknown" } }, finish],
    expected: "completed",
  },
  {
    name: "provider-fallback",
    category: "recovery",
    decisions: [finish],
    fallback: true,
    expected: "completed",
  },
  {
    name: "cancel-inflight-command",
    category: "recovery",
    decisions: [
      act({
        tool: "shell",
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: ".",
        timeoutMs: 30000,
      }),
    ],
    cancel: true,
    expected: "canceled",
  },
  {
    name: "checkpoint-restore",
    category: "checkpoints",
    decisions: [
      act({
        tool: "write_file",
        path: "README.md",
        content: "fixture changed",
        expectedHash: hash("fixture repository"),
      }),
      finish,
    ],
    expected: "completed",
    check: async (root, t, runtime) => {
      const restore = runtime.restore(t.id, t.checkpoints[0]);
      const done = await runtime.wait(restore.id);
      assert.equal(done.status, "completed");
      assert.equal(
        await fs.readFile(path.join(root, "README.md"), "utf8"),
        "fixture repository",
      );
    },
  },
  {
    name: "false-completion-refused",
    category: "verification",
    decisions: [finish, finish, finish],
    verification: [{ kind: "file_contains", path: "math.cjs", text: "a+b" }],
    expected: "failed",
  },
  {
    name: "repeated-actions-stop",
    category: "limits",
    decisions: Array.from({ length: 5 }, () =>
      act({ tool: "read_file", path: "README.md" }),
    ),
    expected: "failed",
  },
];
const results: Array<Record<string, unknown>> = [];
const repeats = Number(process.env.EVALUATION_REPEATS ?? 3);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20)
  throw new Error("EVALUATION_REPEATS must be 1..20");
for (let iteration = 0; iteration < repeats; iteration++)
  for (const scenario of scenarios) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "operator-eval-"));
    const root = path.join(dir, "workspace");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "README.md"), "fixture repository");
    await fs.writeFile(path.join(root, "math.cjs"), "exports.add=(a,b)=>a-b;");
    await fs.writeFile(
      path.join(root, "test.cjs"),
      "const assert=require('node:assert/strict');assert.equal(require('./math.cjs').add(2,3),5);",
    );
    const start = performance.now();
    const fixture = new FixtureProvider(scenario.decisions);
    const runtime = new AgentRuntime(
      new TaskStore(path.join(dir, "data")),
      root,
      scenario.fallback
        ? [
            {
              name: "unavailable fixture provider",
              decide: async () => {
                throw new Error("Provider unavailable");
              },
            },
            fixture,
          ]
        : [fixture],
    );
    const startupMs = performance.now() - start;
    let violations = 0;
    let staleRejected = false;
    let cancellationTimer: NodeJS.Timeout | undefined;
    const approved = new Set<string>();
    runtime.events.on("event", (event: TaskEvent) => {
      if (event.type === "approval_requested") {
        const approval = runtime.get(event.taskId).approval!;
        if (scenario.stale && !staleRejected) {
          assert.throws(
            () =>
              runtime.decideApproval(event.taskId, {
                approvalId: approval.id,
                digest: "0".repeat(64),
                decision: "approve",
              }),
            /Stale/,
          );
          staleRejected = true;
        }
        if (!scenario.deny) approved.add(JSON.stringify(approval.call));
        runtime.decideApproval(event.taskId, {
          approvalId: approval.id,
          digest: approval.digest,
          decision: scenario.deny ? "deny" : "approve",
          scope: "once",
        });
      }
      if (event.type === "tool_started") {
        const call = event.data.call as Parameters<
          typeof runtime.tools.describe
        >[0];
        if (
          runtime.tools.describe(call).risk !== "LOW" &&
          !approved.has(JSON.stringify(call))
        )
          violations++;
        if (scenario.cancel && call.tool === "shell")
          cancellationTimer = setTimeout(
            () => runtime.cancel(event.taskId),
            50,
          );
      }
    });
    let task: Task | undefined;
    let error: string | undefined;
    let passed = false;
    try {
      task = runtime.create({
        objective: scenario.name,
        verification: scenario.verification ?? [readme],
        limits: { maxSteps: 12, timeoutMs: 15000, maxErrors: 3 },
      });
      task = await runtime.wait(task.id);
      assert.equal(task.status, scenario.expected);
      assert.equal(violations, 0);
      if (scenario.stale) assert.equal(staleRejected, true);
      await scenario.check?.(root, task, runtime);
      passed = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const elapsedMs = performance.now() - start;
    results.push({
      scenario: scenario.name,
      category: scenario.category,
      iteration,
      passed,
      expectedStatus: scenario.expected,
      actualStatus: task?.status,
      error,
      elapsedMs,
      startupMs,
      steps: task?.steps ?? 0,
      permissionViolations: violations,
      metrics: task?.metrics,
      rollbackCorrect: scenario.category === "checkpoints" ? passed : null,
    });
    if (cancellationTimer) clearTimeout(cancellationTimer);
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
const numeric = (field: string) =>
  results.map((row) => Number(row[field])).sort((a, b) => a - b);
const quantile = (values: number[], p: number) =>
  values[Math.max(0, Math.ceil(values.length * p) - 1)];
const sum = (field: string) =>
  results.reduce((total, row) => total + Number(row[field] ?? 0), 0);
const calls = results.reduce(
  (n, r) => n + Number((r.metrics as Task["metrics"])?.toolCalls ?? 0),
  0,
);
const errors = results.reduce(
  (n, r) => n + Number((r.metrics as Task["metrics"])?.toolErrors ?? 0),
  0,
);
const summary = {
  cases: results.length,
  passed: results.filter((r) => r.passed).length,
  taskCompletionRate:
    results.filter((r) => r.actualStatus === "completed").length /
    results.length,
  safeOutcomeRate:
    results.filter((r) => r.passed && r.permissionViolations === 0).length /
    results.length,
  toolCallErrorRate: calls ? errors / calls : 0,
  averageSteps: sum("steps") / results.length,
  medianTaskMs: quantile(numeric("elapsedMs"), 0.5),
  p95TaskMs: quantile(numeric("elapsedMs"), 0.95),
  medianStartupMs: quantile(numeric("startupMs"), 0.5),
  permissionViolations: sum("permissionViolations"),
  unexpectedFailures: results.filter((r) => !r.passed).length,
  rollbackCorrectness:
    results.filter((r) => r.rollbackCorrect === true).length /
    results.filter((r) => r.rollbackCorrect !== null).length,
  regressionCount: null,
};
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const output = path.join(repo, "artifacts/evaluation");
await fs.mkdir(output, { recursive: true });
const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: "deterministic fixture providers with real filesystem and subprocesses; not LLM quality",
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  repeats,
  summary,
  results,
};
await fs.writeFile(
  path.join(output, "latest.json"),
  JSON.stringify(artifact, null, 2),
);
await fs.writeFile(
  path.join(repo, "docs/evaluation.md"),
  `# Evaluation\n\nGenerated by \`pnpm evaluate\` from [latest.json](../artifacts/evaluation/latest.json) at ${artifact.generatedAt}.\n\nMode: ${artifact.mode}. ${scenarios.length} scenarios repeated ${repeats} times. These are orchestration regressions with scripted model decisions, not autonomous model performance.\n\n| Metric | Measured value |\n|---|---:|\n${Object.entries(
    summary,
  )
    .map(
      ([k, v]) =>
        `| ${k} | ${v === null ? "Not available" : typeof v === "number" ? Number(v.toFixed(4)) : v} |`,
    )
    .join(
      "\n",
    )}\n\nTask completion rate includes deliberately denied, canceled and verification-failed tasks in the denominator. Safe outcome rate measures expected safe behavior, including refusal. Tool errors include injected failures. Rollback correctness asserts restored file contents. Regression count is unavailable because the baseline had no comparable harness. Runtime includes temporary fixture execution and local verification; startup measures runtime/store creation, not UI or model startup. Tokens and cost are not benchmarked with fixtures. No live model, desktop input, browser agent or network quality claims follow from these results.\n`,
);
console.log(JSON.stringify(summary, null, 2));
if (summary.unexpectedFailures) process.exitCode = 1;
