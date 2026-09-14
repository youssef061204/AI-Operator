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
import { OllamaProvider } from "./providers.js";
import type { Provider, TaskEvent } from "./contracts.js";

export interface ServerOptions {
  workspace: string;
  dataDir: string;
  port?: number;
  token?: string;
  providers?: Provider[];
  origins?: string[];
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
  const providers = options.providers ?? [
    new OllamaProvider(
      process.env.OPERATOR_MODEL ?? "qwen2.5-coder:7b",
      process.env.OPERATOR_MODEL_URL ?? "http://127.0.0.1:11434",
    ),
  ];
  if (!options.providers && process.env.OPERATOR_FALLBACK_MODEL)
    providers.push(
      new OllamaProvider(
        process.env.OPERATOR_FALLBACK_MODEL,
        process.env.OPERATOR_FALLBACK_URL ?? "http://127.0.0.1:11434",
      ),
    );
  const store = new TaskStore(options.dataDir);
  let runtime: AgentRuntime;
  try {
    runtime = new AgentRuntime(store, options.workspace, providers);
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
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.status(401).json({ error: "Bearer token required" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "256kb", strict: true }));
  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      service: "ai-operator",
      provider: providers.map((p) => p.name).join(", "),
    }),
  );
  app.get("/tasks", (_req, res) => res.json({ tasks: runtime.list() }));
  app.post("/tasks", (req, res) =>
    res.status(201).json({ task: runtime.create(req.body) }),
  );
  app.get("/tasks/:id", (req, res) =>
    res.json({ task: runtime.get(String(req.params.id)) }),
  );
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
