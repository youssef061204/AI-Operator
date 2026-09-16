import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ExecutionRequest {
  workspace: string;
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
}
export interface ExecutionResult {
  [key: string]: unknown;
  backend: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}
export interface ExecutionBackend {
  readonly name: string;
  run(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
}

export function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "TEMP",
    "TMP",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

/** Broker-owned process runner: bounded capture and cleanup before settlement. */
export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
    env?: NodeJS.ProcessEnv;
  },
): Promise<Omit<ExecutionResult, "backend">> {
  options.signal.throwIfAborted();
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? minimalEnvironment(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const out = { chunks: [] as Buffer[], size: 0, truncated: false };
    const err = { chunks: [] as Buffer[], size: 0, truncated: false };
    const collect = (target: typeof out, chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      const remaining = Math.max(0, 65536 - target.size);
      if (bytes.length > remaining) target.truncated = true;
      target.chunks.push(bytes.subarray(0, remaining));
      target.size += Math.min(remaining, bytes.length);
      if (!remaining) target.chunks.pop();
    };
    child.stdout.on("data", (chunk) => collect(out, chunk));
    child.stderr.on("data", (chunk) => collect(err, chunk));
    let reason: Error | undefined;
    let cleanup: Promise<void> = Promise.resolve();
    const stop = (error: Error) => {
      if (reason) return;
      reason = error;
      if (!child.pid) return;
      if (process.platform === "win32") {
        cleanup = new Promise<void>((done) => {
          const killer = spawn(
            path.join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.once("error", () => {
            child.kill("SIGKILL");
            done();
          });
          killer.once("close", () => done());
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const aborted = () =>
      stop(new DOMException("Execution canceled", "AbortError"));
    const timer = setTimeout(
      () => stop(new Error(`Execution timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    options.signal.addEventListener("abort", aborted, { once: true });
    if (options.signal.aborted) aborted();
    const clean = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", aborted);
    };
    child.once("error", (error) => {
      clean();
      reject(error);
    });
    child.once("close", async (exitCode) => {
      clean();
      await cleanup;
      if (reason) {
        reject(reason);
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(out.chunks).toString("utf8"),
        stderr: Buffer.concat(err.chunks).toString("utf8"),
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        durationMs: performance.now() - start,
      });
    });
  });
}

export class NativeExecutionBackend implements ExecutionBackend {
  readonly name = "native (host privileges)";
  async run(
    request: ExecutionRequest,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    return {
      ...(await runProcess(request.command, request.args, {
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        signal,
      })),
      backend: this.name,
    } as ExecutionResult;
  }
}

export interface DockerOptions {
  image?: string;
  cpus?: number;
  memoryMb?: number;
  network?: boolean;
  dockerCommand?: string;
}
export class DockerExecutionBackend implements ExecutionBackend {
  readonly name = "docker";
  readonly image: string;
  private readonly cpus: number;
  private readonly memoryMb: number;
  private readonly network: boolean;
  private readonly dockerCommand: string;
  constructor(options: DockerOptions = {}) {
    this.image = options.image ?? "node:24.13.0-bookworm-slim";
    this.cpus = options.cpus ?? 1;
    this.memoryMb = options.memoryMb ?? 512;
    this.network = options.network ?? false;
    this.dockerCommand = options.dockerCommand ?? "docker";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/.test(this.image))
      throw new Error("Invalid Docker image");
    if (
      !(
        this.cpus > 0 &&
        this.cpus <= 8 &&
        this.memoryMb >= 64 &&
        this.memoryMb <= 8192
      )
    )
      throw new Error("Invalid Docker resource limits");
  }
  async run(
    request: ExecutionRequest,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    signal.throwIfAborted();
    const workspace = fs.realpathSync(request.workspace);
    const cwd = fs.realpathSync(request.cwd);
    const rel = path.relative(workspace, cwd);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
      throw new Error("Execution cwd escapes workspace");
    if (workspace.includes(",") || /[\r\n]/.test(workspace))
      throw new Error("Workspace path cannot contain Docker mount delimiters");
    if (
      !request.command ||
      request.command.startsWith("-") ||
      request.command.includes("\0")
    )
      throw new Error("Invalid executable");
    const name = `ai-operator-${randomUUID()}`;
    const argv = [
      "run",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--init",
      "--cpus",
      String(this.cpus),
      "--memory",
      `${this.memoryMb}m`,
      "--memory-swap",
      `${this.memoryMb}m`,
      "--pids-limit",
      "128",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--user",
      "1000:1000",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--network",
      this.network ? "bridge" : "none",
      "--mount",
      `type=bind,source=${workspace},target=/workspace`,
      "--workdir",
      `/workspace${rel ? `/${rel.split(path.sep).join("/")}` : ""}`,
      "--env",
      "HOME=/tmp",
      "--entrypoint",
      request.command,
      this.image,
      ...request.args,
    ];
    let result: ExecutionResult | undefined;
    let executionError: unknown;
    try {
      result = {
        ...(await runProcess(this.dockerCommand, argv, {
          cwd: workspace,
          timeoutMs: request.timeoutMs,
          signal,
        })),
        backend: this.name,
      } as ExecutionResult;
    } catch (error) {
      executionError = error;
    }
    // Cancellation of Docker CLI alone does not stop its container. Use a fresh signal.
    const removed = await runProcess(
      this.dockerCommand,
      ["rm", "--force", name],
      {
        cwd: workspace,
        timeoutMs: 15000,
        signal: new AbortController().signal,
      },
    );
    if (
      removed.exitCode !== 0 &&
      !/No such container/i.test(String(removed.stderr))
    )
      throw new Error(`Container cleanup could not be confirmed: ${name}`);
    if (executionError) throw executionError;
    return result!;
  }
}
