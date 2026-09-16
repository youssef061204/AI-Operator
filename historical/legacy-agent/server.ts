import cors from "cors";
import express, { type Request, type Response } from "express";
import http from "node:http";
import os from "node:os";

import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  ActionDecisionSchema,
  CognitionGoalRequestSchema,
  CognitionInteractionRequestSchema,
  DeviceRegisterRequestSchema,
  OsInputControlInputSchema,
  PermissionGrantRequestSchema,
  PipelineRequestSchema,
  QueuePushRequestSchema,
  UpdateSettingsSchema,
} from "@operator-assist/shared";

import { HOST, PORT, DB_PATH, LOG_PATH } from "./config.js";
import { LogBus } from "./bus.js";
import { ActionEngine } from "./engine.js";
import { CognitionRuntime } from "./cognition.js";
import { ControlBrain, type BrainDecision } from "./control-brain.js";
import { buildDemoPipeline, buildLeadModePipeline } from "./pipeline.js";
import { Storage } from "./storage.js";
import { nowIso, newId } from "./utils.js";

export async function startAgentServer(port = PORT, host = HOST): Promise<{ close: () => Promise<void> }> {
  throw new Error("Legacy server retired. Use the authenticated developer runtime.");
  const storage = new Storage();
  const bootSettings = storage.getSettings();
  if (
    bootSettings.autonomous_runtime &&
    (bootSettings.approval_mode || bootSettings.browser_automation_mode !== "browser" || bootSettings.dry_run_mode)
  ) {
    storage.updateSettings({
      approval_mode: false,
      desktop_popups: false,
      browser_automation_mode: "browser",
      dry_run_mode: false,
    });
  }
  const bus = new LogBus(storage);
  const engine = new ActionEngine(storage, bus);
  const controlBrain = new ControlBrain();
  const cognition = new CognitionRuntime(storage, bus, engine);
  cognition.start();
  const LeadSeedSchema = z.object({
    company_name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    url: z.string().min(3).optional(),
  }).refine((value) => Boolean(value.company_name || value.email || value.url), {
    message: "Each lead requires at least one of company_name, email, or url.",
  });
  const LeadModeRequestSchema = z.object({
    goal: z.string().min(3),
    provider: z.enum(["vercel", "netlify"]).default("vercel"),
    workspace_root: z.string().min(1),
    leads: z.array(LeadSeedSchema).min(1),
  });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  const ControlExecuteRequestSchema = z.object({
    objective: z.string().min(1),
    steps: z.array(z.any()).optional(),
    dry_run: z.boolean().optional(),
    interrupt_current: z.boolean().optional(),
    session_id: z.string().min(1).max(120).optional(),
  });
  const VisionAnalyzeRequestSchema = z.object({
    prompt: z.string().min(3).max(400).default("Describe what is on the current screen and the best next UI action."),
    model: z.string().min(1).max(120).optional(),
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: "operator-assist-agent",
      time: nowIso(),
      host,
      port,
      db_path: DB_PATH,
      log_path: LOG_PATH,
      settings: engine.settings,
      counts: engine.getCounts(),
      cognition: cognition.getSnapshot(),
    });
  });

  app.post("/device/register", (req: Request, res: Response) => {
    try {
      const body = DeviceRegisterRequestSchema.parse(req.body);
      const device = storage.registerDevice(body.pairing_code, body.device_name, body.device_id ?? `${os.hostname()}-${newId().slice(0, 8)}`);
      bus.emitLog("info", "device_registered", `Registered device ${device.device_name}`, { pairing_code: body.pairing_code });
      res.json({ ok: true, device });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/device/default-pairing", (_req: Request, res: Response) => {
    const pairingCode = storage.getDefaultPairingCode();
    res.json({ ok: true, pairing_code: pairingCode });
  });

  app.get("/device/status", (req: Request, res: Response) => {
    const pairingCode = String(req.query.pairing_code ?? "").trim();
    if (!pairingCode) {
      res.status(400).json({ ok: false, error: "pairing_code is required" });
      return;
    }
    res.json({ ok: true, ...storage.getDeviceStatus(pairingCode) });
  });

  app.post("/queue/push", (req: Request, res: Response) => {
    try {
      const body = QueuePushRequestSchema.parse(req.body);
      const actions = engine.pushActions(body.actions);
      res.json({ ok: true, pushed: actions.length, actions, snapshot: engine.snapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/demo/os-control", async (req: Request, res: Response) => {
    try {
      const interruptCurrent = req.body?.interrupt_current !== false;
      if (interruptCurrent) {
        await engine.killNow();
      }
      await engine.resume();
      const scenarioRaw = String(req.body?.scenario ?? "full").trim().toLowerCase();
      const scenario = scenarioRaw === "cursor" || scenarioRaw === "full" || scenarioRaw === "smoke"
        ? scenarioRaw as "cursor" | "full" | "smoke"
        : "full";
      const text = String(req.body?.text ?? "Operator control demo is running.").trim().slice(0, 200);
      const duration = Number(req.body?.duration_ms ?? 3500);
      const durationMs = Number.isFinite(duration) ? Math.max(300, Math.min(30000, Math.floor(duration))) : 3500;
      const now = nowIso();
      const action = {
        id: newId(),
        run_id: newId(),
        project_id: `os-control-demo-${Date.now()}`,
        type: "OS_DEMO_CONTROL" as const,
        description: "Run OS-level control demo",
        risk_level: "MEDIUM" as const,
        required_permissions: [],
        inputs: {
          scenario,
          text,
          duration_ms: durationMs,
        },
        state: "QUEUED" as const,
        created_at: now,
        updated_at: now,
      };
      const actions = engine.pushActions([action]);
      res.json({ ok: true, action: actions[0], snapshot: engine.snapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/control/execute", async (req: Request, res: Response) => {
    try {
      const incoming = ControlExecuteRequestSchema.parse(req.body ?? {});
      const sessionId = String(incoming.session_id ?? "default").trim() || "default";
      const interruptCurrent = incoming.interrupt_current !== false;
      const parsedSteps = Array.isArray(incoming.steps) ? incoming.steps : [];

      const decision: BrainDecision = parsedSteps.length > 0
        ? {
            mode: "queued" as const,
            session_id: sessionId,
            summary: "Executing explicit control steps.",
            reset_session: false,
            actions: [
              {
                description: `Execute provided control steps (${parsedSteps.length})`,
                objective: incoming.objective,
                steps: parsedSteps,
              },
            ],
          }
        : await controlBrain.reason(sessionId, incoming.objective);

      if (decision.mode === "needs_input") {
        res.json({
          ok: true,
          mode: "needs_input",
          session_id: decision.session_id,
          summary: decision.summary,
          question: decision.question,
        });
        return;
      }

      if (interruptCurrent) {
        await engine.killNow();
      }
      await engine.resume();

      const now = nowIso();
      const runId = newId();
      const actions = engine.pushActions(
        decision.actions.map((item, index) => {
          const controlInput = OsInputControlInputSchema.parse({
            objective: item.objective,
            steps: item.steps ?? [],
            dry_run: incoming.dry_run === true,
          });
          return {
            id: newId(),
            run_id: runId,
            project_id: `os-control-${Date.now()}-${index}`,
            type: "OS_INPUT_CONTROL" as const,
            description: item.description || `Execute OS input objective: ${item.objective.slice(0, 90)}`,
            risk_level: "HIGH" as const,
            required_permissions: [],
            inputs: controlInput,
            state: "QUEUED" as const,
            created_at: now,
            updated_at: now,
          };
        }),
      );

      if (decision.reset_session) {
        controlBrain.resetSession(sessionId);
      }

      res.json({
        ok: true,
        mode: "queued",
        session_id: sessionId,
        summary: decision.summary,
        actions,
        action: actions[0],
        snapshot: engine.snapshot(),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/control/reset-session", (req: Request, res: Response) => {
    const sessionId = String(req.body?.session_id ?? "default").trim() || "default";
    controlBrain.resetSession(sessionId);
    res.json({ ok: true, session_id: sessionId, reset: true });
  });

  app.get("/control/reasoner-status", async (_req: Request, res: Response) => {
    try {
      const status = await controlBrain.getReasonerStatus();
      res.json({ ok: true, ...status });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/vision/snapshot", async (req: Request, res: Response) => {
    try {
      const label = String(req.body?.label ?? "screen").trim().slice(0, 40) || "screen";
      const snapshot = await engine.captureScreenSnapshot(label);
      res.json({ ok: true, ...snapshot });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/vision/analyze", async (req: Request, res: Response) => {
    try {
      const input = VisionAnalyzeRequestSchema.parse(req.body ?? {});
      const result = await engine.analyzeScreenWithOllama(input.prompt, input.model);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/queue/status", (_req: Request, res: Response) => {
    res.json({ ok: true, ...engine.snapshot() });
  });

  app.get("/action/:id", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ ok: false, error: "id is required" });
      return;
    }
    const action = engine.getAction(id);
    if (!action) {
      res.status(404).json({ ok: false, error: "action not found" });
      return;
    }
    res.json({ ok: true, action });
  });

  app.post("/action/approve", (req: Request, res: Response) => {
    try {
      const body = ActionDecisionSchema.parse(req.body);
      const action = engine.approve(body.id);
      res.json({ ok: true, action, snapshot: engine.snapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/action/reject", (req: Request, res: Response) => {
    try {
      const body = ActionDecisionSchema.parse(req.body);
      const action = engine.reject(body.id);
      res.json({ ok: true, action, snapshot: engine.snapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/permissions/grant", (req: Request, res: Response) => {
    try {
      const body = PermissionGrantRequestSchema.parse(req.body);
      const result = engine.grantPermissions(body.permissions, body.scope);
      if (body.scope === "once" && body.action_id) {
        engine.approve(body.action_id);
      }
      res.json({ ok: true, ...result, snapshot: engine.snapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/permissions/revoke", (req: Request, res: Response) => {
    try {
      const permission = String(req.body?.permission ?? "").trim();
      const scopeRaw = String(req.body?.scope ?? "session").trim().toLowerCase();
      if (scopeRaw !== "session" && scopeRaw !== "always") {
        throw new Error("scope must be session or always");
      }
      const scope = scopeRaw as "session" | "always";
      const result = engine.revokePermission(permission, scope);
      res.json({ ok: true, ...result, snapshot: engine.snapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/permissions", (_req: Request, res: Response) => {
    res.json({ ok: true, ...engine.getOperatorStatus(), settings: engine.settings });
  });

  app.post("/kill", async (_req: Request, res: Response) => {
    const result = await engine.killNow();
    await engine.pause();
    cognition.suspendOperationalGoals("kill_switch");
    cognition.recordInteraction({ kind: "pause", detail: "kill_switch_pause", active: true });
    res.json({ ok: true, ...result, snapshot: engine.snapshot() });
  });

  app.post("/operator/pause", async (_req: Request, res: Response) => {
    try {
      const result = await engine.pause();
      cognition.recordInteraction({ kind: "pause", detail: "operator_pause" });
      res.json({ ok: true, ...result, snapshot: engine.snapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/operator/resume", async (_req: Request, res: Response) => {
    try {
      const result = await engine.resume();
      cognition.recordInteraction({ kind: "resume", detail: "operator_resume" });
      res.json({ ok: true, ...result, snapshot: engine.snapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/operator/status", (_req: Request, res: Response) => {
    res.json({ ok: true, ...engine.getOperatorStatus(), snapshot: engine.snapshot() });
  });

  app.get("/cognition/state", (_req: Request, res: Response) => {
    res.json({ ok: true, ...cognition.getSnapshot() });
  });

  app.get("/cognition/goals", (_req: Request, res: Response) => {
    res.json({ ok: true, goals: cognition.listGoals() });
  });

  app.get("/cognition/tools", (_req: Request, res: Response) => {
    res.json({ ok: true, tools: cognition.listTools() });
  });

  app.post("/cognition/goal", (req: Request, res: Response) => {
    try {
      const body = CognitionGoalRequestSchema.parse(req.body);
      const goal = cognition.upsertGoal(body);
      cognition.recordInteraction({ kind: "manual_input", detail: body.objective, active: true });
      res.json({ ok: true, goal, state: cognition.getSnapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/cognition/interaction", (req: Request, res: Response) => {
    try {
      const body = CognitionInteractionRequestSchema.parse(req.body);
      cognition.recordInteraction(body);
      res.json({ ok: true, state: cognition.getSnapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/auth/bootstrap", async (req: Request, res: Response) => {
    try {
      const providers = Array.isArray(req.body?.providers)
        ? req.body.providers.map((item: unknown) => String(item))
        : undefined;
      const result = await engine.bootstrapAuth(providers);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/settings", (_req: Request, res: Response) => {
    res.json({ ok: true, settings: engine.settings });
  });

  app.post("/settings", (req: Request, res: Response) => {
    try {
      const patch = UpdateSettingsSchema.parse(req.body);
      const settings = storage.updateSettings(patch);
      bus.emitLog("info", "settings_updated", "Updated settings", { patch });
      res.json({ ok: true, settings });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/pipeline/demo", (req: Request, res: Response) => {
    try {
      const body = PipelineRequestSchema.parse(req.body);
      storage.updateSettings({
        provider: body.provider,
        browser_automation_mode: body.automation_mode,
        workspace_root: body.workspace_root,
      });
      const pipeline = buildDemoPipeline(body);
      const actions = engine.pushActions(pipeline.actions);
      res.json({ ok: true, ...pipeline, queued_actions: actions.length, actions, snapshot: engine.snapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/pipeline/lead-mode", (req: Request, res: Response) => {
    try {
      const body = LeadModeRequestSchema.parse(req.body);
      storage.updateSettings({
        provider: body.provider,
        workspace_root: body.workspace_root,
      });
      const pipeline = buildLeadModePipeline(body);
      const actions = engine.pushActions(pipeline.actions);
      res.json({ ok: true, ...pipeline, queued_actions: actions.length, actions, snapshot: engine.snapshot() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const server = http.createServer(app);
  const wsServer = new WebSocketServer({ noServer: true });

  wsServer.on("connection", (socket) => {
    bus.addClient(socket);
    socket.send(JSON.stringify({ type: "hello", data: { service: "operator-assist-agent", time: nowIso() } }));
    socket.send(JSON.stringify({ type: "queue_snapshot", data: engine.snapshot() }));
    socket.send(JSON.stringify({ type: "cognition_state", data: cognition.getSnapshot() }));
  });

  server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/logs/stream")) {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      bus.emitLog("info", "agent_started", `Agent listening on http://${host}:${port}`, {
        db_path: DB_PATH,
      });
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  return {
    close: async () => {
      cognition.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

if (false) {
  startAgentServer().then(() => {
    // eslint-disable-next-line no-console
    console.log(`Operator Assist Agent running at http://${HOST}:${PORT}`);
  }).catch((error) => {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "EADDRINUSE") {
      // eslint-disable-next-line no-console
      console.error(
        `Agent port ${HOST}:${PORT} is already in use.\n` +
        "If desktop dev is running, do not start `pnpm --filter @operator-assist/agent dev:service` separately.\n" +
        "To free the port on Windows: `Get-NetTCPConnection -LocalPort 7788 -State Listen | " +
        "Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }`",
      );
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.error("Fatal agent startup error", error);
    process.exit(1);
  });
}
