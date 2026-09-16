import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../src/runtime/runtime.js";
import { TaskStore } from "../src/runtime/store.js";
import { GeminiProvider } from "../src/runtime/providers.js";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "operator-live-"));
const root = path.join(dir, "workspace");
await fs.mkdir(root);
await fs.writeFile(path.join(root, "math.cjs"), "exports.add=(a,b)=>a-b;");
await fs.writeFile(
  path.join(root, "test.cjs"),
  "const assert=require('node:assert/strict');assert.equal(require('./math.cjs').add(2,3),5);",
);
const model = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
const runtime = new AgentRuntime(new TaskStore(path.join(dir, "data")), root, [
  new GeminiProvider(
    model,
    process.env.GEMINI_API_KEY ?? "",
    process.env.GEMINI_API_URL,
  ),
]);
runtime.events.on("event", (event) => {
  if (event.type === "approval_requested") {
    const approval = runtime.get(event.taskId).approval!;
    const call = approval.call;
    // Fixture-only authorization: model commands are never automatically approved.
    const allow =
      ((call.tool === "patch_file" || call.tool === "write_file") &&
        call.path === "math.cjs") ||
      (approval.purpose === "verification" &&
        call.tool === "shell" &&
        call.command === process.execPath &&
        JSON.stringify(call.args) === '["test.cjs"]');
    runtime.decideApproval(event.taskId, {
      approvalId: approval.id,
      digest: approval.digest,
      decision: allow ? "approve" : "deny",
    });
  }
  if (["provider_error", "tool_error", "state"].includes(event.type))
    console.log(event.type, JSON.stringify(event.data));
});
const started = performance.now();
try {
  const task = runtime.create({
    objective:
      "Fix the addition bug in math.cjs. Read the file, then patch the subtraction into addition using its hash. Do not run shell commands yourself; the runtime will run the supplied test when you finish.",
    verification: [
      {
        kind: "command",
        command: process.execPath,
        args: ["test.cjs"],
        cwd: ".",
      },
    ],
    limits: { maxSteps: 8, timeoutMs: 180000, maxErrors: 3 },
  });
  const result = await runtime.wait(task.id);
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const output = {
    generatedAt: new Date().toISOString(),
    mode: "live Gemini smoke; one task, not a benchmark",
    model,
    elapsedMs: performance.now() - started,
    status: result.status,
    error: result.error,
    metrics: result.metrics,
    steps: result.steps,
    events: runtime.store.events(task.id),
    finalFile: await fs.readFile(path.join(root, "math.cjs"), "utf8"),
  };
  await fs.mkdir(path.join(repo, "artifacts/evaluation"), { recursive: true });
  await fs.writeFile(
    path.join(repo, "artifacts/evaluation/live-smoke.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        status: result.status,
        metrics: result.metrics,
        steps: result.steps,
        elapsedMs: output.elapsedMs,
      },
      null,
      2,
    ),
  );
  if (result.status !== "completed") process.exitCode = 1;
} finally {
  await runtime.close();
  await fs.rm(dir, { recursive: true, force: true });
}
