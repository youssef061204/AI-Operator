import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AgentRuntime } from "./runtime.js";
import { TaskStore } from "./store.js";
import { GeminiProvider } from "./providers.js";
import type { Provider, TaskEvent } from "./contracts.js";
import {
  DockerExecutionBackend,
  NativeExecutionBackend,
  type ExecutionBackend,
} from "./execution.js";
import { execFile } from "node:child_process";

export interface ServerOptions {
  workspace: string;
  dataDir: string;
  port?: number;
  token?: string;
  providers?: Provider[];
  origins?: string[];
  isolate?: boolean;
  bootstrapCode?: string;
  evaluationDir?: string;
  execution?: ExecutionBackend;
}
export async function startRuntimeServer(options: ServerOptions) {
  fs.mkdirSync(options.dataDir, { recursive: true });
  const tokenPath = path.join(options.dataDir, "api-token");
  let token = options.token;
  if (!token) {
    if (fs.existsSync(tokenPath))
      token = fs.readFileSync(tokenPath, "utf8").trim();
    else {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(tokenPath, token, { flag: "wx", mode: 0o600 });
    }
  }
  if (token.length < 32)
    throw new Error("API token must contain at least 32 characters");
  const providers: Provider[] = options.providers ?? [
    new GeminiProvider(
      process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
      process.env.GEMINI_API_KEY ?? "",
      process.env.GEMINI_API_URL ??
        "https://generativelanguage.googleapis.com/v1beta",
    ),
  ];
  const store = new TaskStore(options.dataDir);
  const sessions = new Map<string, number>();
  let bootstrap = options.bootstrapCode ?? randomBytes(32).toString("hex");
  const bootstrapExpires = Date.now() + 5 * 60_000;
  let runtime: AgentRuntime;
  const execution =
    options.execution ??
    (process.env.OPERATOR_EXECUTION_BACKEND === "native"
      ? new NativeExecutionBackend()
      : new DockerExecutionBackend());
  try {
    runtime = new AgentRuntime(store, options.workspace, providers, {
      isolate: options.isolate !== false,
      execution,
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const app = express();
  app.disable("x-powered-by");
  const server = http.createServer(app);
  const streams = new Set<Response>();
  const origins = new Set(
    options.origins ?? ["http://localhost:3000", "http://127.0.0.1:3000"],
  );
  app.use((req, res, next) => {
    const address = server.address();
    const port =
      typeof address === "object" && address ? address.port : options.port;
    if (
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
        req.headers.host ?? "",
      )
    ) {
      res.status(403).json({ error: "Invalid Host" });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    if (req.method === "GET" && req.path === "/health") {
      next();
      return;
    }
    if (req.method === "POST" && req.path === "/session/bootstrap") {
      if (!origin || !origins.has(origin)) {
        res.status(403).json({ error: "A trusted browser origin is required" });
        return;
      }
      next();
      return;
    }
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    const bearer =
      actual.length === expected.length && timingSafeEqual(actual, expected);
    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("operator_session="))
      ?.slice("operator_session=".length);
    const session = cookie ? sessions.get(cookie) : undefined;
    if (session && session < Date.now()) sessions.delete(cookie!);
    const cookieAuthorized = Boolean(session && session > Date.now());
    // Cookies are ambient credentials: every mutation must have a trusted Origin.
    if (
      !bearer &&
      cookieAuthorized &&
      !["GET", "HEAD"].includes(req.method) &&
      (!origin || !origins.has(origin))
    ) {
      res.status(403).json({ error: "A trusted browser origin is required" });
      return;
    }
    if (!bearer && !cookieAuthorized) {
      res.status(401).json({ error: "Bearer token required" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "256kb", strict: true }));
  app.post("/session/bootstrap", (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const actual = Buffer.from(code);
    const expected = Buffer.from(bootstrap);
    if (
      !bootstrap ||
      Date.now() >= bootstrapExpires ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.status(401).json({
        error:
          "Connection link expired or already used. Restart the launcher for a new link.",
      });
      return;
    }
    bootstrap = "";
    for (const [key, expiry] of sessions)
      if (expiry < Date.now()) sessions.delete(key);
    const session = randomBytes(32).toString("hex");
    sessions.set(session, Date.now() + 8 * 60 * 60_000);
    res.setHeader(
      "Set-Cookie",
      `operator_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
    );
    res.json({ connected: true });
  });
  app.post("/session/logout", (req, res) => {
    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("operator_session="))
      ?.slice("operator_session=".length);
    if (cookie) sessions.delete(cookie);
    res.setHeader(
      "Set-Cookie",
      "operator_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    res.json({ connected: false });
  });
  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      service: "ai-operator",
      provider: providers.map((p) => p.name).join(", "),
    }),
  );
  app.get("/tasks", (_req, res) => res.json({ tasks: runtime.list() }));
  app.get("/metadata", async (_req, res, next) => {
    try {
      const diagnostics: string[] = [];
      if (execution.name === "docker") {
        try {
          await new Promise<void>((resolve, reject) =>
            execFile(
              "docker",
              [
                "image",
                "inspect",
                process.env.OPERATOR_DOCKER_IMAGE ??
                  "node:24.13.0-bookworm-slim",
              ],
              { timeout: 3000, windowsHide: true, maxBuffer: 64_000 },
              (error) => (error ? reject(error) : resolve()),
            ),
          );
        } catch {
          diagnostics.push(
            "Docker or its execution image is unavailable. Start Docker and run: docker pull node:24.13.0-bookworm-slim",
          );
        }
      }
      if (!options.providers && !process.env.GEMINI_API_KEY)
        diagnostics.push(
          "GEMINI_API_KEY is missing. Add a Google AI Studio key to .env or the process environment.",
        );
      res.json({
        workspace: options.workspace,
        models: providers.map((provider) => provider.name),
        backend: execution.name,
        isolated: options.isolate !== false,
        diagnostics,
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/evaluations", (_req, res, next) => {
    try {
      const records: Array<{ name: string; result: unknown }> = [];
      if (options.evaluationDir && fs.existsSync(options.evaluationDir)) {
        for (const name of fs
          .readdirSync(options.evaluationDir)
          .filter((name) => name.endsWith(".json"))
          .slice(0, 30)) {
          const file = path.join(options.evaluationDir, name);
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5_000_000)
            continue;
          try {
            records.push({
              name,
              result: JSON.parse(fs.readFileSync(file, "utf8")),
            });
          } catch {
            /* Incomplete result files are not measurements. */
          }
        }
      }
      res.json({ records });
    } catch (error) {
      next(error);
    }
  });
  app.post("/tasks", (req, res) =>
    res.status(201).json({ task: runtime.create(req.body) }),
  );
  app.get("/tasks/:id", (req, res) =>
    res.json({ task: runtime.get(String(req.params.id)) }),
  );
  app.get("/tasks/:id/changes", async (req, res, next) => {
    try {
      res.json({ changes: await runtime.changes(String(req.params.id)) });
    } catch (error) {
      next(error);
    }
  });
  for (const action of ["accept", "discard", "revert"] as const) {
    app.post(`/tasks/:id/${action}`, async (req, res, next) => {
      try {
        const { digest } = z
          .object({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(req.body);
        res.json({
          changes: await runtime[action](String(req.params.id), digest),
        });
      } catch (error) {
        next(error);
      }
    });
  }
  app.get("/tasks/:id/events", (req, res) => {
    runtime.get(String(req.params.id));
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse(req.query.after);
    res.json({ events: runtime.store.events(String(req.params.id), after) });
  });
  app.post("/tasks/:id/approve", (req, res) => {
    const body = z
      .object({
        approvalId: z.string().uuid(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        decision: z.enum(["approve", "deny"]),
        scope: z.enum(["once", "task"]).default("once"),
      })
      .strict()
      .parse(req.body);
    res.json({ task: runtime.decideApproval(String(req.params.id), body) });
  });
  app.post("/tasks/:id/pause", (req, res) =>
    res.json({ task: runtime.pause(String(req.params.id)) }),
  );
  app.post("/tasks/:id/resume", (req, res) =>
    res.json({ task: runtime.resume(String(req.params.id)) }),
  );
  app.post("/tasks/:id/cancel", (req, res) =>
    res.json({ task: runtime.cancel(String(req.params.id)) }),
  );
  app.post("/tasks/:id/restore", (req, res) => {
    const body = z
      .object({ checkpointId: z.string().uuid() })
      .strict()
      .parse(req.body);
    res.status(201).json({
      task: runtime.restore(String(req.params.id), body.checkpointId),
    });
  });
  app.post("/kill", (_req, res) => {
    const tasks = runtime.list().map((task) => runtime.cancel(task.id));
    res.json({ tasks });
  });
  app.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      Connection: "keep-alive",
    });
    res.write(`${JSON.stringify({ type: "connected" })}\n`);
    streams.add(res);
    const heartbeat = setInterval(() => {
      if (!res.write('{"type":"heartbeat"}\n')) res.destroy();
    }, 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      streams.delete(res);
    });
  });
  runtime.events.on("event", (event: TaskEvent) => {
    for (const stream of streams)
      if (!stream.write(`${JSON.stringify(event)}\n`)) stream.destroy();
  });
  app.use((_req, res) =>
    res
      .status(404)
      .json({ error: "Unknown endpoint; legacy automation API is disabled" }),
  );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message = error instanceof Error ? error.message : "Request failed";
      res
        .status(
          message === "Unknown task"
            ? 404
            : error instanceof z.ZodError
              ? 400
              : 409,
        )
        .json({ error: message });
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 7788, "127.0.0.1", resolve);
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : options.port!;
  return {
    runtime,
    port,
    tokenPath,
    close: async () => {
      for (const stream of streams) stream.end();
      await runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
