import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalog, type CodingTask } from "./catalog.js";
import { AgentRuntime } from "../packages/agent/src/runtime/runtime.js";
import { TaskStore } from "../packages/agent/src/runtime/store.js";
import { GeminiProvider } from "../packages/agent/src/runtime/providers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.GEMINI_API_KEY) {
  try {
    process.loadEnvFile(path.join(root, ".env"));
  } catch {
    // The provider reports a clear missing-key error when no local env exists.
  }
}
const argv = new Set(process.argv.slice(2));
const value = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const limit = Math.max(
  1,
  Math.min(catalog.length, Number(value("--limit") ?? catalog.length)),
);
const model =
  value("--model") ?? process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

async function processResult(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30000,
): Promise<{ ok: boolean; stdout: string; stderr: string; elapsedMs: number }> {
  const started = performance.now();
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        PATHEXT: process.env.PATHEXT,
      },
    });
    let stdout = "",
      stderr = "",
      done = false;
    const timer = setTimeout(() => {
      if (!done) child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (x) => (stdout = (stdout + x).slice(-65536)));
    child.stderr.on("data", (x) => (stderr = (stderr + x).slice(-65536)));
    child.on("error", (e) => {
      done = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr: String(e),
        elapsedMs: performance.now() - started,
      });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        elapsedMs: performance.now() - started,
      });
    });
  });
}

async function writeFixture(
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function trustedGrade(
  task: CodingTask,
  directory: string,
): Promise<boolean> {
  if (task.language === "typescript") {
    await writeFile(path.join(directory, "contract.ts"), task.grader, "utf8");
    await writeFile(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: true,
        },
        include: ["*.ts"],
      }),
      "utf8",
    );
    return (
      await processResult(
        process.execPath,
        [
          path.join(root, "node_modules/typescript/bin/tsc"),
          "-p",
          "tsconfig.json",
        ],
        directory,
      )
    ).ok;
  }
  const script = `const assert=require('node:assert/strict');const candidate=n=>require(require('node:path').join(process.cwd(),n));const m=candidate('index.cjs');(async()=>{${task.grader}\nconsole.log('AI_OPERATOR_GRADE_PASS')})().catch(e=>{console.error(e);process.exitCode=1});`;
  await writeFile(path.join(directory, "grade.cjs"), script, "utf8");
  const result = await processResult(
    process.execPath,
    ["grade.cjs"],
    directory,
  );
  return result.ok && result.stdout.includes("AI_OPERATOR_GRADE_PASS");
}

async function dockerGrade(
  task: CodingTask,
  directory: string,
): Promise<boolean> {
  const grader = await mkdtemp(path.join(os.tmpdir(), "ai-operator-grader-"));
  try {
    if (task.language === "typescript") {
      await writeFile(path.join(grader, "contract.ts"), task.grader, "utf8");
      await writeFile(
        path.join(grader, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            skipLibCheck: true,
          },
          files: ["/candidate/index.ts", "/grader/contract.ts"],
        }),
        "utf8",
      );
    } else {
      await writeFile(
        path.join(grader, "grade.cjs"),
        `const assert=require('node:assert/strict');const candidate=n=>require('/candidate/'+n);const m=candidate('index.cjs');(async()=>{${task.grader}\nconsole.log('AI_OPERATOR_GRADE_PASS')})().catch(e=>{console.error(e);process.exitCode=1});`,
        "utf8",
      );
    }
    const mounts = [
      "--mount",
      `type=bind,source=${directory},target=/candidate,readonly`,
      "--mount",
      `type=bind,source=${grader},target=/grader,readonly`,
    ];
    let entry = [
      "--entrypoint",
      "node",
      "node:24.13.0-bookworm-slim",
      "/grader/grade.cjs",
    ];
    if (task.language === "typescript") {
      mounts.push(
        "--mount",
        `type=bind,source=${path.join(root, "node_modules/typescript")},target=/typescript,readonly`,
      );
      entry = [
        "--entrypoint",
        "node",
        "node:24.13.0-bookworm-slim",
        "/typescript/bin/tsc",
        "-p",
        "/grader/tsconfig.json",
      ];
    }
    const result = await processResult(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "256m",
        "--cpus",
        "1",
        ...mounts,
        ...entry,
      ],
      root,
      30000,
    );
    return (
      result.ok &&
      (task.language === "typescript" ||
        result.stdout.includes("AI_OPERATOR_GRADE_PASS"))
    );
  } finally {
    await rm(grader, { recursive: true, force: true });
  }
}

