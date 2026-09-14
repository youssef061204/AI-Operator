// Safe observation of retained legacy code, using in-memory state and dry-run adapters only.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "operator-baseline-"));
process.env.AGENT_DATA_DIR = path.join(temp, "data");
process.env.AGENT_WORKSPACE_ROOT = temp;
process.env.OPERATOR_AGENT_EMBEDDED = "1";
const { ActionEngine } = await import("../src/engine.js");
const { DEFAULT_SETTINGS } = await import("../src/config.js");
const actions: unknown[] = [];
const storage = {
  getSettings: () => ({
    ...DEFAULT_SETTINGS,
    approval_mode: true,
    dry_run_mode: true,
    autonomous_runtime: false,
  }),
  listActions: () => [],
  upsertAction: (a: unknown) => actions.push(structuredClone(a)),
};
const logs = { emitLog: () => {}, emitQueueSnapshot: () => {} };
const engine = new ActionEngine(storage as never, logs as never);
const now = new Date().toISOString();
const action = {
  id: "baseline-safe-dry-run",
  run_id: "baseline",
  type: "CREATE_BUSINESS_FOLDER" as const,
  description: "Dry-run only",
  risk_level: "HIGH" as const,
  required_permissions: [],
  inputs: { workspace_root: temp },
  state: "QUEUED" as const,
  created_at: now,
  updated_at: now,
};
try {
  engine.pushActions([action]);
  const stateBeforeKill = engine.getAction(action.id)?.state;
  await engine.killNow();
  const stateImmediatelyAfterKill = engine.getAction(action.id)?.state;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const stateAfterAdapterReturns = engine.getAction(action.id)?.state;
  const result = {
    generatedAt: new Date().toISOString(),
    mode: "legacy engine with in-memory storage and dry-run adapter; no OS/network actions",
    approvalMode: true,
    callerPermissions: [],
    stateBeforeKill,
    stateImmediatelyAfterKill,
    stateAfterAdapterReturns,
    approvalBypassObserved: stateBeforeKill === "RUNNING",
    cancellationOverwriteObserved:
      stateImmediatelyAfterKill === "CANCELED" &&
      stateAfterAdapterReturns === "SUCCESS",
  };
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  await fs.writeFile(
    path.join(repo, "artifacts/baseline/behavior.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
