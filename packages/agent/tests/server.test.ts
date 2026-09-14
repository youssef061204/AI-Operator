import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FixtureProvider } from "../src/runtime/providers.js";
import { startRuntimeServer } from "../src/runtime/server.js";

async function waitFor<T>(get: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await get();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for server task state");
}

test("authenticated runtime API enforces host/origin, approves tasks, streams events, and shuts down", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-server-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const token = "t".repeat(64);
  const server = await startRuntimeServer({
    workspace,
    dataDir: join(directory, "data"),
    port: 0,
    token,
    providers: [
      new FixtureProvider([
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
        {
          kind: "act",
          reason: "do not write",
          plan: ["write"],
          call: {
            tool: "write_file",
            path: "denied.txt",
            content: "no",
            expectedHash: null,
          },
        },
      ]),
    ],
  });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const taskBody = {
    objective: "Write a verified result",
    verification: [{ kind: "file_contains", path: "result.txt", text: "ok" }],
    limits: { maxSteps: 5, timeoutMs: 5_000, maxErrors: 1 },
    policy: {},
  };
  try {
    assert.equal((await fetch(`${base}/tasks`)).status, 401);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get(
          `${base}/tasks`,
          { headers: { host: "evil.example", ...headers } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        )
        .on("error", reject);
    });
    assert.equal(badHost, 403);
    assert.equal(
      (
        await fetch(`${base}/tasks`, {
          headers: { origin: "https://evil.example", ...headers },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/queue/status`, { headers })).status,
      404,
    );

    const stream = await fetch(`${base}/events`, { headers });
    assert.equal(stream.status, 200);
    const reader = stream.body?.getReader();
    assert.ok(reader);
    const connected = new TextDecoder().decode((await reader.read()).value);
    assert.match(connected, /connected/);

    const created = await fetch(`${base}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify(taskBody),
    });
    assert.equal(created.status, 201);
    const first = ((await created.json()) as { task: { id: string } }).task;
    const awaiting = await waitFor(async () => {
      const response = await fetch(`${base}/tasks/${first.id}`, { headers });
      const body = (await response.json()) as {
        task: { approval?: { id: string; digest: string }; status: string };
      };
      return body.task.status === "awaiting_approval" && body.task.approval
        ? body.task
        : undefined;
    });
    const approved = await fetch(`${base}/tasks/${first.id}/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        approvalId: awaiting.approval!.id,
        digest: awaiting.approval!.digest,
        decision: "approve",
      }),
    });
    assert.equal(approved.status, 200);
    const complete = await waitFor(async () => {
      const body = (await (
        await fetch(`${base}/tasks/${first.id}`, { headers })
      ).json()) as { task: { status: string } };
      return body.task.status === "completed" ? body.task : undefined;
    });
    assert.equal(complete.status, "completed");
    const events = (await (
      await fetch(`${base}/tasks/${first.id}/events`, { headers })
    ).json()) as { events: Array<{ type: string }> };
    assert.equal(
      events.events.some((event) => event.type === "approval_requested"),
      true,
    );

    const deniedCreate = await fetch(`${base}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...taskBody,
        verification: [
          { kind: "file_contains", path: "denied.txt", text: "no" },
        ],
      }),
    });
    const second = ((await deniedCreate.json()) as { task: { id: string } })
      .task;
    const deniedAwaiting = await waitFor(async () => {
      const body = (await (
        await fetch(`${base}/tasks/${second.id}`, { headers })
      ).json()) as {
        task: { approval?: { id: string; digest: string }; status: string };
      };
      return body.task.status === "awaiting_approval" && body.task.approval
        ? body.task
        : undefined;
    });
    const denied = await fetch(`${base}/tasks/${second.id}/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        approvalId: deniedAwaiting.approval!.id,
        digest: deniedAwaiting.approval!.digest,
        decision: "deny",
      }),
    });
    assert.equal(denied.status, 200);
    const failed = await waitFor(async () => {
      const body = (await (
        await fetch(`${base}/tasks/${second.id}`, { headers })
      ).json()) as { task: { status: string } };
      return body.task.status === "failed" ? body.task : undefined;
    });
    assert.equal(failed.status, "failed");
    const liveEvents = new TextDecoder().decode((await reader.read()).value);
    assert.match(liveEvents, /request|state|approval_requested/);
    const cli = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "tasks"],
        {
          env: {
            ...process.env,
            OPERATOR_PORT: String(server.port),
            OPERATOR_API_TOKEN: token,
          },
          windowsHide: true,
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(cli.code, 0, cli.stderr);
    assert.ok(
      JSON.parse(cli.stdout).tasks.some(
        (task: { id: string }) => task.id === first.id,
      ),
    );
    await reader.cancel();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