async function integrity(): Promise<void> {
  const results = [];
  for (const task of catalog) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "ai-operator-integrity-"),
    );
    try {
      await writeFixture(directory, task.files);
      const baseline = await trustedGrade(task, directory);
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      await writeFixture(directory, task.solution);
      const reference = await trustedGrade(task, directory);
      results.push({
        id: task.id,
        baselineRejected: !baseline,
        referenceAccepted: reference,
        valid: !baseline && reference,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const output = {
    kind: "benchmark-integrity",
    generatedAt: new Date().toISOString(),
    tasks: catalog.length,
    valid: results.filter((x) => x.valid).length,
    results,
  };
  await mkdir(path.join(root, "artifacts/evaluation"), { recursive: true });
  await writeFile(
    path.join(root, "artifacts/evaluation/benchmark-integrity.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(
    `Benchmark integrity: ${output.valid}/${output.tasks} tasks reject baseline and accept reference`,
  );
  if (output.valid !== output.tasks) process.exitCode = 1;
}

async function live(): Promise<void> {
  const results = [];
  for (const task of catalog.slice(0, limit)) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "ai-operator-live-"),
    );
    const data = await mkdtemp(path.join(os.tmpdir(), "ai-operator-data-"));
    try {
      await writeFixture(directory, task.files);
      const provider = new GeminiProvider(
        model,
        process.env.GEMINI_API_KEY ?? "",
        process.env.GEMINI_API_URL,
      );
      const store = new TaskStore(data);
      const runtime = new AgentRuntime(store, directory, [provider], {
        isolate: false,
      });
      const started = performance.now();
      const created = runtime.create({
        objective: task.objective,
        verification: [
          { kind: "file_contains", path: task.editable[0], text: "" },
        ],
        limits: { maxSteps: 12, timeoutMs: 180000, maxErrors: 3 },
        policy: {
          write_file: "allow_task",
          patch_file: "allow_task",
          shell: "deny",
        },
      });
      const completed = await runtime.wait(created.id);
      await runtime.close();
      const passed = await dockerGrade(task, directory);
      results.push({
        id: task.id,
        category: task.category,
        difficulty: task.difficulty,
        passed,
        agentStatus: completed.status,
        elapsedMs: performance.now() - started,
        metrics: completed.metrics,
        steps: completed.steps,
        error: completed.error,
        modelHistory: completed.modelHistory ?? [],
        providerStats: provider.stats(),
        permissionDenials: completed.observations.filter((observation) =>
          /denied|policy/iu.test(String(observation.error ?? "")),
        ).length,
        filesModified: passed ? task.editable.length : null,
      });
    } catch (error) {
      results.push({
        id: task.id,
        category: task.category,
        difficulty: task.difficulty,
        passed: false,
        error: String(error),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  }
  const times = results
    .map((x: any) => x.elapsedMs)
    .filter(Number.isFinite)
    .sort((a: number, b: number) => a - b);
  const percentile = (values: number[], fraction: number) =>
    values.length
      ? values[
          Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
        ]
      : null;
  const groups = (field: "category" | "difficulty") =>
    Object.fromEntries(
      [...new Set(results.map((result: any) => result[field]))]
        .filter(Boolean)
        .sort()
        .map((name) => {
          const subset = results.filter(
            (result: any) => result[field] === name,
          );
          const passed = subset.filter((result: any) => result.passed).length;
          return [
            name,
            {
              attempted: subset.length,
              passed,
              failed: subset.length - passed,
              successRate: passed / subset.length,
            },
          ];
        }),
    );
  const histories = results.flatMap((result: any) => result.modelHistory ?? []);
  const successfulCalls = histories.filter(
    (call: any) => call.status === "success",
  );
  const inputTokens = successfulCalls.reduce(
    (sum: number, call: any) => sum + (call.inputTokens ?? 0),
    0,
  );
  const outputTokens = successfulCalls.reduce(
    (sum: number, call: any) => sum + (call.outputTokens ?? 0),
    0,
  );
  const estimatedCostUsd = successfulCalls.reduce(
    (sum: number, call: any) => sum + (call.estimatedCostUsd ?? 0),
    0,
  );
  const attempted = results.length;
  const passed = results.filter((result: any) => result.passed).length;
  const modelCalls = results.reduce(
    (sum: number, result: any) => sum + (result.metrics?.modelCalls ?? 0),
    0,
  );
  const schemaValidFirstAttempt = results.reduce(
    (sum: number, result: any) =>
      sum + (result.metrics?.schemaValidFirstAttempt ?? 0),
    0,
  );
  const provider = results.reduce(
    (totals: any, result: any) => {
      for (const key of Object.keys(totals))
        totals[key] += result.providerStats?.[key] ?? 0;
      return totals;
    },
    {
      requests: 0,
      retries: 0,
      rateLimited: 0,
      serverErrors: 0,
      persistentFailures: 0,
    },
  );
  const failureBreakdown = {
    graderFailures: results.filter((result: any) => !result.passed).length,
    completedButGraderFailed: results.filter(
      (result: any) => !result.passed && result.agentStatus === "completed",
    ).length,
    failedAgentRuns: results.filter(
      (result: any) => result.agentStatus === "failed",
    ).length,
    providerFailures: histories.filter(
      (call: any) =>
        call.status === "error" &&
        /Gemini HTTP|fetch failed/iu.test(call.error ?? ""),
    ).length,
    timeouts: results.filter((result: any) =>
      /deadline|timed out|timeout/iu.test(result.error ?? ""),
    ).length,
    stepLimitFailures: results.filter((result: any) =>
      /step/iu.test(result.error ?? ""),
    ).length,
    repeatedActionFailures: results.filter((result: any) =>
      /repeat/iu.test(result.error ?? ""),
    ).length,
    schemaFailures: results.reduce(
      (sum: number, result: any) => sum + (result.metrics?.schemaFailures ?? 0),
      0,
    ),
    invalidResponseCalls: histories.filter((call: any) =>
      /Invalid or truncated/iu.test(call.error ?? ""),
    ).length,
    tasksWithInvalidResponses: results.filter((result: any) =>
      /Invalid or truncated/iu.test(result.error ?? ""),
    ).length,
    policyDeniedTasks: results.filter((result: any) =>
      /Policy denies/iu.test(result.error ?? ""),
    ).length,
  };
  const output = {
    kind: "live-coding-benchmark",
    generatedAt: new Date().toISOString(),
    provider: "gemini",
    model,
    attempted,
    passed,
    failed: attempted - passed,
    successRate: passed / attempted,
    successByCategory: groups("category"),
    successByDifficulty: groups("difficulty"),
    failureBreakdown,
    schema: {
      modelCalls,
      validFirstAttempt: schemaValidFirstAttempt,
      validFirstAttemptRate: modelCalls
        ? schemaValidFirstAttempt / modelCalls
        : null,
    },
    latencyMs: {
      median: percentile(times, 0.5),
      p95: percentile(times, 0.95),
    },
    averageSteps:
      results.reduce(
        (sum: number, result: any) => sum + (result.steps ?? 0),
        0,
      ) / attempted,
    tokens: {
      totalInput: inputTokens,
      totalOutput: outputTokens,
      averageInputPerTask: inputTokens / attempted,
      averageOutputPerTask: outputTokens / attempted,
    },
    costUsd: {
      estimatedTotal: estimatedCostUsd,
      perAttemptedTask: estimatedCostUsd / attempted,
      perSuccessfulTask: passed ? estimatedCostUsd / passed : null,
    },
    providerTelemetry: provider,
    permissionViolations: results.reduce(
      (sum: number, result: any) => sum + (result.permissionDenials ?? 0),
      0,
    ),
    results,
  };
  await mkdir(path.join(root, "artifacts/evaluation"), { recursive: true });
  await writeFile(
    path.join(root, "artifacts/evaluation/live-benchmark.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify(output, null, 2));
}

if (argv.has("--integrity")) await integrity();
else await live();
