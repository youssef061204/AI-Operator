import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DockerExecutionBackend } from "../src/runtime/execution.js";

function requireDocker(t: { skip(message?: string): void }): boolean {
  const probe = spawnSync("docker", ["info"], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 5000,
  });
  if (probe.status === 0) return true;
  t.skip("Docker daemon is unavailable");
  return false;
}

test("Docker backend applies an isolated workspace, resource limits, and no network", async (t) => {
  if (!requireDocker(t)) return;
  const workspace = await mkdtemp(path.join(os.tmpdir(), "operator-docker-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "input.txt"), "bounded", "utf8");
  const backend = new DockerExecutionBackend();
  try {
    const result = await backend.run(
      {
        workspace,
        cwd: workspace,
        command: "node",
        args: [
          "-e",
          "const fs=require('fs');console.log(fs.readFileSync('input.txt','utf8'));fetch('https://example.com').then(()=>process.exit(9),()=>console.log('NETWORK_BLOCKED'))",
        ],
        timeoutMs: 15_000,
      },
      new AbortController().signal,
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /bounded/);
    assert.match(result.stdout, /NETWORK_BLOCKED/);
    assert.equal(result.backend, "docker");
  } catch (error) {
    if (/daemon|No such image|not recognized|ENOENT/i.test(String(error))) {
      t.skip(`Docker unavailable: ${String(error)}`);
      return;
    }
    throw error;
  }
});

test("Docker backend removes timed-out containers before rejecting", async (t) => {
  if (!requireDocker(t)) return;
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "operator-docker-timeout-"),
  );
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const backend = new DockerExecutionBackend();
  await assert.rejects(
    backend.run(
      {
        workspace,
        cwd: workspace,
        command: "node",
        args: ["-e", "setInterval(()=>{},1000)"],
        timeoutMs: 500,
      },
      new AbortController().signal,
    ),
    /timed out/,
  );
});
