import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

import open from "open";
import type { ActionEnvelope, ActionState } from "@operator-assist/shared";
import {
  CheckServerHealthInputSchema,
  CreateBusinessFolderInputSchema,
  DeploySiteInputSchema,
  GmailDraftsInputSchema,
  GitInitInputSchema,
  InstallDependenciesInputSchema,
  LocalResearchInputSchema,
  LovableAutomateInputSchema,
  OpenLovableInputSchema,
  OpenTabsInputSchema,
  OsDemoControlInputSchema,
  OsInputControlInputSchema,
  OsInputStepSchema,
  type OsInputStep,
  PlanGoalInputSchema,
  PublishGithubInputSchema,
  RunSynthesizedToolInputSchema,
  ScaffoldNextJsInputSchema,
  StartLocalPreviewInputSchema,
  SynthesizeToolInputSchema,
  ToolRecordSchema,
  type ToolRecord,
} from "@operator-assist/shared";

import { DATA_DIR } from "./config.js";
import { type LogBus } from "./bus.js";
import { buildPlan } from "./pipeline.js";
import { type PersistedAction, type Storage } from "./storage.js";
import { newId, nowIso, redactSecrets, slugify } from "./utils.js";

const TERMINAL_STATES: ActionState[] = ["SUCCESS", "FAILED", "CANCELED"];

class PauseInterruptedError extends Error {
  readonly resume_step_index?: number;
  readonly reason_code?: "manual_pause" | "login_required";
  readonly user_handoff: boolean;

  constructor(
    message: string,
    meta?: {
      resume_step_index?: number;
      reason_code?: "manual_pause" | "login_required";
      user_handoff?: boolean;
    },
  ) {
    super(message);
    this.name = "PauseInterruptedError";
    this.resume_step_index = Number.isFinite(meta?.resume_step_index)
      ? Math.max(0, Math.floor(Number(meta?.resume_step_index)))
      : undefined;
    this.reason_code = meta?.reason_code;
    this.user_handoff = meta?.user_handoff !== false;
  }
}

type ScreenSnapshot = {
  screenshot_path: string;
  captured_at: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

export class ActionEngine {
  private readonly actions = new Map<string, PersistedAction>();
  private readonly sessionPermissionGrants = new Set<string>();
  private processing = false;
  private killRequested = false;
  private paused = false;
  private pauseInterruptRequested = false;
  private currentActionId: string | null = null;
  private currentActionType: ActionEnvelope["type"] | null = null;
  private currentChild: ChildProcess | null = null;
  private readonly loginGateDetectionEnabled = process.env.OPERATOR_LOGIN_GATE_DETECTION !== "0";
  private readonly loginGateDetectionStepInterval = (() => {
    const raw = Number(process.env.OPERATOR_LOGIN_GATE_STEP_INTERVAL ?? "2");
    if (!Number.isFinite(raw)) return 2;
    return Math.max(1, Math.min(10, Math.floor(raw)));
  })();
  private readonly loginGateDetectionCooldownMs = (() => {
    const raw = Number(process.env.OPERATOR_LOGIN_GATE_COOLDOWN_MS ?? "2500");
    if (!Number.isFinite(raw)) return 2500;
    return Math.max(800, Math.min(12000, Math.floor(raw)));
  })();
  // Manual login handoff is enforced for operator safety and consistency.
  private readonly autoLoginEnabled = false;
  private readonly autoLoginMaxAttemptsPerAction = 0;
  private readonly adaptiveOsLoopEnabled = process.env.OPERATOR_ADAPTIVE_OS_LOOP !== "0";
  private readonly adaptiveReassessInterval = (() => {
    const raw = Number(process.env.OPERATOR_ADAPTIVE_REASSESS_INTERVAL ?? "2");
    if (!Number.isFinite(raw)) return 2;
    return Math.max(1, Math.min(8, Math.floor(raw)));
  })();
  private readonly adaptiveInitialStepCap = (() => {
    const raw = Number(process.env.OPERATOR_ADAPTIVE_INITIAL_STEP_CAP ?? "6");
    if (!Number.isFinite(raw)) return 6;
    return Math.max(2, Math.min(20, Math.floor(raw)));
  })();
  private readonly adaptiveMaxTotalSteps = (() => {
    const raw = Number(process.env.OPERATOR_ADAPTIVE_MAX_TOTAL_STEPS ?? "140");
    if (!Number.isFinite(raw)) return 140;
    return Math.max(20, Math.min(400, Math.floor(raw)));
  })();

  constructor(private readonly storage: Storage, private readonly logs: LogBus) {
    for (const action of storage.listActions()) {
      this.actions.set(action.id, action);
    }

    for (const action of this.actions.values()) {
      if (action.state === "RUNNING") {
        action.state = "FAILED";
        action.error = "Agent restarted while RUNNING";
        action.updated_at = nowIso();
        this.storage.upsertAction(action);
      }
    }

    if (String(process.env.OPERATOR_AUTO_LOGIN || "").trim() === "1") {
      this.logs.emitLog(
        "warn",
        "auto_login_disabled",
        "OPERATOR_AUTO_LOGIN=1 was ignored. Manual login handoff is always enforced.",
      );
    }
  }

  get settings() {
    return this.storage.getSettings();
  }

  listActions(): PersistedAction[] {
    return Array.from(this.actions.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  getAction(id: string): PersistedAction | undefined {
    return this.actions.get(id);
  }

  getCounts() {
    const counts = {
      queued: 0,
      awaiting_approval: 0,
      running: 0,
      success: 0,
      failed: 0,
      canceled: 0,
    };

    for (const action of this.actions.values()) {
      if (action.state === "QUEUED") counts.queued += 1;
      else if (action.state === "AWAITING_APPROVAL") counts.awaiting_approval += 1;
      else if (action.state === "RUNNING") counts.running += 1;
      else if (action.state === "SUCCESS") counts.success += 1;
      else if (action.state === "FAILED") counts.failed += 1;
      else if (action.state === "CANCELED") counts.canceled += 1;
    }

    return counts;
  }

  snapshot(): Record<string, unknown> {
    return {
      actions: this.listActions(),
      counts: this.getCounts(),
      settings: this.settings,
      kill_requested: this.killRequested,
      paused: this.paused,
      session_allow_permissions: Array.from(this.sessionPermissionGrants.values()),
    };
  }

  pushActions(incoming: ActionEnvelope[]): ActionEnvelope[] {
    const settings = this.settings;
    const pushed: ActionEnvelope[] = [];

    for (const action of incoming) {
      this.validateActionInputs(action);
      const hasApprovalBypass = this.hasPermissionBypass(action.required_permissions ?? []);
      const next: PersistedAction = {
        ...action,
        state: settings.approval_mode && !hasApprovalBypass ? "AWAITING_APPROVAL" : "QUEUED",
        updated_at: nowIso(),
      };
      this.actions.set(next.id, next);
      this.storage.upsertAction(next);
      pushed.push(next);
      this.logs.emitLog("info", "action_queued", `Queued ${next.type}: ${next.description}`, { action_id: next.id, run_id: next.run_id }, next.id);
    }

    this.logs.emitQueueSnapshot(this.snapshot());
    this.pump();
    return pushed;
  }

  approve(actionId: string): PersistedAction {
    const action = this.requireAction(actionId);
    if (action.state !== "AWAITING_APPROVAL") {
      throw new Error(`Cannot approve action in state ${action.state}`);
    }
    action.state = "QUEUED";
    action.updated_at = nowIso();
    this.storage.upsertAction(action);
    this.logs.emitLog("info", "action_approved", `Approved: ${action.description}`, { action_id: action.id }, action.id);
    this.logs.emitQueueSnapshot(this.snapshot());
    this.pump();
    return action;
  }

  reject(actionId: string): PersistedAction {
    const action = this.requireAction(actionId);
    if (TERMINAL_STATES.includes(action.state)) {
      throw new Error("Action is already terminal");
    }
    action.state = "CANCELED";
    action.error = "Rejected by operator";
    action.updated_at = nowIso();
    this.storage.upsertAction(action);
    this.logs.emitLog("warn", "action_rejected", `Rejected: ${action.description}`, { action_id: action.id }, action.id);
    this.logs.emitQueueSnapshot(this.snapshot());
    return action;
  }

  async killNow(): Promise<{ canceled: number }> {
    this.killRequested = true;

    if (this.currentChild && !this.currentChild.killed) {
      try {
        this.currentChild.kill("SIGTERM");
      } catch {
        // noop
      }
    }

    let canceled = 0;
    for (const action of this.actions.values()) {
      if (["RUNNING", "QUEUED", "AWAITING_APPROVAL"].includes(action.state)) {
        action.state = "CANCELED";
        action.error = "Canceled by kill switch";
        action.updated_at = nowIso();
        this.storage.upsertAction(action);
        canceled += 1;
      }
    }

    this.logs.emitLog("warn", "kill_switch", "Kill switch activated", { canceled });
    this.logs.emitQueueSnapshot(this.snapshot());

    this.killRequested = false;
    this.processing = false;
    return { canceled };
  }

  getOperatorStatus(): Record<string, unknown> {
    return {
      paused: this.paused,
      kill_requested: this.killRequested,
      running_action_id: this.currentActionId,
      running_action_type: this.currentActionType,
      session_allow_permissions: Array.from(this.sessionPermissionGrants.values()),
      counts: this.getCounts(),
    };
  }

  async pause(): Promise<{ paused: boolean; interrupted: boolean }> {
    this.paused = true;
    let interrupted = false;
    if (this.currentChild && !this.currentChild.killed) {
      this.pauseInterruptRequested = true;
      interrupted = true;
      try {
        this.currentChild.kill("SIGTERM");
      } catch {
        // noop
      }
    }
    this.logs.emitLog("warn", "operator_paused", "Operator paused by user", { interrupted });
    this.logs.emitQueueSnapshot(this.snapshot());
    return { paused: true, interrupted };
  }

  async resume(): Promise<{ paused: boolean }> {
    this.paused = false;
    this.pauseInterruptRequested = false;
    this.logs.emitLog("info", "operator_resumed", "Operator resumed by user");
    this.logs.emitQueueSnapshot(this.snapshot());
    this.pump();
    return { paused: false };
  }

  grantPermissions(permissions: string[], scope: "once" | "session" | "always"): { scope: string; granted: string[] } {
    const granted = permissions
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (granted.length === 0) return { scope, granted: [] };

    if (scope === "session") {
      for (const permission of granted) this.sessionPermissionGrants.add(permission);
    }
    if (scope === "always") {
      const current = new Set(this.settings.always_allow_permissions ?? []);
      for (const permission of granted) current.add(permission);
      this.storage.updateSettings({ always_allow_permissions: Array.from(current.values()) });
    }

    this.logs.emitLog("info", "permission_granted", `Permission granted (${scope}): ${granted.join(", ")}`, {
      scope,
      permissions: granted,
    });
    this.logs.emitQueueSnapshot(this.snapshot());
    return { scope, granted };
  }

  revokePermission(permission: string, scope: "session" | "always"): { scope: string; permission: string } {
    const key = String(permission || "").trim();
    if (!key) throw new Error("permission is required");

    if (scope === "session") {
      this.sessionPermissionGrants.delete(key);
    } else {
      const remaining = (this.settings.always_allow_permissions ?? []).filter((item) => item !== key);
      this.storage.updateSettings({ always_allow_permissions: remaining });
    }

    this.logs.emitLog("warn", "permission_revoked", `Permission revoked (${scope}): ${key}`, { scope, permission: key });
    this.logs.emitQueueSnapshot(this.snapshot());
    return { scope, permission: key };
  }

  async bootstrapAuth(providers?: string[]): Promise<Record<string, unknown>> {
    const targets = (providers ?? ["gmail", "deploy"]).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
    const results: Record<string, string> = {};

    for (const target of targets) {
      if (target === "gmail") {
        results.gmail = "manual_signin_required";
      } else if (target === "deploy") {
        results.deploy = "cli_credentials_required";
      } else {
        results[target] = "manual_check_required";
      }
    }

    const summary = Object.entries(results)
      .map(([provider, status]) => `${provider}:${status}`)
      .join(", ");
    this.logs.emitLog("info", "auth_bootstrap", `Auth bootstrap guidance generated: ${summary}`, { results });

    return {
      mode: "os-native",
      providers: results,
      message: "OS-native mode: sign in with local apps/CLI as needed. No browser automation is used.",
    };
  }

  private requireAction(id: string): PersistedAction {
    const action = this.actions.get(id);
    if (!action) throw new Error(`Unknown action: ${id}`);
    return action;
  }

  private hasPermissionBypass(permissions: string[]): boolean {
    const required = (permissions ?? []).map((item) => String(item || "").trim()).filter(Boolean);
    if (required.length === 0) return true;
    const alwaysAllowed = new Set((this.settings.always_allow_permissions ?? []).map((item) => String(item || "").trim()));
    return required.every((permission) => alwaysAllowed.has(permission) || this.sessionPermissionGrants.has(permission));
  }

  private validateActionInputs(action: ActionEnvelope): void {
    switch (action.type) {
      case "PLAN_GOAL":
        PlanGoalInputSchema.parse(action.inputs);
        break;
      case "CREATE_BUSINESS_FOLDER":
        CreateBusinessFolderInputSchema.parse(action.inputs);
        break;
      case "SCAFFOLD_NEXTJS_SITE":
        ScaffoldNextJsInputSchema.parse(action.inputs);
        break;
      case "GIT_INIT":
        GitInitInputSchema.parse(action.inputs);
        break;
      case "INSTALL_DEPENDENCIES":
        InstallDependenciesInputSchema.parse(action.inputs);
        break;
      case "OPEN_TABS":
        OpenTabsInputSchema.parse(action.inputs);
        break;
      case "GMAIL_DRAFTS":
        GmailDraftsInputSchema.parse(action.inputs);
        break;
      case "OPEN_LOVABLE":
        OpenLovableInputSchema.parse(action.inputs);
        break;
      case "LOVABLE_AUTOMATE":
        LovableAutomateInputSchema.parse(action.inputs);
        break;
      case "PUBLISH_GITHUB":
        PublishGithubInputSchema.parse(action.inputs);
        break;
      case "DEPLOY_SITE":
        DeploySiteInputSchema.parse(action.inputs);
        break;
      case "LOCAL_RESEARCH":
        LocalResearchInputSchema.parse(action.inputs);
        break;
      case "START_LOCAL_PREVIEW":
        StartLocalPreviewInputSchema.parse(action.inputs);
        break;
      case "CHECK_SERVER_HEALTH":
        CheckServerHealthInputSchema.parse(action.inputs);
        break;
      case "SYNTHESIZE_TOOL":
        SynthesizeToolInputSchema.parse(action.inputs);
        break;
      case "RUN_SYNTHESIZED_TOOL":
        RunSynthesizedToolInputSchema.parse(action.inputs);
        break;
      case "OS_DEMO_CONTROL":
        OsDemoControlInputSchema.parse(action.inputs);
        break;
      case "OS_INPUT_CONTROL":
        OsInputControlInputSchema.parse(action.inputs);
        break;
      default:
        throw new Error(`Unsupported type: ${action.type}`);
    }
  }

  private pump(): void {
    if (this.processing) return;
    void this.process();
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (!this.killRequested && !this.paused) {
        const next = this.listActions().find((action) => action.state === "QUEUED");
        if (!next) break;
        await this.execute(next.id);
      }
    } finally {
      this.processing = false;
    }
  }

  private async execute(id: string): Promise<void> {
    const action = this.requireAction(id);
    this.currentActionId = action.id;
    this.currentActionType = action.type;
    action.state = "RUNNING";
    action.updated_at = nowIso();
    action.error = undefined;
    this.storage.upsertAction(action);
    this.logs.emitLog("info", "action_running", `Running: ${action.description}`, { action_id: action.id }, action.id);
    this.logs.emitQueueSnapshot(this.snapshot());

    try {
      const result = await this.runAction(action);
      action.state = "SUCCESS";
      action.result = result;
      action.updated_at = nowIso();
      this.storage.upsertAction(action);
      this.logs.emitLog("info", "action_success", `Completed: ${action.description}`, { action_id: action.id }, action.id);
    } catch (error) {
      if (error instanceof PauseInterruptedError) {
        const priorResult = (action.result && typeof action.result === "object")
          ? action.result as Record<string, unknown>
          : {};
        action.state = "QUEUED";
        action.error = redactSecrets(error.message);
        action.result = {
          ...priorResult,
          paused_reason: error.reason_code ?? "manual_pause",
          resume_step_index: Number.isFinite(error.resume_step_index) ? error.resume_step_index : priorResult.resume_step_index,
          user_handoff: error.user_handoff,
          paused_at: nowIso(),
        };
        action.updated_at = nowIso();
        this.storage.upsertAction(action);
        this.logs.emitLog("warn", "action_paused_requeued", `Paused and re-queued: ${action.description}`, {
          action_id: action.id,
          paused_reason: error.reason_code ?? "manual_pause",
          resume_step_index: Number.isFinite(error.resume_step_index) ? error.resume_step_index : undefined,
        }, action.id);
        return;
      }

      action.state = "FAILED";
      action.error = redactSecrets(error instanceof Error ? error.message : String(error));
      action.updated_at = nowIso();
      this.storage.upsertAction(action);
      this.logs.emitLog("error", "action_failed", `Failed: ${action.description}`, { action_id: action.id, error: action.error }, action.id);
    } finally {
      this.currentActionId = null;
      this.currentActionType = null;
      this.currentChild = null;
      this.logs.emitQueueSnapshot(this.snapshot());
    }
  }

  private async runAction(action: PersistedAction): Promise<Record<string, unknown>> {
    if (
      this.settings.dry_run_mode &&
      action.type !== "PLAN_GOAL" &&
      action.type !== "OS_INPUT_CONTROL" &&
      action.type !== "OS_DEMO_CONTROL"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return this.simulateAction(action);
    }

    switch (action.type) {
      case "PLAN_GOAL": {
        const input = PlanGoalInputSchema.parse(action.inputs);
        const plan = buildPlan(input.goal);
        return plan as unknown as Record<string, unknown>;
      }
      case "CREATE_BUSINESS_FOLDER": {
        const input = CreateBusinessFolderInputSchema.parse(action.inputs);
        const workspace = path.resolve(input.workspace_root);
        const projectDir = input.project_dir
          ? path.resolve(input.project_dir)
          : path.join(workspace, input.project_slug ?? `business-${Date.now()}`);
        await fsp.mkdir(projectDir, { recursive: true });
        await Promise.all([
          fsp.mkdir(path.join(projectDir, "drafts"), { recursive: true }),
          fsp.mkdir(path.join(projectDir, "logs"), { recursive: true }),
          fsp.mkdir(path.join(projectDir, "assets"), { recursive: true }),
        ]);
        return { workspace_root: workspace, project_dir: projectDir };
      }
      case "SCAFFOLD_NEXTJS_SITE": {
        return this.executeScaffold(action);
      }
      case "GIT_INIT": {
        const input = GitInitInputSchema.parse(action.inputs);
        const result = await this.runCommand(action.id, "git", ["init"], path.resolve(input.project_dir));
        action.stdout = result.stdout;
        action.stderr = result.stderr;
        return result;
      }
      case "INSTALL_DEPENDENCIES": {
        const input = InstallDependenciesInputSchema.parse(action.inputs);
        const command = input.package_manager === "pnpm" ? "pnpm" : "npm";
        const result = await this.runCommand(action.id, command, ["install"], path.resolve(input.project_dir));
        action.stdout = result.stdout;
        action.stderr = result.stderr;
        return result;
      }
      case "OPEN_TABS": {
        const input = OpenTabsInputSchema.parse(action.inputs);
        const opened = await this.openUrls(input.urls);
        return { opened: opened.length, urls: opened };
      }
      case "GMAIL_DRAFTS": {
        const input = GmailDraftsInputSchema.parse(action.inputs);
        const draftsDir = path.join(path.resolve(input.project_dir), "drafts");
        await fsp.mkdir(draftsDir, { recursive: true });
        const draftsPath = path.join(draftsDir, "gmail-drafts.txt");
        await fsp.writeFile(draftsPath, `${input.drafts.join("\n\n---\n\n")}\n`, "utf8");

        let opened = 0;
        if (input.compose_urls.length > 0) {
          for (const composeUrl of input.compose_urls) {
            await open(composeUrl);
            opened += 1;
          }
        }
        return { drafts_path: draftsPath, opened_compose_tabs: opened };
      }
      case "OPEN_LOVABLE": {
        OpenLovableInputSchema.parse(action.inputs);
        throw new Error("External visual site builders are disabled in OS-native runtime.");
      }
      case "LOVABLE_AUTOMATE": {
        LovableAutomateInputSchema.parse(action.inputs);
        throw new Error("Browser automation is disabled in OS-native runtime.");
      }
      case "PUBLISH_GITHUB": {
        const input = PublishGithubInputSchema.parse(action.inputs);
        const cwd = path.resolve(input.project_dir);
        await this.runCommand(action.id, "git", ["add", "."], cwd);
        await this.runCommand(action.id, "git", ["commit", "-m", "Initial scaffold from Operator Assist"], cwd, { tolerateFailure: true });
        const visibility = input.private ? "--private" : "--public";
        const result = await this.runCommand(action.id, "gh", ["repo", "create", input.repo_name, visibility, "--source", ".", "--remote", "origin", "--push"], cwd);
        action.stdout = result.stdout;
        action.stderr = result.stderr;
        return result;
      }
      case "DEPLOY_SITE": {
        const input = DeploySiteInputSchema.parse(action.inputs);
        const cwd = path.resolve(input.project_dir);
        const command = input.provider === "netlify" ? "netlify" : "vercel";
        const args = input.provider === "netlify" ? ["deploy", "--build"] : ["--yes"];
        if (input.prod) args.push("--prod");
        const result = await this.runCommand(action.id, command, args, cwd);
        action.stdout = result.stdout;
        action.stderr = result.stderr;
        return { ...result, provider: input.provider, prod: input.prod };
      }
      case "LOCAL_RESEARCH": {
        const input = LocalResearchInputSchema.parse(action.inputs);
        return this.executeLocalResearch(input.query, input.max_results, input.sources);
      }
      case "START_LOCAL_PREVIEW": {
        const input = StartLocalPreviewInputSchema.parse(action.inputs);
        return this.startLocalPreview(action.id, input.project_dir, input.command, input.port);
      }
      case "CHECK_SERVER_HEALTH": {
        const input = CheckServerHealthInputSchema.parse(action.inputs);
        return this.checkServerHealth(input.url, input.expected_status);
      }
      case "SYNTHESIZE_TOOL": {
        const input = SynthesizeToolInputSchema.parse(action.inputs);
        return this.synthesizeTool(input.capability, input.purpose, input.project_id, input.sample_input);
      }
      case "RUN_SYNTHESIZED_TOOL": {
        const input = RunSynthesizedToolInputSchema.parse(action.inputs);
        return this.runSynthesizedTool(action.id, input.tool_id, input.input);
      }
      case "OS_DEMO_CONTROL": {
        const input = OsDemoControlInputSchema.parse(action.inputs);
        return this.runOsDemoControl(action.id, input.scenario, input.text, input.duration_ms);
      }
      case "OS_INPUT_CONTROL": {
        const input = OsInputControlInputSchema.parse(action.inputs);
        const priorResult = (action.result && typeof action.result === "object")
          ? action.result as Record<string, unknown>
          : {};
        const resumeRaw = Number(priorResult.resume_step_index ?? 0);
        const resumeFromStep = Number.isFinite(resumeRaw) ? Math.max(0, Math.floor(resumeRaw)) : 0;
        const resumeReason = String(priorResult.paused_reason ?? "").trim();
        const runtimeSteps = this.parseStoredRuntimeSteps(priorResult.runtime_planned_steps);
        const stepsForRun = runtimeSteps.length > 0 ? runtimeSteps : input.steps;
        return this.runOsInputControl(action.id, input.objective, stepsForRun, input.dry_run, resumeFromStep, resumeReason);
      }
      default:
        throw new Error(`Unhandled action type: ${action.type}`);
    }
  }

  private simulateAction(action: PersistedAction): Record<string, unknown> {
    return {
      dry_run: true,
      simulated: true,
      action_id: action.id,
      action_type: action.type,
      message: `Simulated ${action.type} in dry-run mode. No external side effects were executed.`,
    };
  }

  private async executeScaffold(action: PersistedAction): Promise<Record<string, unknown>> {
    const input = ScaffoldNextJsInputSchema.parse(action.inputs);
    const projectDir = path.resolve(input.project_dir);
    const appDir = path.join(projectDir, "app");
    await fsp.mkdir(appDir, { recursive: true });

    const pkg = {
      name: input.offer_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      private: true,
      version: "0.1.0",
      scripts: { dev: "next dev", build: "next build", start: "next start" },
      dependencies: { next: "16.1.2", react: "19.2.3", "react-dom": "19.2.3" },
    };

    let changedFiles = 0;
    if (await this.writeFileIfChanged(path.join(projectDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)) changedFiles += 1;
    if (await this.writeFileIfChanged(path.join(projectDir, "next.config.ts"), "const nextConfig = {};\nexport default nextConfig;\n")) changedFiles += 1;
    if (await this.writeFileIfChanged(path.join(projectDir, "next-env.d.ts"), "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n")) changedFiles += 1;

    const tsconfig = {
      compilerOptions: {
        target: "ES2017",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "react-jsx",
        incremental: true,
        plugins: [{ name: "next" }],
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
      exclude: ["node_modules"],
    };
    if (await this.writeFileIfChanged(path.join(projectDir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`)) changedFiles += 1;

    if (await this.writeFileIfChanged(path.join(appDir, "layout.tsx"), "import './globals.css';\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body>{children}</body>\n    </html>\n  );\n}\n")) changedFiles += 1;
    if (await this.writeFileIfChanged(
      path.join(appDir, "globals.css"),
      "@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap');:root{--bg:#040b07;--ink:#dcffe9;--accent:#32f08b;--line:#1f4336;--muted:#94d9b2;}*{box-sizing:border-box;}body{margin:0;background:radial-gradient(56rem 34rem at 88% -22%,#1f7f4b4a 0%,transparent 58%),radial-gradient(52rem 32rem at -18% 42%,#1f7f4b33 0%,transparent 52%),var(--bg);color:var(--ink);font-family:'Space Grotesk','Segoe UI',sans-serif;}main{max-width:1080px;margin:0 auto;padding:2rem 1rem 2.8rem;}section{border:1px solid var(--line);border-radius:16px;padding:1.1rem;background:#0c1914;}h1,h2,h3{margin-top:0;}p{line-height:1.5;} .hero{display:grid;gap:1rem;grid-template-columns:1.2fr .8fr;} .pill{display:inline-block;border:1px solid #2f5f4b;border-radius:999px;padding:.22rem .62rem;color:var(--muted);font-size:.82rem;} .cta{display:inline-block;padding:.62rem 1rem;border-radius:10px;background:linear-gradient(180deg,#35f89a 0%,#1ed075 100%);color:#032112;text-decoration:none;font-weight:700;} .cards{display:grid;gap:.9rem;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:1rem;} .card{border:1px solid var(--line);border-radius:14px;background:#0b1612;padding:.85rem;} .muted{color:var(--muted);} @media (max-width:800px){.hero{grid-template-columns:1fr;}}",
    )) changedFiles += 1;

    const bullets = (input.bullets.length > 0 ? input.bullets : ["AI lead response", "Qualification routing", "Follow-up automation"])
      .map((item) => JSON.stringify(item))
      .join(", ");

    if (await this.writeFileIfChanged(
      path.join(appDir, "page.tsx"),
      `export default function Page() {\n  const bullets = [${bullets}];\n  return (\n    <main>\n      <section className=\"hero\">\n        <div>\n          <span className=\"pill\">Operator Site</span>\n          <h1 style={{ color: 'var(--accent)', marginTop: '0.7rem' }}>${input.offer_name}</h1>\n          <p>${input.offer_value}</p>\n          <p className=\"muted\">Built for ${input.niche} in ${input.city}.</p>\n          <a href=\"#contact\" className=\"cta\">Book Strategy Call</a>\n        </div>\n        <div className=\"card\">\n          <h3 style={{ color: 'var(--accent)' }}>What You Get</h3>\n          <p className=\"muted\">Human-approved AI execution for outreach, follow-up, and qualification workflows.</p>\n        </div>\n      </section>\n\n      <section style={{ marginTop: '1rem' }}>\n        <h2 style={{ color: 'var(--accent)' }}>Offer Breakdown</h2>\n        <div className=\"cards\">\n          {bullets.map((item) => (\n            <article key={item} className=\"card\">\n              <h3 style={{ color: 'var(--accent)' }}>{item}</h3>\n              <p className=\"muted\">Delivered by an approval-gated AI operator with auditable actions.</p>\n            </article>\n          ))}\n        </div>\n      </section>\n\n      <section id=\"contact\" style={{ marginTop: '1rem' }}>\n        <h2 style={{ color: 'var(--accent)' }}>Next Step</h2>\n        <p className=\"muted\">Reply with your target market and we will ship a custom rollout roadmap.</p>\n      </section>\n    </main>\n  );\n}\n`,
    )) changedFiles += 1;

    return { project_dir: projectDir, scaffolded: true, changed_files: changedFiles };
  }

  private async openUrls(urls: string[]): Promise<string[]> {
    const opened: string[] = [];
    for (const url of urls) {
      await open(url);
      opened.push(url);
    }
    return opened;
  }

  private async executeLocalResearch(query: string, maxResults: number, sources: string[]): Promise<Record<string, unknown>> {
    const endpoint = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(endpoint, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Research request failed with status ${response.status}`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const related = Array.isArray(payload.RelatedTopics) ? payload.RelatedTopics : [];
    const suggestions: string[] = [];
    for (const item of related) {
      if (typeof item === "object" && item && typeof (item as Record<string, unknown>).Text === "string") {
        suggestions.push(String((item as Record<string, unknown>).Text));
      } else if (typeof item === "object" && item && Array.isArray((item as Record<string, unknown>).Topics)) {
        for (const nested of (item as Record<string, unknown>).Topics as Array<Record<string, unknown>>) {
          if (typeof nested.Text === "string") suggestions.push(String(nested.Text));
        }
      }
      if (suggestions.length >= maxResults) break;
    }

    return {
      query,
      sources,
      results: suggestions.slice(0, maxResults),
      related_count: related.length,
    };
  }

  private parseCommand(command: string): { bin: string; args: string[] } {
    const parts = String(command || "")
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((part) => part.replace(/^"|"$/g, ""))
      .filter(Boolean) ?? [];
    if (parts.length === 0) throw new Error("Invalid command");
    return { bin: parts[0], args: parts.slice(1) };
  }

  private async isPortListening(port: number): Promise<boolean> {
    return await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(250, () => done(false));
    });
  }

  private async startLocalPreview(actionId: string, projectDir: string, command: string, port: number): Promise<Record<string, unknown>> {
    if (await this.isPortListening(port)) {
      this.logs.emitLog("info", "preview_already_running", `Preview already active on port ${port}`, {
        action_id: actionId,
        port,
      }, actionId);
      return {
        project_dir: path.resolve(projectDir),
        pid: -1,
        command,
        url: `http://127.0.0.1:${port}`,
        already_running: true,
      };
    }

    const parsed = this.parseCommand(command);
    const child = spawn(parsed.bin, parsed.args, {
      cwd: path.resolve(projectDir),
      shell: process.platform === "win32",
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    this.logs.emitLog("info", "preview_started", `Started preview process for ${projectDir}`, {
      action_id: actionId,
      pid: child.pid ?? -1,
      port,
    }, actionId);

    return {
      project_dir: path.resolve(projectDir),
      pid: child.pid ?? -1,
      command,
      url: `http://127.0.0.1:${port}`,
    };
  }

  private async writeFileIfChanged(filePath: string, content: string): Promise<boolean> {
    try {
      const existing = await fsp.readFile(filePath, "utf8");
      if (existing === content) return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code && code !== "ENOENT") throw error;
    }
    await fsp.writeFile(filePath, content, "utf8");
    return true;
  }

  private async checkServerHealth(url: string, expectedStatus: number): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    clearTimeout(timeout);
    if (res.status !== expectedStatus && !(expectedStatus === 200 && res.ok)) {
      throw new Error(`Health check failed for ${url}: expected ${expectedStatus}, got ${res.status}`);
    }
    return {
      url,
      status: res.status,
      expected_status: expectedStatus,
      ok: true,
    };
  }

  private loadToolLibrary(): ToolRecord[] {
    const raw = this.storage.getJsonSetting<ToolRecord[]>("tool_library_v1", []);
    return raw.map((item) => ToolRecordSchema.parse(item));
  }

  private saveToolLibrary(tools: ToolRecord[]): void {
    this.storage.setJsonSetting("tool_library_v1", tools);
  }

  private async synthesizeTool(
    capability: string,
    purpose: string,
    projectId?: string,
    sampleInput: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const tools = this.loadToolLibrary();
    const existing = tools.find((tool) => tool.capability === capability && tool.status === "ready");
    if (existing) {
      return { reused: true, tool: existing };
    }

    const toolsDir = path.join(DATA_DIR, "tools");
    await fsp.mkdir(toolsDir, { recursive: true });
    const toolId = `tool-${slugify(capability)}-${newId().slice(0, 8)}`;
    const entrypoint = path.join(toolsDir, `${toolId}.mjs`);
    const createdAt = nowIso();
    const script = [
      "const raw = process.argv[2] ?? \"{}\";",
      "let input;",
      "try { input = JSON.parse(raw); } catch { input = { raw }; }",
      `const capability = ${JSON.stringify(capability)};`,
      `const purpose = ${JSON.stringify(purpose)};`,
      "const output = {",
      "  ok: true,",
      "  capability,",
      "  purpose,",
      "  received_input: input,",
      "  message: `Executed synthesized tool for ${capability}`,\n  timestamp: new Date().toISOString(),",
      "};",
      "process.stdout.write(`${JSON.stringify(output)}\\n`);",
    ].join("\n");
    await fsp.writeFile(entrypoint, `${script}\n`, "utf8");

    const verification = await this.runCommand(`verify-${toolId}`, "node", [entrypoint, JSON.stringify(sampleInput ?? {})], path.dirname(entrypoint));
    if (verification.exit_code !== 0) {
      throw new Error(`Synthesized tool verification failed: ${verification.stderr}`);
    }

    const tool: ToolRecord = {
      id: toolId,
      name: capability.replace(/[^a-z0-9]+/gi, " ").trim() || capability,
      capability,
      purpose,
      entrypoint,
      project_id: projectId,
      created_at: createdAt,
      updated_at: createdAt,
      last_used_at: createdAt,
      success_count: 1,
      failure_count: 0,
      status: "ready",
      sandboxed: true,
      metadata: {
        synthesized: true,
      },
    };
    tools.push(tool);
    this.saveToolLibrary(tools);
    return { reused: false, tool, verification };
  }

  private async runSynthesizedTool(actionId: string, toolId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tools = this.loadToolLibrary();
    const index = tools.findIndex((tool) => tool.id === toolId && tool.status === "ready");
    if (index < 0) throw new Error(`Synthesized tool not found: ${toolId}`);
    const tool = tools[index];

    const result = await this.runCommand(actionId, "node", [tool.entrypoint, JSON.stringify(input ?? {})], path.dirname(tool.entrypoint), {
      tolerateFailure: false,
    });

    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(result.stdout.trim().split(/\r?\n/g).pop() ?? "{}");
    } catch {
      parsed = undefined;
    }

    tools[index] = {
      ...tool,
      last_used_at: nowIso(),
      updated_at: nowIso(),
      success_count: tool.success_count + 1,
    };
    this.saveToolLibrary(tools);

    return {
      tool_id: tool.id,
      tool_capability: tool.capability,
      output: parsed ?? result.stdout,
      command: result.command,
    };
  }

  private async runOsDemoControl(
    actionId: string,
    scenario: "cursor" | "full" | "smoke",
    text: string,
    durationMs: number,
  ): Promise<Record<string, unknown>> {
    if (scenario === "smoke") {
      const smokeSteps: OsInputStep[] = [
        { kind: "hotkey", keys: ["ctrl", "esc"] },
        { kind: "delay", ms: 260 },
        { kind: "type", text: "file explorer" },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 1100 },
        { kind: "hotkey", keys: ["alt", "d"] },
        { kind: "delay", ms: 120 },
        { kind: "type", text: "C:\\Windows\\System32" },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 980 },
        { kind: "move", x: 520, y: 330, duration_ms: 280 },
        { kind: "click", button: "left", count: 1 },
        { kind: "delay", ms: 110 },
        { kind: "click", button: "left", count: 2 },
        { kind: "delay", ms: 110 },
        { kind: "click", button: "right", count: 1 },
        { kind: "delay", ms: 110 },
        { kind: "drag", from_x: 420, from_y: 280, to_x: 760, to_y: 280, duration_ms: 640, button: "left" },
        { kind: "delay", ms: 110 },
        { kind: "scroll", delta: -420, repeats: 3, delay_ms: 90 },
        { kind: "delay", ms: 110 },
        { kind: "scroll", delta: 420, repeats: 2, delay_ms: 90 },
      ];

      const result = await this.runOsInputControl(actionId, "Deterministic desktop smoke sequence", smokeSteps, false);
      return {
        scenario,
        platform: process.platform,
        smoke: true,
        ...result,
      };
    }

    if (process.platform !== "win32") {
      const result = await this.runCommand(actionId, "node", [
        "-e",
        "console.log('OS demo control: non-Windows fallback executed');",
      ], process.cwd());
      return {
        scenario,
        platform: process.platform,
        fallback: true,
        result,
      };
    }

    const demoText = String(text || "Operator control demo is running.").replace(/\s+/g, " ").trim().slice(0, 200);
    const steps = Math.max(16, Math.floor(durationMs / 120));
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$signature = @'\n[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y);\n[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);\n'@;",
      "Add-Type -MemberDefinition $signature -Name MouseMover -Namespace Native;",
      "$w = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width;",
      "$h = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height;",
      "$cx = [Math]::Floor($w/2);",
      "$cy = [Math]::Floor($h/2);",
      "$radius = [Math]::Max(120, [Math]::Floor([Math]::Min($w,$h)/5));",
      `$steps = ${steps};`,
      "for($i=0; $i -lt $steps; $i++){",
      "  $ang = (2 * [Math]::PI * $i) / $steps;",
      "  $x = [int]($cx + [Math]::Cos($ang) * $radius);",
      "  $y = [int]($cy + [Math]::Sin($ang) * $radius);",
      "  [Native.MouseMover]::SetCursorPos($x, $y) | Out-Null;",
      "  Start-Sleep -Milliseconds 70;",
      "}",
      "if(\"" + scenario + "\" -eq \"full\"){",
      "  [Native.MouseMover]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero);",
      "  Start-Sleep -Milliseconds 40;",
      "  [Native.MouseMover]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero);",
      "  Start-Sleep -Milliseconds 120;",
      "  [Native.MouseMover]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero);",
      "  Start-Sleep -Milliseconds 40;",
      "  [Native.MouseMover]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero);",
      "}",
    ].join("\n");

    const result = await this.runPowerShellScript(actionId, script);

    return {
      scenario,
      text: demoText,
      duration_ms: durationMs,
      platform: process.platform,
      command: result.command,
      exit_code: result.exit_code,
    };
  }

  private buildInputPlanFromObjective(objective: string): OsInputStep[] {
    const source = String(objective || "").trim();
    const text = source.toLowerCase();
    const inferredUrl = this.inferObjectiveWebsiteUrl(source);
    const toInt = (value: string): number => Math.max(0, Math.floor(Number(value)));
    const normalizeText = (value: string): string => String(value || "").replace(/\s+/g, " ").trim();

    const extractQuoted = (raw: string): string | null => {
      const match = raw.match(/["']([^"']+)["']/);
      return match?.[1]?.trim() || null;
    };

    const planOpenApp = (target: string): OsInputStep[] => [
      { kind: "hotkey", keys: ["ctrl", "esc"] },
      { kind: "delay", ms: 260 },
      { kind: "type", text: target },
      { kind: "key", key: "enter" },
      { kind: "delay", ms: 1100 },
    ];

    const fillFromQuoted = source.match(/(?:type|enter|fill|write)\s+["']([^"']+)["']/i)?.[1]?.trim() ?? "";
    const fillFromTyped = source.match(/(?:type|write)\s+(.+?)\s+(?:in|into)\s+(?:the\s+)?(?:[a-z0-9_-]+\s+){0,3}(?:input(?:\s+box)?|field|textbox|form|search\s+bar|prompt\s+bar)/i)?.[1]?.trim() ?? "";
    const fillFromRaw = fillFromQuoted || fillFromTyped;
    const fillFromQuote = /^(text|value|something)$/i.test(fillFromRaw) ? "" : fillFromRaw;
    const fillIntoLabelMatch = source.match(/(?:type|write|enter|fill)\s+["']?([^"']+?)["']?\s+(?:in|into)\s+(?:the\s+)?([a-z0-9 _.-]{2,50})(?:\s+(?:field|box|input|bar|prompt))?/i);
    if (fillIntoLabelMatch) {
      const payloadText = normalizeText(fillIntoLabelMatch[1] || "");
      const label = normalizeText(fillIntoLabelMatch[2] || "");
      if (payloadText && label && !/^(input|field|textbox|form|search bar|prompt bar)$/i.test(label)) {
        return [
          { kind: "vision_click_text", text: label, alternatives: ["Search", "Message", "Compose", "Write a message"], button: "left", retries: 3 },
          { kind: "delay", ms: 130 },
          { kind: "type", text: payloadText },
        ];
      }
    }

    const dragMatch = source.match(/(?:drag|click and hold|hold and drag)\s+(?:from\s+)?(\d{1,5})\D+(\d{1,5})\D+(?:to\s+)?(\d{1,5})\D+(\d{1,5})/i);
    if (dragMatch) {
      return [
        {
          kind: "drag",
          from_x: toInt(dragMatch[1]),
          from_y: toInt(dragMatch[2]),
          to_x: toInt(dragMatch[3]),
          to_y: toInt(dragMatch[4]),
          duration_ms: 520,
          button: "left",
        },
      ];
    }

    const clickMatch = source.match(/(?:double\s+click|right\s+click|click)\s+(?:at\s+|on\s+)?(\d{1,5})\D+(\d{1,5})/i);
    if (clickMatch) {
      const isDouble = /double\s+click/i.test(source);
      const isRight = /right\s+click/i.test(source);
      return [
        { kind: "move", x: toInt(clickMatch[1]), y: toInt(clickMatch[2]), duration_ms: 180 },
        { kind: "click", button: isRight ? "right" : "left", count: isDouble ? 2 : 1 },
      ];
    }

    const moveMatch = source.match(/(?:move(?:\s+the)?\s+cursor(?:\s+to)?|cursor\s+to)\s+(\d{1,5})\D+(\d{1,5})/i);
    if (moveMatch) {
      return [{ kind: "move", x: toInt(moveMatch[1]), y: toInt(moveMatch[2]), duration_ms: 220 }];
    }

    if (/scroll/i.test(source)) {
      const repeatsRaw = Number(source.match(/(?:x|times?)\s*(\d{1,2})/i)?.[1] ?? source.match(/(\d{1,2})\s*(?:lines?|steps?)/i)?.[1] ?? "1");
      const repeats = Number.isFinite(repeatsRaw) ? Math.max(1, Math.min(20, Math.floor(repeatsRaw))) : 1;
      const down = /(down|bottom|next)/i.test(source);
      const up = /(up|top|previous)/i.test(source);
      const delta = up && !down ? 360 : -360;
      return [{ kind: "scroll", delta, repeats, delay_ms: 80 }];
    }

    const clickLabelMatch = source.match(/(?:click|tap|press)\s+(?:the\s+)?["']?([a-z][a-z0-9 _.-]{1,60})["']?(?:\s+(?:button|link|tab|menu|item|option|field|box|input))?/i);
    if (clickLabelMatch && !/\d{2,}/.test(clickLabelMatch[1])) {
      const label = normalizeText(clickLabelMatch[1] || "");
      if (label && !/^(mouse|cursor|screen)$/i.test(label)) {
        return [
          { kind: "vision_click_text", text: label, alternatives: ["Continue", "Open", "Search", "Send"], button: "left", retries: 3 },
        ];
      }
    }

    const url = source.match(/https?:\/\/\S+/i)?.[0] ?? "";
    if (url && fillFromQuote) {
      return [
        ...planOpenApp("chrome"),
        { kind: "hotkey", keys: ["ctrl", "l"] },
        { kind: "delay", ms: 120 },
        { kind: "type", text: url },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 1200 },
        { kind: "key", key: "tab" },
        { kind: "delay", ms: 120 },
        { kind: "key", key: "tab" },
        { kind: "delay", ms: 120 },
        { kind: "type", text: fillFromQuote },
      ];
    }

    if (fillFromQuote && /(input|field|textbox|form|search bar|prompt bar)/.test(text)) {
      return [
        { kind: "delay", ms: 600 },
        { kind: "key", key: "tab" },
        { kind: "delay", ms: 120 },
        { kind: "key", key: "tab" },
        { kind: "delay", ms: 120 },
        { kind: "type", text: fillFromQuote },
      ];
    }

    if (/^open\s+/.test(text)) {
      const target = source.replace(/^open\s+/i, "").trim();
      const targetUrl = target.match(/https?:\/\/\S+/i)?.[0] ?? this.inferObjectiveWebsiteUrl(target) ?? inferredUrl;

      if (target.includes("chrome")) {
        const steps = planOpenApp("chrome");
        if (targetUrl) {
          steps.push(
            { kind: "delay", ms: 550 },
            { kind: "hotkey", keys: ["ctrl", "l"] },
            { kind: "delay", ms: 100 },
            { kind: "type", text: targetUrl },
            { kind: "key", key: "enter" },
          );
        }
        return steps;
      }

      if (target.includes("notepad")) return planOpenApp("chrome");
      if (target.includes("explorer") || target.includes("file")) return planOpenApp("file explorer");
      return planOpenApp(target);
    }

    if (/create\s+(a\s+)?(new\s+)?folder/.test(text)) {
      const nameFromQuote = extractQuoted(source);
      const nameFromNamed = source.match(/named\s+(.+)$/i)?.[1]?.trim();
      const folderName = (nameFromQuote || nameFromNamed || `New Folder ${Date.now().toString().slice(-4)}`).slice(0, 80);
      return [
        { kind: "hotkey", keys: ["ctrl", "esc"] },
        { kind: "delay", ms: 250 },
        { kind: "type", text: "file explorer" },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 1100 },
        { kind: "hotkey", keys: ["ctrl", "shift", "n"] },
        { kind: "delay", ms: 220 },
        { kind: "type", text: folderName },
        { kind: "key", key: "enter" },
      ];
    }

    if (/(organize|sort|move)\b/.test(text) && /(downloads|desktop|documents)/.test(text) && /(file|files|pdf|png|jpg|jpeg|txt|doc|docx)/.test(text)) {
      const quoted = extractQuoted(source);
      const called = source.match(/(?:called|named)\s+([a-z0-9 _-]+)/i)?.[1]?.trim();
      const ext = text.includes("pdf") ? "pdf"
        : text.includes("png") ? "png"
        : text.includes("jpg") || text.includes("jpeg") ? "jpg"
        : text.includes("txt") ? "txt"
        : text.includes("docx") ? "docx"
        : text.includes("doc") ? "doc"
        : "";
      const folderName = (quoted || called || (ext ? ext.toUpperCase() : "Sorted Files")).slice(0, 60);
      const targetPath = text.includes("desktop")
        ? "%USERPROFILE%\\Desktop"
        : text.includes("documents")
          ? "%USERPROFILE%\\Documents"
          : "%USERPROFILE%\\Downloads";
      const pattern = ext ? `*.${ext}` : "*.*";

      return [
        { kind: "hotkey", keys: ["ctrl", "esc"] },
        { kind: "delay", ms: 250 },
        { kind: "type", text: "file explorer" },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 1050 },
        { kind: "hotkey", keys: ["ctrl", "l"] },
        { kind: "delay", ms: 120 },
        { kind: "type", text: targetPath },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 650 },
        { kind: "hotkey", keys: ["ctrl", "shift", "n"] },
        { kind: "delay", ms: 170 },
        { kind: "type", text: folderName },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 260 },
        { kind: "hotkey", keys: ["ctrl", "e"] },
        { kind: "delay", ms: 130 },
        { kind: "type", text: pattern },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 650 },
        { kind: "hotkey", keys: ["ctrl", "a"] },
        { kind: "delay", ms: 120 },
        { kind: "hotkey", keys: ["ctrl", "x"] },
        { kind: "delay", ms: 120 },
        { kind: "key", key: "esc" },
        { kind: "delay", ms: 120 },
        { kind: "type", text: folderName },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 300 },
        { kind: "hotkey", keys: ["ctrl", "v"] },
      ];
    }

    if (/^type\s+/.test(text)) {
      const body = source.replace(/^type\s+/i, "").trim();
      if (body) return [{ kind: "type", text: body }];
    }

    if (/^(press|hit)\s+/.test(text)) {
      const key = source.replace(/^(press|hit)\s+/i, "").trim();
      if (key) return [{ kind: "key", key }];
    }

    if (/test\s+(cursor|control|os|keyboard)/.test(text)) {
      return [
        { kind: "move", x: 220, y: 180, duration_ms: 150 },
        { kind: "delay", ms: 120 },
        { kind: "move", x: 360, y: 220, duration_ms: 180 },
        { kind: "delay", ms: 140 },
        { kind: "click", button: "left", count: 1 },
        { kind: "delay", ms: 110 },
        { kind: "click", button: "right", count: 1 },
        { kind: "delay", ms: 110 },
        { kind: "drag", from_x: 420, from_y: 280, to_x: 760, to_y: 280, duration_ms: 540, button: "left" },
        { kind: "delay", ms: 120 },
        { kind: "hotkey", keys: ["ctrl", "esc"] },
        { kind: "delay", ms: 180 },
        { kind: "key", key: "esc" },
      ];
    }

    const fallback: OsInputStep[] = [
      { kind: "hotkey", keys: ["ctrl", "esc"] },
      { kind: "delay", ms: 250 },
      { kind: "type", text: "chrome" },
      { kind: "key", key: "enter" },
      { kind: "delay", ms: 1100 },
      { kind: "hotkey", keys: ["ctrl", "l"] },
      { kind: "delay", ms: 120 },
    ];
    if (inferredUrl) {
      fallback.push(
        { kind: "type", text: inferredUrl },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 1200 },
      );
    }
    return fallback;
  }

  private inferObjectiveWebsiteUrl(objective: string): string | null {
    const source = String(objective || "").trim();
    if (!source) return null;
    const explicit = source.match(/https?:\/\/\S+/i)?.[0];
    if (explicit) return explicit;

    const text = source.toLowerCase();
    if (/(accounts\.google|google accounts|google account|sign in to google|google login)/.test(text)) return "https://accounts.google.com/";
    if (/(youtube|youtu\.be)/.test(text)) return "https://www.youtube.com/";
    if (/(instagram)/.test(text)) {
      if (/(dm|direct message|message|inbox|chat)/.test(text)) return "https://www.instagram.com/direct/inbox/";
      return "https://www.instagram.com/";
    }
    if (/(gmail|google mail|mail\.google)/.test(text)) return "https://mail.google.com/";
    if (/(linkedin)/.test(text)) return "https://www.linkedin.com/";
    if (/(facebook)/.test(text)) return "https://www.facebook.com/";
    if (/(twitter|x\.com)/.test(text)) return "https://x.com/";
    if (/(discord)/.test(text)) return "https://discord.com/channels/@me";
    if (/(slack)/.test(text)) return "https://app.slack.com/client";
    if (/(reddit)/.test(text)) return "https://www.reddit.com/";
    if (/(github)/.test(text)) return "https://github.com/";
    return null;
  }

  private isWebObjective(objective: string): boolean {
    const text = String(objective || "").toLowerCase();
    return /(https?:\/\/|www\.|chrome|browser|website|web page|webpage|instagram|gmail|google|linkedin|facebook|x\.com|twitter|discord|slack|youtube|reddit|github)/.test(text);
  }

  private isNavigationOnlyWebObjective(objective: string): boolean {
    const text = String(objective || "").toLowerCase();
    if (!this.isWebObjective(text)) return false;
    const navigationIntent = /(open|navigate|go to|visit|load|launch)/.test(text);
    const interactiveIntent = /(dm|direct message|message|inbox|compose|fill|form|field|search|type into|submit|login|sign in|click|drag|scroll|download|upload|send)/.test(text);
    const loginPageIntent = /(login page|sign in page|auth page|google accounts|accounts\.google)/.test(text);
    const explicitManualInputIntent = /(enter password|enter code|otp|2fa|captcha|submit credentials|type .*password)/.test(text);
    if (navigationIntent && loginPageIntent && !explicitManualInputIntent) return true;
    return navigationIntent && !interactiveIntent;
  }

  private isBlockedWebVisionTarget(rawText: string): boolean {
    const text = String(rawText || "").trim().toLowerCase();
    if (!text) return true;
    if (/\.exe$/.test(text)) return true;
    if (/^(new incognito window|incognito|new tab|new window|chrome|google chrome|chrome browser|browser|search)$/i.test(text)) return true;
    if (/^(reddit|google accounts login page|google accounts sign in)$/i.test(text)) return true;
    return false;
  }

  private normalizeProvidedWebPlan(
    objective: string,
    steps: OsInputStep[],
    origins: string[],
  ): { steps: OsInputStep[]; origins: string[] } {
    const inferredUrl = this.inferObjectiveWebsiteUrl(objective);
    const navigationOnly = this.isNavigationOnlyWebObjective(objective);
    const filteredPairs = steps
      .map((step, index) => ({ step, origin: origins[index] ?? "provided_plan" }))
      .filter(({ step }) => {
        if (step.kind === "hotkey") {
          const keys = step.keys.map((item) => String(item || "").trim().toLowerCase());
          const ctrlEsc = keys.includes("ctrl") && keys.includes("esc");
          const winLike = keys.includes("win") || keys.includes("windows") || keys.includes("meta");
          if (ctrlEsc || winLike) return false;
          const ctrlF = (keys.includes("ctrl") || keys.includes("control")) && keys.includes("f");
          if (ctrlF) return false;
          return true;
        }
        if (step.kind === "key") {
          const key = String(step.key || "").trim().toLowerCase();
          if (key === "esc") return false;
          return true;
        }
        if (step.kind === "type") {
          const text = String(step.text || "").trim().toLowerCase();
          if (/^(chrome|chrome\.exe|google chrome)$/.test(text)) return false;
          if (/^(file explorer|explorer|windows explorer)$/.test(text)) return false;
          if (/(^|[^a-z])(new tab|new window)([^a-z]|$)/.test(text)) return false;
          if (/^(https?:\/\/|www\.)/.test(text)) return false;
          return true;
        }
        if (step.kind === "vision_click_text") {
          const target = String(step.text || "").trim();
          if (navigationOnly) return false;
          if (this.isBlockedWebVisionTarget(target)) return false;
          return true;
        }
        return true;
      });

    const prefix: OsInputStep[] = [
      { kind: "type", text: "chrome" },
      { kind: "delay", ms: 420 },
    ];
    if (inferredUrl) {
      prefix.push(
        { kind: "hotkey", keys: ["ctrl", "l"] },
        { kind: "delay", ms: 120 },
        { kind: "type", text: inferredUrl },
        { kind: "key", key: "enter" },
        { kind: "delay", ms: 900 },
      );
    }

    const filteredSteps = this.sanitizeAdaptiveNextSteps(
      objective,
      filteredPairs.map((item) => item.step),
      [],
    );
    if (navigationOnly) {
      return {
        steps: prefix,
        origins: prefix.map(() => "provided_web_normalized"),
      };
    }

    const outSteps: OsInputStep[] = [...prefix];
    const outOrigins: string[] = prefix.map(() => "provided_web_normalized");
    for (const step of filteredSteps) {
      if (step.kind === "delay" && outSteps.length > 0 && outSteps[outSteps.length - 1]?.kind === "delay") continue;
      outSteps.push(step);
      outOrigins.push("provided_plan_sanitized");
    }
    return { steps: outSteps, origins: outOrigins };
  }

  private escapePowerShellLiteral(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private encodeSendKeysText(text: string): string {
    const escapeMap: Record<string, string> = {
      "+": "{+}",
      "^": "{^}",
      "%": "{%}",
      "~": "{~}",
      "(": "{(}",
      ")": "{)}",
      "[": "{[}",
      "]": "{]}",
      "{": "{{}",
      "}": "{}}",
    };

    let out = "";
    for (const ch of text) {
      if (ch === "\r") continue;
      if (ch === "\n") {
        out += "{ENTER}";
        continue;
      }
      if (ch === "\t") {
        out += "{TAB}";
        continue;
      }
      out += escapeMap[ch] ?? ch;
    }
    return out;
  }

  private keyToSendKeyToken(key: string): string {
    const normalized = String(key || "").trim().toLowerCase();
    const map: Record<string, string> = {
      enter: "{ENTER}",
      return: "{ENTER}",
      tab: "{TAB}",
      esc: "{ESC}",
      escape: "{ESC}",
      backspace: "{BACKSPACE}",
      delete: "{DELETE}",
      del: "{DELETE}",
      insert: "{INSERT}",
      home: "{HOME}",
      end: "{END}",
      up: "{UP}",
      down: "{DOWN}",
      left: "{LEFT}",
      right: "{RIGHT}",
      pageup: "{PGUP}",
      pgup: "{PGUP}",
      pagedown: "{PGDN}",
      pgdn: "{PGDN}",
      space: " ",
    };

    if (map[normalized]) return map[normalized];
    if (/^f([1-9]|1[0-2])$/.test(normalized)) return `{${normalized.toUpperCase()}}`;
    if (normalized.length === 1) return this.encodeSendKeysText(normalized);
    return this.encodeSendKeysText(normalized);
  }

  private hotkeyToSendKeyToken(keys: string[]): string {
    const normalized = keys.map((key) => String(key || "").trim().toLowerCase()).filter(Boolean);
    const hasWin = normalized.some((key) => key === "win" || key === "meta" || key === "windows");
    const nonModifiers = normalized.filter((key) => !["ctrl", "control", "alt", "shift", "win", "meta", "windows"].includes(key));

    let prefix = "";
    if (normalized.some((key) => key === "ctrl" || key === "control")) prefix += "^";
    if (normalized.includes("alt")) prefix += "%";
    if (normalized.includes("shift")) prefix += "+";

    if (hasWin && nonModifiers.length === 0) return "^{ESC}";
    if (hasWin && nonModifiers.length > 0) {
      return `^{ESC}${this.keyToSendKeyToken(nonModifiers[0])}`;
    }
    if (nonModifiers.length === 0) return prefix;
    return `${prefix}${this.keyToSendKeyToken(nonModifiers[0])}`;
  }

  private buildOsInputPowerShell(steps: OsInputStep[]): string {
    const lines: string[] = [
      "$ErrorActionPreference = 'Stop';",
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$signature = @\"",
      "[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y);",
      "[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);",
      "[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();",
      "\"@;",
      "Add-Type -MemberDefinition $signature -Name NativeInput -Namespace Operator;",
      "try { [Operator.NativeInput]::SetProcessDPIAware() | Out-Null; } catch {}",
      "$ws = New-Object -ComObject WScript.Shell;",
      "function Invoke-MouseClick {",
      "  param([string]$Button = 'left', [int]$Count = 1)",
      "  $down = if ($Button -eq 'right') { 0x0008 } else { 0x0002 };",
      "  $up = if ($Button -eq 'right') { 0x0010 } else { 0x0004 };",
      "  for($i = 0; $i -lt $Count; $i++) {",
      "    [Operator.NativeInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero);",
      "    Start-Sleep -Milliseconds 34;",
      "    [Operator.NativeInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero);",
      "    Start-Sleep -Milliseconds 80;",
      "  }",
      "}",
      "function Invoke-VisibleClick {",
      "  param([string]$Button = 'left', [int]$Count = 1)",
      "  $pos = [System.Windows.Forms.Cursor]::Position;",
      "  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
      "  $jitterX = [Math]::Min($bounds.Right - 2, [Math]::Max($bounds.Left + 1, [int]($pos.X + 12)));",
      "  $jitterY = [Math]::Min($bounds.Bottom - 2, [Math]::Max($bounds.Top + 1, [int]($pos.Y + 12)));",
      "  [Operator.NativeInput]::SetCursorPos($jitterX, $jitterY) | Out-Null;",
      "  Start-Sleep -Milliseconds 48;",
      "  [Operator.NativeInput]::SetCursorPos([int]$pos.X, [int]$pos.Y) | Out-Null;",
      "  Start-Sleep -Milliseconds 42;",
      "  Invoke-MouseClick -Button $Button -Count $Count;",
      "}",
      "function Invoke-MouseDrag {",
      "  param([int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY, [int]$DurationMs = 420, [string]$Button = 'left')",
      "  $down = if ($Button -eq 'right') { 0x0008 } else { 0x0002 };",
      "  $up = if ($Button -eq 'right') { 0x0010 } else { 0x0004 };",
      "  [Operator.NativeInput]::SetCursorPos($FromX, $FromY) | Out-Null;",
      "  Start-Sleep -Milliseconds 30;",
      "  [Operator.NativeInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero);",
      "  $steps = [Math]::Max(6, [Math]::Floor($DurationMs / 16));",
      "  for($i = 1; $i -le $steps; $i++) {",
      "    $x = [int]($FromX + (($ToX - $FromX) * $i / $steps));",
      "    $y = [int]($FromY + (($ToY - $FromY) * $i / $steps));",
      "    [Operator.NativeInput]::SetCursorPos($x, $y) | Out-Null;",
      "    Start-Sleep -Milliseconds ([Math]::Max(6, [Math]::Floor($DurationMs / $steps)));",
      "  }",
      "  [Operator.NativeInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero);",
      "  Start-Sleep -Milliseconds 90;",
      "}",
      "function Invoke-SendKeys {",
      "  param([string]$Keys)",
      "  $ws.SendKeys($Keys);",
      "  Start-Sleep -Milliseconds 90;",
      "}",
    ];

    for (const step of steps) {
      if (step.kind === "move") {
        lines.push(`[Operator.NativeInput]::SetCursorPos(${step.x}, ${step.y}) | Out-Null;`);
        lines.push(`Start-Sleep -Milliseconds ${Math.max(0, step.duration_ms)};`);
        continue;
      }

      if (step.kind === "drag") {
        const button = step.button === "right" ? "right" : "left";
        lines.push(
          `Invoke-MouseDrag -FromX ${step.from_x} -FromY ${step.from_y} -ToX ${step.to_x} -ToY ${step.to_y} -DurationMs ${Math.max(60, step.duration_ms)} -Button '${button}';`,
        );
        continue;
      }

      if (step.kind === "click") {
        const button = step.button === "right" ? "right" : "left";
        lines.push(`Invoke-VisibleClick -Button '${button}' -Count ${Math.max(1, step.count)};`);
        continue;
      }

      if (step.kind === "scroll") {
        const delta = Math.max(-2400, Math.min(2400, step.delta));
        const repeats = Math.max(1, Math.min(20, step.repeats));
        const delayMs = Math.max(0, Math.min(1000, step.delay_ms));
        lines.push(`for($i = 0; $i -lt ${repeats}; $i++) {`);
        lines.push(`  [Operator.NativeInput]::mouse_event(0x0800, 0, 0, ${delta}, [UIntPtr]::Zero);`);
        lines.push(`  Start-Sleep -Milliseconds ${delayMs};`);
        lines.push("}");
        continue;
      }

      if (step.kind === "type") {
        const token = this.encodeSendKeysText(step.text);
        lines.push(`Invoke-SendKeys -Keys ${this.escapePowerShellLiteral(token)};`);
        continue;
      }

      if (step.kind === "key") {
        const token = this.keyToSendKeyToken(step.key);
        lines.push(`Invoke-SendKeys -Keys ${this.escapePowerShellLiteral(token)};`);
        continue;
      }

      if (step.kind === "hotkey") {
        const token = this.hotkeyToSendKeyToken(step.keys);
        if (token) {
          lines.push(`Invoke-SendKeys -Keys ${this.escapePowerShellLiteral(token)};`);
        }
        continue;
      }

      if (step.kind === "delay") {
        lines.push(`Start-Sleep -Milliseconds ${Math.max(10, step.ms)};`);
      }
    }

    return lines.join("\n");
  }

  private isCtrlEscStartSequence(step: OsInputStep | undefined): boolean {
    if (!step || step.kind !== "hotkey") return false;
    const keys = step.keys.map((item) => String(item || "").trim().toLowerCase());
    return keys.length === 2 && keys.includes("ctrl") && keys.includes("esc");
  }

  private isAddressBarFocusHotkey(step: OsInputStep | undefined): boolean {
    if (!step || step.kind !== "hotkey") return false;
    const keys = step.keys.map((item) => String(item || "").trim().toLowerCase());
    if (keys.length !== 2) return false;
    return (keys.includes("ctrl") && keys.includes("l")) || (keys.includes("alt") && keys.includes("d"));
  }

  private hasRecentAddressBarFocus(steps: OsInputStep[], index: number): boolean {
    const start = Math.max(0, index - 3);
    for (let i = start; i < index; i += 1) {
      if (this.isAddressBarFocusHotkey(steps[i])) return true;
    }
    return false;
  }

  private resolveDirectLaunchExecutable(raw: string): string | null {
    const normalized = String(raw || "").trim().toLowerCase();
    if (!normalized) return null;
    if (/^(chrome|google chrome)$/.test(normalized)) return "chrome.exe";
    if (/^(file explorer|explorer|windows explorer)$/.test(normalized)) return "explorer.exe";
    if (/^(edge|microsoft edge)$/.test(normalized)) return "msedge.exe";
    return null;
  }

  private shouldAttemptDirectLaunch(
    objective: string,
    step: Extract<OsInputStep, { kind: "type" }>,
    prevStep: OsInputStep | undefined,
    stepIndex: number,
  ): boolean {
    if (!this.resolveDirectLaunchExecutable(step.text)) return false;
    if (this.isCtrlEscStartSequence(prevStep)) return true;
    if (this.isWebObjective(objective) && stepIndex <= 2) return true;
    return false;
  }

  private async verifyInteractiveInputChannel(actionId: string): Promise<void> {
    if (process.platform !== "win32") return;
    const script = [
      "$ErrorActionPreference = 'Stop';",
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$native = @\"",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class OperatorInputProbe {",
      "  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }",
      "  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y);",
      "  [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out POINT lpPoint);",
      "  [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();",
      "}",
      "\"@;",
      "try { Add-Type -TypeDefinition $native -Language CSharp -ErrorAction Stop | Out-Null; } catch {}",
      "try { [OperatorInputProbe]::SetProcessDPIAware() | Out-Null; } catch {}",
      "$start = New-Object OperatorInputProbe+POINT;",
      "if (-not [OperatorInputProbe]::GetCursorPos([ref]$start)) { throw 'cursor_read_failed'; }",
      "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
      "$targetX = [Math]::Min($bounds.Right - 2, [Math]::Max($bounds.Left + 1, $start.X + 4));",
      "$targetY = [Math]::Min($bounds.Bottom - 2, [Math]::Max($bounds.Top + 1, $start.Y + 4));",
      "[OperatorInputProbe]::SetCursorPos([int]$targetX, [int]$targetY) | Out-Null;",
      "Start-Sleep -Milliseconds 26;",
      "$after = New-Object OperatorInputProbe+POINT;",
      "if (-not [OperatorInputProbe]::GetCursorPos([ref]$after)) { throw 'cursor_read_after_failed'; }",
      "$dx = [Math]::Abs($after.X - [int]$targetX);",
      "$dy = [Math]::Abs($after.Y - [int]$targetY);",
      "[OperatorInputProbe]::SetCursorPos($start.X, $start.Y) | Out-Null;",
      "if ($dx -gt 2 -or $dy -gt 2) { throw \"cursor_move_blocked:$($after.X),$($after.Y)\"; }",
      "Write-Output '{\"ok\":true}'",
    ].join("\n");
    try {
      await this.runPowerShellScript(actionId, script, {
        sensitive: true,
        displayCommand: "powershell [input-channel-check]",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Desktop input channel is not writable (${reason}). Run the agent in the active Windows user session, keep the desktop unlocked, and avoid elevated/UAC secure prompts.`,
      );
    }
  }

  private shouldWatchForLoginGate(objective: string, steps: OsInputStep[]): boolean {
    if (!this.loginGateDetectionEnabled) return false;
    const hasWebLikeSteps = steps.some((step) => {
      if (step.kind === "vision_click_text") return true;
      if (step.kind === "type") {
        return /(https?:\/\/|www\.|instagram\.com|google\.com|gmail|mail\.google\.com|accounts\.google\.com|linkedin\.com|facebook\.com|x\.com|twitter\.com|discord\.com|slack\.com)/i.test(step.text);
      }
      if (step.kind === "hotkey") {
        const keys = step.keys.map((key) => String(key || "").trim().toLowerCase());
        return (keys.includes("ctrl") && keys.includes("l")) || (keys.includes("alt") && keys.includes("d"));
      }
      return false;
    });
    if (hasWebLikeSteps) return true;
    const text = String(objective || "").toLowerCase();
    return /(website|web page|webpage|browser|chrome|instagram|gmail|google|linkedin|facebook|x\.com|twitter|discord|slack)/.test(text);
  }

  private stepCanTriggerLoginGateCheck(step: OsInputStep): boolean {
    if (step.kind === "vision_click_text" || step.kind === "click" || step.kind === "scroll") return true;
    if (step.kind === "key") return /^(enter|tab)$/i.test(step.key);
    return false;
  }

  private shouldUseAdaptiveOsLoop(objective: string, providedSteps: OsInputStep[]): boolean {
    if (!this.adaptiveOsLoopEnabled) return false;
    if (providedSteps.length === 0) return true;
    const text = String(objective || "").toLowerCase();
    return /(chrome|browser|website|web page|webpage|instagram|gmail|google|linkedin|facebook|x\.com|twitter|discord|slack|message|dm|inbox|search|form|field|click|scroll|drag)/.test(text);
  }

  private async requestAdaptiveStepsFromVision(
    objective: string,
    executedSummaries: string[],
    remainingStepCount: number,
  ): Promise<{
    done: boolean;
    reason: string;
    nextSteps: OsInputStep[];
    vision_parse: Record<string, unknown> | null;
    vision_analysis: string;
    screenshot_path?: string;
    model?: string;
  }> {
    const recent = executedSummaries.slice(-8).join(" | ").slice(0, 900);
    const prompt = [
      "Return JSON only.",
      "You are planning ONLY the immediate next UI actions for a desktop operator.",
      "This is a continuous loop: perceive screen -> decide tiny next steps -> execute -> reassess.",
      "Do not output a full workflow. Output only the next 1-4 steps.",
      "Set done=true only if objective is already achieved on screen.",
      "Never use ctrl+f or browser-page search for task completion.",
      "If objective targets a specific app/site, do not drift into generic search engines or search-result pages.",
      "For web/browser tasks, do not emit raw move/click coordinate guesses; use vision_click_text or ctrl+l URL navigation.",
      "Never emit placeholder coordinates like x=0 or y=0.",
      "Do not emit pseudo-step kinds like wait/sleep. Use delay only when needed.",
      "If the same target failed recently, choose a different visible control instead of repeating it.",
      "When objective includes a concrete website, prefer ctrl+l + URL navigation over search-engine detours.",
      "Prefer vision_click_text for targeting visible UI controls and fields.",
      "Allowed step kinds with schema:",
      "move:{\"kind\":\"move\",\"x\":number,\"y\":number,\"duration_ms\":number}",
      "drag:{\"kind\":\"drag\",\"from_x\":number,\"from_y\":number,\"to_x\":number,\"to_y\":number,\"duration_ms\":number,\"button\":\"left|right\"}",
      "click:{\"kind\":\"click\",\"button\":\"left|right\",\"count\":1|2|3}",
      "scroll:{\"kind\":\"scroll\",\"delta\":number,\"repeats\":number,\"delay_ms\":number}",
      "vision_click_text:{\"kind\":\"vision_click_text\",\"text\":\"...\",\"alternatives\":[\"...\"],\"button\":\"left|right\",\"retries\":1-6}",
      "type:{\"kind\":\"type\",\"text\":\"...\"}",
      "key:{\"kind\":\"key\",\"key\":\"enter|tab|esc|...\"}",
      "hotkey:{\"kind\":\"hotkey\",\"keys\":[\"ctrl\",\"esc\"]}",
      "delay:{\"kind\":\"delay\",\"ms\":number}",
      "Output schema:",
      "{\"done\":true|false,\"reason\":\"short reason\",\"next_steps\":[...]}",
      `Objective: ${String(objective || "").slice(0, 260)}`,
      `Already executed recent steps: ${recent || "none"}`,
      `Current queued remaining steps: ${remainingStepCount}`,
    ].join("\n");

    try {
      const analysis = await this.analyzeScreenWithOllama(prompt, undefined, { force_json: true });
      const parsed = this.parseJsonObjectFromText(String(analysis.analysis ?? ""));
      if (!parsed) {
        return {
          done: false,
          reason: "adaptive_parse_failed",
          nextSteps: [],
          vision_parse: null,
          vision_analysis: String(analysis.analysis ?? ""),
          screenshot_path: String(analysis.screenshot_path ?? "") || undefined,
          model: String(analysis.model ?? "") || undefined,
        };
      }

      const doneRaw = Boolean(parsed.done);
      let reason = String(parsed.reason ?? "").trim() || (doneRaw ? "objective appears complete" : "next steps suggested");
      const rawSteps = Array.isArray(parsed.next_steps) ? parsed.next_steps : [];
      const nextSteps = rawSteps
        .map((item) => {
          try {
            return OsInputStepSchema.parse(item);
          } catch {
            return null;
          }
        })
        .filter((item): item is OsInputStep => Boolean(item))
        .slice(0, 4);

      let sanitized = this.sanitizeAdaptiveNextSteps(objective, nextSteps, executedSummaries);
      if (!doneRaw && sanitized.length === 0) {
        const recovery = this.buildAdaptiveRecoverySteps(objective, executedSummaries);
        if (recovery.length > 0) {
          sanitized = recovery;
          reason = `recovery:${reason.slice(0, 120)}`;
        }
      }
      const inferredUrl = this.inferObjectiveWebsiteUrl(objective);
      const executedLower = executedSummaries.join(" ").toLowerCase();
      const navigationSubmitted = Boolean(
        inferredUrl
        && this.isNavigationOnlyWebObjective(objective)
        && (executedLower.includes(inferredUrl.toLowerCase()) || /focus address bar.*type url/.test(executedLower)),
      );
      const done = doneRaw
        && sanitized.length === 0
        && this.isAdaptiveDonePlausible(objective, reason, executedSummaries, String(analysis.analysis ?? ""));
      const doneByNavigation = !doneRaw && sanitized.length === 0 && navigationSubmitted;
      return {
        done: done || doneByNavigation,
        reason,
        nextSteps: sanitized,
        vision_parse: parsed,
        vision_analysis: String(analysis.analysis ?? ""),
        screenshot_path: String(analysis.screenshot_path ?? "") || undefined,
        model: String(analysis.model ?? "") || undefined,
      };
    } catch {
      return {
        done: false,
        reason: "adaptive_unavailable",
        nextSteps: [],
        vision_parse: null,
        vision_analysis: "",
      };
    }
  }

  private isAdaptiveDonePlausible(
    objective: string,
    reason: string,
    executedSummaries: string[],
    visionAnalysis: string,
  ): boolean {
    const obj = String(objective || "").toLowerCase();
    const why = String(reason || "").toLowerCase();
    const executed = executedSummaries.join(" ").toLowerCase();
    const vision = String(visionAnalysis || "").toLowerCase();
    const combined = `${why} ${executed} ${vision}`;

    if (/(google search result|bing search result|duckduckgo|search results page|opened search page|results for)/.test(combined)) return false;
    if (/(still loading|unknown|unclear|not sure|cannot determine)/.test(combined)) return false;
    if (/(instagram|direct message| dm |message someone|inbox)/.test(` ${obj} `)) {
      const hasSendSignal = /(message sent|sent dm|chat opened|conversation opened|typed message|send button|message box focused)/.test(combined);
      if (!hasSendSignal) return false;
    }
    if (/(login|sign in|authenticate)/.test(` ${obj} `)) {
      const hasAuthSignal = /(signed in|authenticated|account home|dashboard|inbox|home feed)/.test(combined);
      if (!hasAuthSignal) return false;
    }
    if (/(instagram|gmail|linkedin|facebook|x\.com|twitter|discord|slack)/.test(obj)) {
      const hasTargetContext = /(instagram|gmail|google mail|linkedin|facebook|x\.com|twitter|discord|slack|inbox|dm|message)/.test(combined);
      if (!hasTargetContext) return false;
    }
    if (/(youtube|youtu\.be)/.test(obj)) {
      const hasYoutubeSignal = /(youtube|watch|video|channel)/.test(combined);
      if (!hasYoutubeSignal) return false;
    }
    return true;
  }

  private sanitizeAdaptiveNextSteps(objective: string, steps: OsInputStep[], executedSummaries: string[] = []): OsInputStep[] {
    const obj = String(objective || "").toLowerCase();
    const executed = executedSummaries.join(" ").toLowerCase();
    const objectiveWords = obj.split(/[^a-z0-9]+/g).filter((w) => w.length >= 4).slice(0, 12);
    const objectiveHasConcreteTarget = /(https?:\/\/|instagram|gmail|linkedin|facebook|x\.com|twitter|discord|slack|youtube|explorer)/.test(obj);
    const webObjective = this.isWebObjective(objective);
    const navigationOnlyWebObjective = this.isNavigationOnlyWebObjective(objective);
    const explicitPointerObjective = /(drag|scroll|right click|double click|move cursor|click at|coordinates?|\bxy\b)/.test(obj);
    const browserLikelyOpen = /(launch app directly: chrome\.exe|focus address bar and type url|vision target .* clicked|press hotkey: ctrl\+l|type url:|youtube|instagram|gmail|linkedin|facebook|x\.com|twitter|discord|slack)/.test(executed);
    const objectiveMentionsNotepad = /\bnotepad\b/.test(obj);
    return steps.filter((step) => {
      if (step.kind === "move") {
        if (step.x <= 2 && step.y <= 2) return false;
        if (webObjective && !explicitPointerObjective) return false;
        return true;
      }
      if (step.kind === "click") {
        if (webObjective && !explicitPointerObjective) return false;
        return true;
      }
      if (step.kind === "drag") {
        if (!explicitPointerObjective) return false;
        return true;
      }
      if (step.kind === "scroll") {
        if (!explicitPointerObjective && !/\bscroll\b/.test(obj)) return false;
        return true;
      }
      if (step.kind === "hotkey") {
        const keys = step.keys.map((item) => String(item || "").trim().toLowerCase());
        const ctrlF = (keys.includes("ctrl") || keys.includes("control")) && keys.includes("f");
        if (ctrlF) return false;
        if (navigationOnlyWebObjective) {
          const addressFocus = (keys.includes("ctrl") && keys.includes("l")) || (keys.includes("alt") && keys.includes("d"));
          if (!addressFocus) return false;
        }
        if (webObjective && browserLikelyOpen && keys.includes("ctrl") && keys.includes("esc")) return false;
        return true;
      }
      if (step.kind === "key") {
        const key = String(step.key || "").trim().toLowerCase();
        if (navigationOnlyWebObjective && key !== "enter") return false;
        if (webObjective && key === "esc") return false;
        return true;
      }
      if (step.kind === "vision_click_text") {
        if (navigationOnlyWebObjective) return false;
        const target = String(step.text || "").toLowerCase();
        const trimmedTarget = String(step.text || "").trim();
        if (objectiveHasConcreteTarget && /(google|bing|duckduckgo|search results|search web|web search)/.test(target)) return false;
        if (/^(click|button|next step|continue action)$/i.test(String(step.text || "").trim())) return false;
        if (webObjective && this.isBlockedWebVisionTarget(trimmedTarget)) return false;
        if (/(instagram|gmail|linkedin|facebook|x\.com|twitter|discord|slack|message|dm|inbox)/.test(obj)) {
          if (/(google|bing|duckduckgo|search results)/.test(target)) return false;
        }
        if (/(instagram|dm|direct message|inbox)/.test(obj)) {
          if (/^(instagram|google chrome|chrome|browser)$/i.test(trimmedTarget)) return false;
        }
        return true;
      }
      if (step.kind !== "type") return true;
      const text = String(step.text || "").trim().toLowerCase();
      if (!text) return false;
      if (/^(https?:\/\/|www\.)/.test(text)) {
        if (navigationOnlyWebObjective && executed.includes(text)) return false;
        return true;
      }
      if (navigationOnlyWebObjective) return false;
      if (/^notepad(\.exe)?$/.test(text) && !objectiveMentionsNotepad) return false;
      if (webObjective && browserLikelyOpen && /^(chrome|chrome\.exe|google chrome|file explorer|explorer|notepad|notepad\.exe)$/.test(text)) {
        return false;
      }

      if (/(google|bing|duckduckgo|search for|search:)/.test(text) && /(instagram|gmail|linkedin|facebook|x\.com|twitter|discord|slack|message|dm)/.test(obj)) {
        return false;
      }
      if (objectiveHasConcreteTarget && /https?:\/\/(www\.)?(google\.com|bing\.com|duckduckgo\.com)/.test(text)) {
        return false;
      }

      const overlap = objectiveWords.filter((word) => text.includes(word)).length;
      if (text.length > 30 && overlap >= 3) {
        return false;
      }

      return true;
    });
  }

  private buildAdaptiveRecoverySteps(objective: string, executedSummaries: string[]): OsInputStep[] {
    if (!this.isWebObjective(objective)) return [];
    const url = this.inferObjectiveWebsiteUrl(objective);
    if (!url) return [];
    const executed = executedSummaries.join(" ").toLowerCase();
    const recentUrlNav = executed.includes(url.toLowerCase()) || /focus address bar.*type url/.test(executed);
    if (recentUrlNav) return [];
    return [
      { kind: "hotkey", keys: ["ctrl", "l"] },
      { kind: "delay", ms: 120 },
      { kind: "type", text: url },
      { kind: "key", key: "enter" },
    ];
  }

  private async detectLoginGateViaUiAutomation(actionId: string): Promise<{
    detected: boolean;
    confidence: number;
    score: number;
    reason: string;
    signals: Record<string, number>;
    parse?: Record<string, unknown>;
  }> {
    if (process.platform !== "win32") {
      return {
        detected: false,
        confidence: 0,
        score: 0,
        reason: "uia_login_probe_unavailable_non_windows",
        signals: {},
      };
    }
    const script = [
      "Add-Type -AssemblyName UIAutomationClient;",
      "Add-Type -AssemblyName UIAutomationTypes;",
      "$native = @\"",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class OperatorNativeWin {",
      "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
      "  [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();",
      "}",
      "\"@;",
      "try { Add-Type -TypeDefinition $native -Language CSharp -ErrorAction Stop | Out-Null; } catch {}",
      "try { [OperatorNativeWin]::SetProcessDPIAware() | Out-Null; } catch {}",
      "function Normalize([string]$value) {",
      "  if ([string]::IsNullOrWhiteSpace($value)) { return ''; }",
      "  return ([regex]::Replace($value.ToLowerInvariant(), '[^a-z0-9]+', ''));",
      "}",
      "$root = $null;",
      "try {",
      "  $hwnd = [OperatorNativeWin]::GetForegroundWindow();",
      "  if ($hwnd -ne [IntPtr]::Zero) {",
      "    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd);",
      "  }",
      "} catch {}",
      "if ($null -eq $root) {",
      "  $root = [System.Windows.Automation.AutomationElement]::RootElement;",
      "}",
      "if ($null -eq $root) {",
      "  Write-Output '{\"detected\":false,\"confidence\":0,\"score\":0,\"reason\":\"uia_root_unavailable\",\"signals\":{}}';",
      "  exit 0;",
      "}",
      "try {",
      "  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition);",
      "} catch {",
      "  Write-Output '{\"detected\":false,\"confidence\":0,\"score\":0,\"reason\":\"uia_tree_failed\",\"signals\":{}}';",
      "  exit 0;",
      "}",
      "$password = 0;",
      "$action = 0;",
      "$challenge = 0;",
      "$identity = 0;",
      "$visible = 0;",
      "for ($i = 0; $i -lt $all.Count; $i++) {",
      "  $el = $all.Item($i);",
      "  if ($null -eq $el) { continue; }",
      "  try {",
      "    $rect = $el.Current.BoundingRectangle;",
      "    if ($rect.Width -lt 2 -or $rect.Height -lt 2) { continue; }",
      "    if ($el.Current.IsOffscreen) { continue; }",
      "    $visible += 1;",
      "    $name = [string]$el.Current.Name;",
      "    $help = [string]$el.Current.HelpText;",
      "    $aid = [string]$el.Current.AutomationId;",
      "    $value = Normalize(\"$name $help $aid\");",
      "    if (-not $value) { continue; }",
      "    $ctype = [string]$el.Current.ControlType.ProgrammaticName;",
      "    if (($ctype -match 'ControlType.Edit') -and ($value -match '(password|passcode|passkey|otp|verificationcode|securitycode|2fa|twofactor)')) {",
      "      $password += 1;",
      "    }",
      "    if ($value -match '(signin|login|continue|next|verify|useanotheraccount|chooseanaccount)') {",
      "      $action += 1;",
      "    }",
      "    if ($value -match '(captcha|notarobot|challenge|twofactor|verificationcode|authenticator|securitycheck)') {",
      "      $challenge += 1;",
      "    }",
      "    if ($value -match '(emailorphone|username|account|phonenumber|emailaddress)') {",
      "      $identity += 1;",
      "    }",
      "  } catch {}",
      "}",
      "$score = ($password * 3) + ($action * 2) + ($challenge * 4) + $identity;",
      "$detected = $false;",
      "if ((($password -gt 0 -and $action -gt 0) -or ($challenge -gt 0 -and ($action -gt 0 -or $password -gt 0))) -and $score -ge 5) {",
      "  $detected = $true;",
      "}",
      "$confidence = [Math]::Min(0.99, [Math]::Max(0.05, ($score / 12)));",
      "$out = @{",
      "  detected = $detected;",
      "  confidence = [Math]::Round($confidence, 3);",
      "  score = $score;",
      "  reason = 'uia_login_probe';",
      "  signals = @{ password = $password; action = $action; challenge = $challenge; identity = $identity; visible = $visible };",
      "};",
      "Write-Output (ConvertTo-Json $out -Compress);",
    ].join("\n");

    try {
      const result = await this.runPowerShellScript(actionId, script, {
        sensitive: true,
        displayCommand: "powershell [uia-login-probe]",
      });
      const parsed = this.parseJsonObjectFromText(result.stdout);
      if (!parsed) {
        return {
          detected: false,
          confidence: 0,
          score: 0,
          reason: "uia_login_probe_parse_failed",
          signals: {},
        };
      }
      const detected = Boolean(parsed.detected);
      const confidenceRaw = Number(parsed.confidence ?? 0);
      const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
      const scoreRaw = Number(parsed.score ?? 0);
      const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.floor(scoreRaw)) : 0;
      const rawSignals = (parsed.signals && typeof parsed.signals === "object")
        ? parsed.signals as Record<string, unknown>
        : {};
      const signals: Record<string, number> = {};
      for (const key of ["password", "action", "challenge", "identity", "visible"]) {
        const value = Number(rawSignals[key] ?? 0);
        if (Number.isFinite(value)) signals[key] = Math.max(0, Math.floor(value));
      }
      return {
        detected,
        confidence,
        score,
        reason: String(parsed.reason ?? "uia_login_probe"),
        signals,
        parse: parsed,
      };
    } catch (error) {
      return {
        detected: false,
        confidence: 0,
        score: 0,
        reason: error instanceof Error ? error.message : String(error),
        signals: {},
      };
    }
  }

  private async detectLoginGateOnScreen(objective: string): Promise<{
    detected: boolean;
    confidence: number;
    reason: string;
    provider?: string;
    screenshot_path?: string;
    parse?: Record<string, unknown>;
  }> {
    const uia = await this.detectLoginGateViaUiAutomation("login_gate_probe");
    const prompt = [
      "Return JSON only.",
      "Determine whether the current screen is blocked by a login/authentication checkpoint requiring human sign-in.",
      "Set login_detected=true only when the current task cannot continue without auth (sign in form, password prompt, account chooser, 2FA code, captcha, passkey prompt).",
      "If the user is already inside the app and can continue working, set login_detected=false.",
      "Schema: {\"login_detected\":true|false,\"blocked_by_auth\":true|false,\"confidence\":0-1,\"reason\":\"...\",\"provider\":\"optional\"}",
      `Objective: ${String(objective || "").slice(0, 180)}`,
    ].join("\n");

    try {
      const analysis = await this.analyzeScreenWithOllama(prompt, undefined, { force_json: true });
      const parsed = this.parseJsonObjectFromText(String(analysis.analysis ?? ""));
      if (parsed) {
        const visionDetected = Boolean(parsed.login_detected);
        const blocked = Boolean(parsed.blocked_by_auth ?? parsed.login_detected);
        const confidenceRaw = Number(parsed.confidence ?? 0);
        const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
        const reason = String(parsed.reason ?? "").trim() || (visionDetected ? "Authentication screen detected" : "No login blocker detected");
        const provider = String(parsed.provider ?? "").trim() || undefined;
        const reasonSignal = reason.toLowerCase();
        const hasAuthLanguage = /(sign[\s-]?in|login|password|passkey|captcha|2fa|two[-\s]?factor|verification|authenticate|account chooser)/.test(reasonSignal);
        const visionStrong = visionDetected && blocked && confidence >= 0.82 && hasAuthLanguage;
        const uiaStrong = uia.detected && uia.confidence >= 0.62;
        const detected = Boolean(uiaStrong || visionStrong);
        const combinedConfidence = detected
          ? Math.max(confidence, uia.confidence)
          : Math.max(confidence * 0.6, uia.confidence * 0.6);
        const combinedReason = detected
          ? (
            uiaStrong
              ? `UI automation login probe detected auth gate (${uia.reason}). Vision: ${reason}`
              : reason
          )
          : reason;
        if (detected) {
          return {
            detected: true,
            confidence: combinedConfidence,
            reason: combinedReason,
            provider,
            screenshot_path: String(analysis.screenshot_path ?? ""),
            parse: {
              vision: parsed,
              uia: {
                detected: uia.detected,
                confidence: uia.confidence,
                score: uia.score,
                reason: uia.reason,
                signals: uia.signals,
              },
            },
          };
        }
        return {
          detected: false,
          confidence: combinedConfidence,
          reason: combinedReason,
          provider,
          screenshot_path: String(analysis.screenshot_path ?? ""),
          parse: {
            vision: parsed,
            uia: {
              detected: uia.detected,
              confidence: uia.confidence,
              score: uia.score,
              reason: uia.reason,
              signals: uia.signals,
            },
          },
        };
      }
      return {
        detected: uia.detected && uia.confidence >= 0.7,
        confidence: Math.max(0, Math.min(1, uia.confidence)),
        reason: "Vision login parser returned no structured result",
        screenshot_path: String(analysis.screenshot_path ?? ""),
        parse: {
          uia: {
            detected: uia.detected,
            confidence: uia.confidence,
            score: uia.score,
            reason: uia.reason,
            signals: uia.signals,
          },
        },
      };
    } catch {
      return {
        detected: uia.detected && uia.confidence >= 0.74,
        confidence: Math.max(0, Math.min(1, uia.confidence)),
        reason: "Vision login detection unavailable",
        parse: {
          uia: {
            detected: uia.detected,
            confidence: uia.confidence,
            score: uia.score,
            reason: uia.reason,
            signals: uia.signals,
          },
        },
      };
    }
  }

  private firstEnvValue(keys: string[]): string {
    for (const key of keys) {
      const value = String(process.env[key] || "").trim();
      if (value) return value;
    }
    return "";
  }

  private resolveAutoLoginCredentials(objective: string, providerHint?: string): {
    provider: string;
    username: string;
    password: string;
  } | null {
    const signal = `${String(providerHint || "")} ${String(objective || "")}`.toLowerCase();
    const genericUser = this.firstEnvValue(["OPERATOR_LOGIN_USERNAME", "OPERATOR_LOGIN_EMAIL", "OPERATOR_LOGIN_USER"]);
    const genericPass = this.firstEnvValue(["OPERATOR_LOGIN_PASSWORD"]);

    const byProvider = (provider: string, userKeys: string[], passKeys: string[]) => {
      const username = this.firstEnvValue([...userKeys, "OPERATOR_LOGIN_USERNAME", "OPERATOR_LOGIN_EMAIL", "OPERATOR_LOGIN_USER"]);
      const password = this.firstEnvValue([...passKeys, "OPERATOR_LOGIN_PASSWORD"]);
      if (!username || !password) return null;
      return { provider, username, password };
    };

    if (/instagram/.test(signal)) {
      return byProvider("instagram", ["OPERATOR_LOGIN_INSTAGRAM_USERNAME", "OPERATOR_LOGIN_INSTAGRAM_EMAIL"], ["OPERATOR_LOGIN_INSTAGRAM_PASSWORD"]);
    }
    if (/(gmail|google)/.test(signal)) {
      return byProvider("google", ["OPERATOR_LOGIN_GOOGLE_EMAIL", "OPERATOR_LOGIN_GOOGLE_USERNAME"], ["OPERATOR_LOGIN_GOOGLE_PASSWORD"]);
    }
    if (/linkedin/.test(signal)) {
      return byProvider("linkedin", ["OPERATOR_LOGIN_LINKEDIN_EMAIL", "OPERATOR_LOGIN_LINKEDIN_USERNAME"], ["OPERATOR_LOGIN_LINKEDIN_PASSWORD"]);
    }
    if (/facebook/.test(signal)) {
      return byProvider("facebook", ["OPERATOR_LOGIN_FACEBOOK_EMAIL", "OPERATOR_LOGIN_FACEBOOK_USERNAME"], ["OPERATOR_LOGIN_FACEBOOK_PASSWORD"]);
    }
    if (/(twitter|x\.com)/.test(signal)) {
      return byProvider("x", ["OPERATOR_LOGIN_X_USERNAME", "OPERATOR_LOGIN_X_EMAIL"], ["OPERATOR_LOGIN_X_PASSWORD"]);
    }

    if (genericUser && genericPass) {
      return { provider: "generic", username: genericUser, password: genericPass };
    }
    return null;
  }

  private getAutoLoginLabels(provider: string): {
    usernameTargets: string[];
    passwordTargets: string[];
    nextTargets: string[];
    submitTargets: string[];
  } {
    const common = {
      usernameTargets: ["Email", "Phone", "Username", "Email or username", "Phone, email, or username"],
      passwordTargets: ["Password", "Enter password"],
      nextTargets: [] as string[],
      submitTargets: ["Log in", "Login", "Sign in", "Continue"],
    };

    if (provider === "google") {
      return {
        usernameTargets: ["Email or phone", "Email", "Phone", ...common.usernameTargets],
        passwordTargets: common.passwordTargets,
        nextTargets: ["Next", "Continue"],
        submitTargets: ["Next", "Sign in", "Continue"],
      };
    }
    if (provider === "instagram") {
      return {
        usernameTargets: ["Phone number, username, or email", "Username", "Email", ...common.usernameTargets],
        passwordTargets: common.passwordTargets,
        nextTargets: [],
        submitTargets: ["Log in", "Login", "Sign in"],
      };
    }
    return common;
  }

  private async clickVisionTarget(
    actionId: string,
    text: string,
    alternatives: string[] = [],
    retries = 3,
  ): Promise<{ x: number; y: number; target_text: string }> {
    const located = await this.locatePointByVisionText(text, alternatives, retries, actionId);
    const script = this.buildOsInputPowerShell([
      { kind: "move", x: located.x, y: located.y, duration_ms: 180 },
      { kind: "click", button: "left", count: 1 },
    ]);
    await this.runPowerShellScript(actionId, script, { sensitive: true });
    return located;
  }

  private async tryAutoLoginForObjective(
    actionId: string,
    objective: string,
    stepIndex: number,
    stepCount: number,
    gate: { reason: string; confidence: number; provider?: string; screenshot_path?: string },
  ): Promise<boolean> {
    if (!this.autoLoginEnabled || this.autoLoginMaxAttemptsPerAction <= 0) return false;
    const creds = this.resolveAutoLoginCredentials(objective, gate.provider);
    if (!creds) return false;

    const labels = this.getAutoLoginLabels(creds.provider);
    this.updateActionProgress(actionId, {
      live_progress: {
        phase: "running",
        step_index: Math.max(1, Math.min(stepCount, stepIndex + 1)),
        step_count: stepCount,
        detail: `Login detected. Attempting automatic ${creds.provider} sign-in.`,
      },
    });
    this.logs.emitLog("info", "auto_login_attempt", `Attempting automatic sign-in for ${creds.provider}`, {
      action_id: actionId,
      step_index: stepIndex + 1,
      step_count: stepCount,
    }, actionId);

    try {
      await this.clickVisionTarget(actionId, labels.usernameTargets[0], labels.usernameTargets.slice(1), 3);
      await this.runPowerShellScript(actionId, this.buildOsInputPowerShell([
        { kind: "hotkey", keys: ["ctrl", "a"] },
        { kind: "key", key: "backspace" },
        { kind: "type", text: creds.username },
      ]), { sensitive: true });

      if (labels.nextTargets.length > 0) {
        try {
          await this.clickVisionTarget(actionId, labels.nextTargets[0], labels.nextTargets.slice(1), 2);
          await this.runPowerShellScript(actionId, this.buildOsInputPowerShell([{ kind: "delay", ms: 1050 }]), { sensitive: true });
        } catch {
          // continue; some providers render password on the same screen
        }
      }

      await this.clickVisionTarget(actionId, labels.passwordTargets[0], labels.passwordTargets.slice(1), 3);
      await this.runPowerShellScript(actionId, this.buildOsInputPowerShell([
        { kind: "hotkey", keys: ["ctrl", "a"] },
        { kind: "key", key: "backspace" },
        { kind: "type", text: creds.password },
      ]), { sensitive: true });

      try {
        await this.clickVisionTarget(actionId, labels.submitTargets[0], labels.submitTargets.slice(1), 3);
      } catch {
        await this.runPowerShellScript(actionId, this.buildOsInputPowerShell([{ kind: "key", key: "enter" }]), { sensitive: true });
      }
      await this.runPowerShellScript(actionId, this.buildOsInputPowerShell([{ kind: "delay", ms: 2100 }]), { sensitive: true });

      const post = await this.detectLoginGateOnScreen(objective);
      if (!post.detected) {
        this.logs.emitLog("info", "auto_login_success", `Automatic sign-in appears successful for ${creds.provider}`, {
          action_id: actionId,
          provider: creds.provider,
        }, actionId);
        return true;
      }

      this.logs.emitLog("warn", "auto_login_unsure", "Automatic sign-in did not clear login gate", {
        action_id: actionId,
        provider: creds.provider,
        reason: post.reason,
        confidence: post.confidence,
      }, actionId);
      return false;
    } catch (error) {
      this.logs.emitLog("warn", "auto_login_failed", "Automatic sign-in attempt failed", {
        action_id: actionId,
        provider: creds.provider,
        error: error instanceof Error ? error.message : String(error),
      }, actionId);
      return false;
    }
  }

  private pauseForLoginGate(
    actionId: string,
    stepIndex: number,
    stepCount: number,
    gate: { reason: string; confidence: number; provider?: string; screenshot_path?: string },
  ): never {
    const reason = String(gate.reason || "Login required").trim();
    this.paused = true;
    this.pauseInterruptRequested = false;
    this.updateActionProgress(actionId, {
      live_progress: {
        phase: "blocked",
        step_index: Math.max(1, Math.min(stepCount, stepIndex + 1)),
        step_count: stepCount,
        detail: `Login required: ${reason}. Waiting for manual sign-in.`,
      },
      login_gate: {
        detected: true,
        reason,
        confidence: gate.confidence,
        provider: gate.provider,
        screenshot_path: gate.screenshot_path,
        resume_step_index: stepIndex,
      },
    });
    this.logs.emitLog(
      "warn",
      "login_gate_detected",
      `Login wall detected, pausing for manual sign-in: ${reason}`,
      {
        action_id: actionId,
        resume_step_index: stepIndex,
        step_count: stepCount,
        confidence: gate.confidence,
        provider: gate.provider,
        screenshot_path: gate.screenshot_path,
      },
      actionId,
    );
    this.logs.emitQueueSnapshot(this.snapshot());
    throw new PauseInterruptedError(
      `Login required${gate.provider ? ` (${gate.provider})` : ""}. I paused so you can sign in. Press Resume when finished.`,
      { resume_step_index: stepIndex, reason_code: "login_required", user_handoff: true },
    );
  }

  private async runOsInputControl(
    actionId: string,
    objective: string,
    providedSteps: OsInputStep[],
    dryRun: boolean,
    resumeFromStep = 0,
    resumeReason = "",
  ): Promise<Record<string, unknown>> {
    const explicitPlan = providedSteps.length > 0;
    const useAdaptiveLoop = this.shouldUseAdaptiveOsLoop(objective, providedSteps);
    const objectiveLower = String(objective || "").toLowerCase();
    let plannedSteps = (explicitPlan ? providedSteps : this.buildInputPlanFromObjective(objective))
      .map((step) => OsInputStepSchema.parse(step));
    let stepOrigins: string[] = plannedSteps.map(() => (explicitPlan ? "provided_plan" : "objective_heuristic"));
    const explicitInteractiveObjective = /(message|dm|inbox|compose|form|field|button|select|upload|download|login|sign in|captcha|search|type into|fill|submit)/.test(objectiveLower);
    const explicitWebObjective = this.isWebObjective(objective);
    const adaptiveAppendEnabled = (
      !explicitPlan
      || explicitInteractiveObjective
      || explicitWebObjective
      || plannedSteps.some((step) => step.kind === "vision_click_text")
    );
    const adaptiveReassessLimit = explicitPlan ? 16 : 22;
    const adaptiveAppendLimit = explicitPlan ? 30 : Math.max(60, this.adaptiveInitialStepCap * 10);
    const adaptiveHardStepCap = useAdaptiveLoop
      ? (
        explicitPlan
          ? Math.min(this.adaptiveMaxTotalSteps, Math.max(plannedSteps.length + 12, 24))
          : this.adaptiveMaxTotalSteps
      )
      : plannedSteps.length;
    if (explicitPlan && explicitWebObjective) {
      const normalized = this.normalizeProvidedWebPlan(objective, plannedSteps, stepOrigins);
      plannedSteps = normalized.steps;
      stepOrigins = normalized.origins;
    }
    if (useAdaptiveLoop && !explicitPlan && plannedSteps.length > this.adaptiveInitialStepCap) {
      plannedSteps = plannedSteps.slice(0, this.adaptiveInitialStepCap);
      stepOrigins = stepOrigins.slice(0, this.adaptiveInitialStepCap);
    }

    if (dryRun) {
      return {
        dry_run: true,
        objective,
        planned_steps: plannedSteps,
        step_origins: stepOrigins,
        step_count: plannedSteps.length,
      };
    }

    if (process.platform !== "win32") {
      const result = await this.runCommand(actionId, "node", [
        "-e",
        "console.log('OS input control fallback executed on non-Windows platform');",
      ], process.cwd());
      this.updateActionProgress(actionId, {
        live_progress: {
          phase: "fallback",
          step_index: 0,
          step_count: plannedSteps.length,
          detail: "Non-Windows fallback executed",
        },
      });
      return {
        objective,
        platform: process.platform,
        fallback: true,
        planned_steps: plannedSteps,
        step_origins: stepOrigins,
        result,
      };
    }

    if (plannedSteps.length === 0) {
      throw new Error("No executable input steps were generated for objective.");
    }

    const persistRuntimePlan = (): void => {
      this.updateActionProgress(actionId, {
        runtime_planned_steps: plannedSteps,
        runtime_step_origins: stepOrigins,
      });
    };
    persistRuntimePlan();
    await this.verifyInteractiveInputChannel(actionId);

    const startIndexRaw = Math.max(0, Math.min(plannedSteps.length, Math.floor(resumeFromStep)));
    const startIndex = (resumeReason === "login_required" && startIndexRaw >= plannedSteps.length)
      ? Math.max(0, plannedSteps.length - 1)
      : startIndexRaw;
    const watchLoginGate = this.shouldWatchForLoginGate(objective, plannedSteps);
    const resumedAfterLogin = resumeReason === "login_required";
    let lastLoginCheckAt = 0;
    let interactiveStepsSinceLoginCheck = this.loginGateDetectionStepInterval;
    let adaptiveNoopCycles = 0;
    let adaptiveRepeatCycles = 0;
    let lastAdaptiveSignature = "";
    let adaptiveReasonStallCycles = 0;
    let lastAdaptiveReasonToken = "";
    let repeatedAdaptiveVisionTarget = "";
    let repeatedAdaptiveVisionTargetCycles = 0;
    let adaptiveReassessCycles = 0;
    let adaptiveAppendedTotal = 0;
    let seenWebNavigation = false;
    let adaptiveMeaningfulSteps = 0;
    let suppressNextEnterAfterLaunch = false;
    const loopStartedAt = Date.now();
    const executedStepSummaries: string[] = [];

    for (let j = 0; j < startIndex; j += 1) {
      const prev = plannedSteps[j];
      if (
        prev.kind === "type"
        && /(https?:\/\/|www\.|instagram\.com|mail\.google\.com|accounts\.google\.com|linkedin\.com|facebook\.com|x\.com|twitter\.com|discord\.com|slack\.com)/i.test(prev.text)
      ) {
        seenWebNavigation = true;
        break;
      }
    }

    this.emitOsDebugTelemetry(actionId, "os_plan_initialized", "OS plan prepared", {
      objective: String(objective || "").slice(0, 260),
      resumed_from_step: startIndex,
      adaptive_loop: useAdaptiveLoop,
      watch_login_gate: watchLoginGate,
      step_count: plannedSteps.length,
      planned_steps: plannedSteps.slice(0, 60).map((step, index) => ({
        step_index: index + 1,
        chosen_reason: stepOrigins[index] ?? "unknown",
        step: this.asStepPayload(step),
      })),
    });

    this.updateActionProgress(actionId, {
      paused_reason: "",
      live_progress: {
        phase: "starting",
        step_index: startIndex,
        step_count: plannedSteps.length,
        detail: startIndex > 0
          ? `Resuming at step ${Math.min(startIndex + 1, plannedSteps.length)}/${plannedSteps.length}`
          : `Preparing ${plannedSteps.length} steps`,
      },
    });

    if (useAdaptiveLoop && resumedAfterLogin) {
      const adaptive = await this.requestAdaptiveStepsFromVision(
        objective,
        executedStepSummaries,
        Math.max(0, plannedSteps.length - startIndex),
      );
      this.emitOsDebugTelemetry(actionId, "vision_parse", "Post-login reassessment vision parse", {
        purpose: "post_login_reassess",
        resumed_from_step: startIndex,
        parse: adaptive.vision_parse,
        analysis: adaptive.vision_analysis.slice(0, 700),
        screenshot_path: adaptive.screenshot_path,
        model: adaptive.model,
      });
      this.emitOsDebugTelemetry(actionId, "adaptive_step_selection", "Post-login reassessment complete", {
        resumed_from_step: startIndex,
        done: adaptive.done,
        reason: adaptive.reason,
        why_next_step: adaptive.reason,
        next_steps: adaptive.nextSteps.map((next) => this.asStepPayload(next)),
      });
      if (!adaptive.done && adaptive.nextSteps.length > 0) {
        const room = Math.max(0, adaptiveHardStepCap - plannedSteps.length);
        const toInsert = room > 0 ? adaptive.nextSteps.slice(0, room) : [];
        if (toInsert.length > 0) {
          plannedSteps = [
            ...plannedSteps.slice(0, startIndex),
            ...toInsert,
            ...plannedSteps.slice(startIndex),
          ];
          stepOrigins = [
            ...stepOrigins.slice(0, startIndex),
            ...toInsert.map(() => `resume_adaptive:${adaptive.reason.slice(0, 80)}`),
            ...stepOrigins.slice(startIndex),
          ];
          persistRuntimePlan();
          this.logs.emitLog("info", "adaptive_steps_inserted_after_resume", `Inserted ${toInsert.length} adaptive step(s) after login resume`, {
            action_id: actionId,
            resumed_from_step: startIndex,
            inserted: toInsert.length,
            total_planned: plannedSteps.length,
            reason: adaptive.reason,
          }, actionId);
        }
      }
    }

    for (let i = startIndex; i < plannedSteps.length; i += 1) {
      if ((Date.now() - loopStartedAt) > Math.max(10000, this.settings.per_action_timeout_ms)) {
        throw new Error(`OS input control exceeded action timeout (${this.settings.per_action_timeout_ms}ms).`);
      }
      if (useAdaptiveLoop && plannedSteps.length > adaptiveHardStepCap) {
        throw new Error(`Adaptive loop exceeded max planned steps (${adaptiveHardStepCap}).`);
      }
      if (this.killRequested) {
        throw new Error("Canceled by kill switch");
      }
      if (this.paused) {
        throw new PauseInterruptedError("Paused by operator. Resume to continue.", {
          resume_step_index: i,
          reason_code: "manual_pause",
          user_handoff: true,
        });
      }

      const step = plannedSteps[i];
      const stepOrigin = stepOrigins[i] ?? "unknown";
      const prevStep = i > 0 ? plannedSteps[i - 1] : undefined;
      if (
        step.kind === "type"
        && /(https?:\/\/|www\.|instagram\.com|mail\.google\.com|accounts\.google\.com|linkedin\.com|facebook\.com|x\.com|twitter\.com|discord\.com|slack\.com)/i.test(step.text)
      ) {
        seenWebNavigation = true;
      }

      const resumeCooldownSatisfied = !resumedAfterLogin || (i - startIndex) >= 1;
      const forceLoginCheckAfterResume = resumedAfterLogin && i === startIndex;
      const gateCheckStepEligible = this.stepCanTriggerLoginGateCheck(step) || forceLoginCheckAfterResume;
      if (watchLoginGate && seenWebNavigation && gateCheckStepEligible && (resumeCooldownSatisfied || forceLoginCheckAfterResume)) {
        interactiveStepsSinceLoginCheck += 1;
        const now = Date.now();
        const dueByStep = interactiveStepsSinceLoginCheck >= this.loginGateDetectionStepInterval;
        const dueByTime = (now - lastLoginCheckAt) >= this.loginGateDetectionCooldownMs;
        if (dueByStep || dueByTime || forceLoginCheckAfterResume) {
          const gate = await this.detectLoginGateOnScreen(objective);
          lastLoginCheckAt = now;
          interactiveStepsSinceLoginCheck = 0;
          this.emitOsDebugTelemetry(actionId, "vision_parse", "Login gate vision parse", {
            purpose: "login_gate_check",
            step_index: i + 1,
            parse: gate.parse ?? null,
            detected: gate.detected,
            confidence: gate.confidence,
            reason: gate.reason,
            provider: gate.provider,
            screenshot_path: gate.screenshot_path,
          });
          if (gate.detected) {
            this.pauseForLoginGate(actionId, i, plannedSteps.length, gate);
          }
        }
      }

      const detail = this.describeOsStep(step);
      this.updateActionProgress(actionId, {
        live_progress: {
          phase: "running",
          step_index: i + 1,
          step_count: plannedSteps.length,
          detail,
          kind: step.kind,
        },
      });
      this.logs.emitLog(
        "info",
        "os_input_step",
        `Step ${i + 1}/${plannedSteps.length}: ${detail}`,
        { step_index: i + 1, step_count: plannedSteps.length, step_kind: step.kind, chosen_reason: stepOrigin },
        actionId,
      );
      this.emitOsDebugTelemetry(actionId, "os_step_planned", "Planned step", {
        step_index: i + 1,
        step_count: plannedSteps.length,
        chosen_reason: stepOrigin,
        planned_step: this.asStepPayload(step),
      });

      let executedDetail = detail;
      let handledStep = false;

      if (
        suppressNextEnterAfterLaunch
        && step.kind === "key"
        && /^enter$/i.test(String(step.key || "").trim())
      ) {
        suppressNextEnterAfterLaunch = false;
        executedDetail = "Skip Enter after direct app launch";
        handledStep = true;
      }

      if (!handledStep && step.kind === "type" && this.shouldAttemptDirectLaunch(objective, step, prevStep, i)) {
        const launchExe = this.resolveDirectLaunchExecutable(step.text);
        if (launchExe) {
          const launchScript = [
            "$ErrorActionPreference = 'Stop';",
            `Start-Process -FilePath ${this.escapePowerShellLiteral(launchExe)};`,
            "Start-Sleep -Milliseconds 220;",
          ].join("\n");
          await this.runPowerShellScript(actionId, launchScript, {
            sensitive: true,
            displayCommand: `powershell [launch:${launchExe}]`,
          });
          suppressNextEnterAfterLaunch = true;
          if (/chrome|msedge/i.test(launchExe)) seenWebNavigation = true;
          executedDetail = `Launch app directly: ${launchExe}`;
          handledStep = true;
        }
      }

      if (
        !handledStep
        && step.kind === "type"
        && /(https?:\/\/|www\.)/i.test(step.text)
        && !this.hasRecentAddressBarFocus(plannedSteps, i)
      ) {
        const urlScript = this.buildOsInputPowerShell([
          { kind: "hotkey", keys: ["ctrl", "l"] },
          { kind: "delay", ms: 120 },
          step,
          { kind: "key", key: "enter" },
        ]);
        await this.runPowerShellScript(actionId, urlScript, { sensitive: true });
        executedDetail = `Focus address bar, type URL, and submit: ${step.text.slice(0, 48)}`;
        handledStep = true;
      }

      if (!handledStep && step.kind === "delay") {
        let remaining = step.ms;
        while (remaining > 0) {
          if (this.killRequested) {
            throw new Error("Canceled by kill switch");
          }
          if (this.paused) {
            throw new PauseInterruptedError("Paused by operator. Resume to continue.", {
              resume_step_index: i,
              reason_code: "manual_pause",
              user_handoff: true,
            });
          }
          const slice = Math.min(remaining, 120);
          await new Promise((resolve) => setTimeout(resolve, slice));
          remaining -= slice;
        }
      } else if (!handledStep && step.kind === "vision_click_text") {
        let located: { x: number; y: number; target_text: string };
        try {
          located = await this.locatePointByVisionText(
            step.text,
            step.alternatives,
            step.retries,
            actionId,
            (payload) => this.emitOsDebugTelemetry(actionId, "vision_parse", "Vision target parse", payload),
          );
        } catch (error) {
          this.emitOsDebugTelemetry(actionId, "vision_target_not_found", "Vision target could not be resolved", {
            step_index: i + 1,
            requested_text: step.text,
            alternatives: step.alternatives,
            error: error instanceof Error ? error.message : String(error),
          });
          if (watchLoginGate) {
            const gate = await this.detectLoginGateOnScreen(objective);
            this.emitOsDebugTelemetry(actionId, "vision_parse", "Login gate check after vision miss", {
              purpose: "login_gate_after_vision_miss",
              step_index: i + 1,
              parse: gate.parse ?? null,
              detected: gate.detected,
              confidence: gate.confidence,
              reason: gate.reason,
              provider: gate.provider,
              screenshot_path: gate.screenshot_path,
            });
            if (gate.detected) {
              this.pauseForLoginGate(actionId, i, plannedSteps.length, gate);
            }
          }
          throw error;
        }
        const clickScript = this.buildOsInputPowerShell([
          { kind: "move", x: located.x, y: located.y, duration_ms: 220 },
          { kind: "click", button: step.button, count: 1 },
        ]);
        this.updateActionProgress(actionId, {
          live_progress: {
            phase: "running",
            step_index: i + 1,
            step_count: plannedSteps.length,
            detail: `Vision target "${located.target_text}" at (${located.x}, ${located.y})`,
            kind: step.kind,
          },
        });
        try {
          await this.runPowerShellScript(actionId, clickScript);
        } catch (error) {
          if (error instanceof PauseInterruptedError) {
            throw new PauseInterruptedError(error.message, {
              resume_step_index: i,
              reason_code: error.reason_code ?? "manual_pause",
              user_handoff: true,
            });
          }
          throw error;
        }
        executedDetail = `Vision target "${located.target_text}" clicked at (${located.x}, ${located.y})`;
      } else if (!handledStep) {
        const stepScript = this.buildOsInputPowerShell([step]);
        try {
          await this.runPowerShellScript(actionId, stepScript);
        } catch (error) {
          if (error instanceof PauseInterruptedError) {
            throw new PauseInterruptedError(error.message, {
              resume_step_index: i,
              reason_code: error.reason_code ?? "manual_pause",
              user_handoff: true,
            });
          }
          throw error;
        }
      }

      if (step.kind !== "delay") adaptiveMeaningfulSteps += 1;
      executedStepSummaries.push(executedDetail);
      if (executedStepSummaries.length > 12) executedStepSummaries.shift();
      this.emitOsDebugTelemetry(actionId, "os_step_executed", "Executed step", {
        step_index: i + 1,
        step_count: plannedSteps.length,
        executed_detail: executedDetail,
        executed_step: this.asStepPayload(step),
      });

      if (useAdaptiveLoop) {
        const remaining = plannedSteps.length - (i + 1);
        const reassessByInterval = adaptiveMeaningfulSteps > 0 && adaptiveMeaningfulSteps % this.adaptiveReassessInterval === 0;
        const reassessByLowQueue = remaining <= 1;
        if (reassessByInterval || reassessByLowQueue) {
          adaptiveReassessCycles += 1;
          if (adaptiveAppendEnabled && adaptiveReassessCycles > adaptiveReassessLimit) {
            throw new Error("Adaptive loop exceeded reassessment cycle limit without reaching objective.");
          }
          const adaptive = await this.requestAdaptiveStepsFromVision(objective, executedStepSummaries, remaining);
          this.emitOsDebugTelemetry(actionId, "vision_parse", "Adaptive vision parse", {
            purpose: "adaptive_next_steps",
            step_index: i + 1,
            parse: adaptive.vision_parse,
            analysis: adaptive.vision_analysis.slice(0, 700),
            screenshot_path: adaptive.screenshot_path,
            model: adaptive.model,
          });
          this.emitOsDebugTelemetry(actionId, "adaptive_step_selection", "Adaptive reassessment complete", {
            step_index: i + 1,
            done: adaptive.done,
            reason: adaptive.reason,
            why_next_step: adaptive.reason,
            next_steps: adaptive.nextSteps.map((next) => this.asStepPayload(next)),
          });

          const reasonToken = String(adaptive.reason || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
          const waitingLikeReason = /(wait|waiting|loading|still|next step|continue)/.test(reasonToken);
          if (reasonToken && waitingLikeReason) {
            if (reasonToken === lastAdaptiveReasonToken) {
              adaptiveReasonStallCycles += 1;
            } else {
              adaptiveReasonStallCycles = 0;
              lastAdaptiveReasonToken = reasonToken;
            }
          } else {
            adaptiveReasonStallCycles = 0;
            lastAdaptiveReasonToken = reasonToken;
          }
          if (adaptiveAppendEnabled && adaptiveReasonStallCycles >= 3) {
            throw new Error(`Adaptive loop is stalled with repeated reason "${adaptive.reason}".`);
          }

          if (adaptive.done) {
            this.logs.emitLog("info", "adaptive_goal_complete", `Adaptive loop marked objective complete: ${adaptive.reason}`, {
              action_id: actionId,
              executed_steps: i + 1,
            }, actionId);
            plannedSteps = plannedSteps.slice(0, i + 1);
            stepOrigins = stepOrigins.slice(0, i + 1);
            persistRuntimePlan();
            break;
          }

          if (adaptive.nextSteps.length > 0 && adaptiveAppendEnabled) {
            adaptiveNoopCycles = 0;
            const room = Math.max(0, adaptiveHardStepCap - plannedSteps.length);
            const toAppend = room > 0 ? adaptive.nextSteps.slice(0, room) : [];
            if (toAppend.length > 0) {
              const signature = JSON.stringify(toAppend.map((next) => this.asStepPayload(next)));
              if (signature === lastAdaptiveSignature) {
                adaptiveRepeatCycles += 1;
              } else {
                adaptiveRepeatCycles = 0;
                lastAdaptiveSignature = signature;
              }
              if (adaptiveRepeatCycles >= 2) {
                throw new Error("Adaptive loop repeated the same next-step suggestion multiple times without progress.");
              }
              const firstVisionTarget = toAppend
                .find((next): next is Extract<OsInputStep, { kind: "vision_click_text" }> => next.kind === "vision_click_text");
              if (firstVisionTarget) {
                const token = this.normalizeLocatorText(firstVisionTarget.text);
                if (token && token === repeatedAdaptiveVisionTarget) {
                  repeatedAdaptiveVisionTargetCycles += 1;
                } else {
                  repeatedAdaptiveVisionTarget = token;
                  repeatedAdaptiveVisionTargetCycles = 0;
                }
              if (repeatedAdaptiveVisionTargetCycles >= 3) {
                  throw new Error(`Adaptive loop kept targeting "${firstVisionTarget.text}" without progress.`);
                }
              } else {
                repeatedAdaptiveVisionTarget = "";
                repeatedAdaptiveVisionTargetCycles = 0;
              }
              adaptiveAppendedTotal += toAppend.length;
              if (adaptiveAppendedTotal > adaptiveAppendLimit) {
                throw new Error("Adaptive loop appended too many additional steps without converging.");
              }
              plannedSteps.push(...toAppend);
              stepOrigins.push(...toAppend.map(() => `adaptive:${adaptive.reason.slice(0, 80)}`));
              persistRuntimePlan();
              this.logs.emitLog("info", "adaptive_steps_appended", `Adaptive loop appended ${toAppend.length} step(s)`, {
                action_id: actionId,
                appended: toAppend.length,
                total_planned: plannedSteps.length,
                reason: adaptive.reason,
              }, actionId);
              this.emitOsDebugTelemetry(actionId, "adaptive_steps_appended", "Adaptive steps appended", {
                step_index: i + 1,
                appended: toAppend.length,
                why_next_step: adaptive.reason,
                total_planned: plannedSteps.length,
                appended_steps: toAppend.map((next) => this.asStepPayload(next)),
              });
            }
          } else if (adaptive.nextSteps.length > 0 && !adaptiveAppendEnabled) {
            this.emitOsDebugTelemetry(actionId, "adaptive_steps_skipped", "Adaptive suggestions observed but append is disabled for this objective", {
              step_index: i + 1,
              reason: adaptive.reason,
              suggested_steps: adaptive.nextSteps.map((next) => this.asStepPayload(next)),
            });
          } else if (reassessByLowQueue) {
            adaptiveNoopCycles += 1;
            if (adaptiveNoopCycles >= 3) {
              throw new Error("Adaptive loop could not determine next on-screen step. Rephrase objective or move UI to target context.");
            }
          }
        }
      }
    }

    this.updateActionProgress(actionId, {
      live_progress: {
        phase: "completed",
        step_index: plannedSteps.length,
        step_count: plannedSteps.length,
        detail: "All steps executed",
      },
      runtime_planned_steps: plannedSteps,
      runtime_step_origins: stepOrigins,
    });

    const latestAction = this.actions.get(actionId);
    const latestResult = (latestAction?.result && typeof latestAction.result === "object")
      ? latestAction.result as Record<string, unknown>
      : {};
    const debugTrace = Array.isArray(latestResult.debug_trace) ? latestResult.debug_trace : [];

    return {
      objective,
      platform: process.platform,
      step_count: plannedSteps.length,
      planned_steps: plannedSteps,
      step_origins: stepOrigins,
      runtime_planned_steps: plannedSteps,
      command: "powershell step runner",
      exit_code: 0,
      duration_ms: 0,
      resumed_from_step: startIndex,
      adaptive_loop: useAdaptiveLoop,
      debug_trace: debugTrace,
    };
  }

  private describeOsStep(step: OsInputStep): string {
    if (step.kind === "move") return `Move cursor to (${step.x}, ${step.y})`;
    if (step.kind === "drag") return `Drag ${step.button} from (${step.from_x}, ${step.from_y}) to (${step.to_x}, ${step.to_y})`;
    if (step.kind === "click") return `Click ${step.button} button (${step.count}x)`;
    if (step.kind === "scroll") return `Scroll ${step.repeats}x (delta ${step.delta})`;
    if (step.kind === "vision_click_text") return `Find and click "${step.text}"`;
    if (step.kind === "type") return `Type text: ${step.text.slice(0, 48)}`;
    if (step.kind === "key") return `Press key: ${step.key}`;
    if (step.kind === "hotkey") return `Press hotkey: ${step.keys.join("+")}`;
    return `Wait ${step.ms}ms`;
  }

  private updateActionProgress(actionId: string, patch: Record<string, unknown>): void {
    const action = this.actions.get(actionId);
    if (!action) return;
    action.result = { ...(action.result ?? {}), ...patch };
    action.updated_at = nowIso();
    this.storage.upsertAction(action);
  }

  private asStepPayload(step: OsInputStep): Record<string, unknown> {
    return { ...(step as unknown as Record<string, unknown>) };
  }

  private appendActionDebugTrace(actionId: string, entry: Record<string, unknown>): void {
    const action = this.actions.get(actionId);
    if (!action) return;
    const base = (action.result && typeof action.result === "object")
      ? action.result as Record<string, unknown>
      : {};
    const existing = Array.isArray(base.debug_trace)
      ? base.debug_trace
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .slice(-179)
      : [];
    const next = [...existing, { at: nowIso(), ...entry }];
    action.result = { ...base, debug_trace: next };
    action.updated_at = nowIso();
    this.storage.upsertAction(action);
  }

  private emitOsDebugTelemetry(
    actionId: string,
    eventType: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const payload = data ?? {};
    this.logs.emitLog("debug", eventType, message, payload, actionId);
    this.appendActionDebugTrace(actionId, { event_type: eventType, message, ...payload });
  }

  private parseStoredRuntimeSteps(raw: unknown): OsInputStep[] {
    if (!Array.isArray(raw)) return [];
    const parsed: OsInputStep[] = [];
    for (const item of raw) {
      try {
        parsed.push(OsInputStepSchema.parse(item));
      } catch {
        // ignore invalid persisted step
      }
    }
    return parsed;
  }

  async captureScreenSnapshot(label = "screen"): Promise<ScreenSnapshot> {
    if (process.platform !== "win32") {
      throw new Error("Screen snapshot is currently implemented for Windows only.");
    }
    const shotsDir = path.join(DATA_DIR, "screenshots");
    await fsp.mkdir(shotsDir, { recursive: true });
    const safeLabel = slugify(label || "screen").slice(0, 40) || "screen";
    const fileName = `${safeLabel}-${Date.now()}.png`;
    const outputPath = path.join(shotsDir, fileName);

    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "Add-Type -AssemblyName System.Drawing;",
      "$native = @\"",
      "using System.Runtime.InteropServices;",
      "public static class OperatorNativeDpi {",
      "  [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();",
      "}",
      "\"@;",
      "try { Add-Type -TypeDefinition $native -Language CSharp -ErrorAction Stop | Out-Null; } catch {}",
      "try { [OperatorNativeDpi]::SetProcessDPIAware() | Out-Null; } catch {}",
      "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
      "$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;",
      "$gfx = [System.Drawing.Graphics]::FromImage($bmp);",
      "$src = New-Object System.Drawing.Point $bounds.Left, $bounds.Top;",
      "$gfx.CopyFromScreen($src, [System.Drawing.Point]::Empty, $bounds.Size);",
      `$outPath = ${this.escapePowerShellLiteral(outputPath)};`,
      "$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png);",
      "$gfx.Dispose();",
      "$bmp.Dispose();",
      "$out = @{",
      "  screenshot_path = $outPath;",
      "  captured_at = (Get-Date).ToUniversalTime().ToString('o');",
      "  left = [int]$bounds.Left;",
      "  top = [int]$bounds.Top;",
      "  width = [int]$bounds.Width;",
      "  height = [int]$bounds.Height;",
      "};",
      "Write-Output (ConvertTo-Json $out -Compress);",
    ].join("\n");

    const result = await this.runPowerShellScript("vision_snapshot", script);
    const parsed = this.parseJsonObjectFromText(result.stdout);
    const left = Number(parsed?.left);
    const top = Number(parsed?.top);
    const width = Number(parsed?.width);
    const height = Number(parsed?.height);
    if (
      parsed
      && typeof parsed.screenshot_path === "string"
      && Number.isFinite(left)
      && Number.isFinite(top)
      && Number.isFinite(width)
      && Number.isFinite(height)
      && width > 0
      && height > 0
    ) {
      return {
        screenshot_path: String(parsed.screenshot_path),
        captured_at: String(parsed.captured_at ?? nowIso()),
        left: Math.floor(left),
        top: Math.floor(top),
        width: Math.floor(width),
        height: Math.floor(height),
      };
    }
    return {
      screenshot_path: outputPath,
      captured_at: nowIso(),
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
    };
  }

  async analyzeScreenWithOllama(
    prompt: string,
    preferredModel?: string,
    opts?: { force_json?: boolean },
  ): Promise<Record<string, unknown>> {
    const base = String(process.env.OPERATOR_BRAIN_OLLAMA_BASE || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
    if (!base) throw new Error("OPERATOR_BRAIN_OLLAMA_BASE is not configured.");
    const ollamaPort = (() => {
      try {
        const parsed = new URL(base);
        const portRaw = Number(parsed.port || (parsed.protocol === "https:" ? "443" : "80"));
        if (Number.isFinite(portRaw) && portRaw > 0) return portRaw;
      } catch {
        // fallback below
      }
      return 11434;
    })();
    const portHint = `Get-NetTCPConnection -LocalPort ${ollamaPort} -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess`;

    let tagsRes: Response;
    try {
      tagsRes = await fetch(`${base}/api/tags`, { method: "GET" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not reach Ollama at ${base}. Check listener on port ${ollamaPort}: ${portHint}. Cause: ${reason}`);
    }
    if (!tagsRes.ok) {
      throw new Error(`Could not query Ollama models (${tagsRes.status}) at ${base}. Check listener on port ${ollamaPort}: ${portHint}.`);
    }
    const tagsPayload = await tagsRes.json() as Record<string, unknown>;
    const names = (Array.isArray(tagsPayload.models) ? tagsPayload.models : [])
      .map((item) => String((item as Record<string, unknown>).name ?? "").trim())
      .filter(Boolean);

    const requested = String(preferredModel || process.env.OPERATOR_VISION_OLLAMA_MODEL || "").trim();
    const byName = requested && names.includes(requested) ? requested : "";
    const likelyVision = names.find((name) => /llava|vision|bakllava|moondream|vl/i.test(name)) ?? "";
    const resolved = byName || likelyVision;
    if (!resolved) {
      throw new Error(
        "No vision-capable Ollama model is available. Install one (for example: `ollama pull llava:latest`) and set OPERATOR_VISION_OLLAMA_MODEL.",
      );
    }

    const snap = await this.captureScreenSnapshot("vision");
    const image = await fsp.readFile(snap.screenshot_path);
    const base64 = image.toString("base64");
    const userPrompt = String(prompt || "Describe what is visible on screen and suggest the next actionable UI step.").trim();

    const forceJson = opts?.force_json === true;
    const requestPayload: Record<string, unknown> = {
      model: resolved,
      stream: false,
      options: { temperature: forceJson ? 0 : 0.15 },
      messages: [
        {
          role: "user",
          content: userPrompt,
          images: [base64],
        },
      ],
    };
    if (forceJson) requestPayload.format = "json";

    let response: Response;
    try {
      response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Ollama vision request could not reach ${base}. Check port ${ollamaPort}: ${portHint}. Cause: ${reason}`);
    }
    if (!response.ok) {
      throw new Error(`Ollama vision chat failed (${response.status}) at ${base}. Verify model availability and listener on port ${ollamaPort}.`);
    }
    const responsePayload = await response.json() as Record<string, unknown>;
    const messageObj = responsePayload.message as Record<string, unknown> | undefined;
    const analysis = typeof messageObj?.content === "string"
      ? messageObj.content
      : typeof responsePayload.response === "string"
        ? responsePayload.response
        : "";

    return {
      ok: true,
      model: resolved,
      prompt: userPrompt,
      screenshot_path: snap.screenshot_path,
      screen_bounds: {
        left: snap.left,
        top: snap.top,
        width: snap.width,
        height: snap.height,
      },
      analysis: String(analysis || "").trim(),
      available_models: names,
    };
  }

  private parseJsonObjectFromText(raw: string): Record<string, unknown> | null {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return null;
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? trimmed;
    const candidates = [fenced];
    const first = fenced.indexOf("{");
    const last = fenced.lastIndexOf("}");
    if (first >= 0 && last > first) candidates.push(fenced.slice(first, last + 1));
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        return parsed;
      } catch {
        const noTrailingCommas = candidate.replace(/,\s*([}\]])/g, "$1");
        try {
          const parsed = JSON.parse(noTrailingCommas) as Record<string, unknown>;
          return parsed;
        } catch {
          // continue
        }
      }
    }
    return null;
  }

  private toFiniteNumber(value: unknown): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  }

  private screenBoundsFromVisionAnalysis(analysis: Record<string, unknown>): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    const raw = (analysis.screen_bounds && typeof analysis.screen_bounds === "object")
      ? analysis.screen_bounds as Record<string, unknown>
      : {};
    const left = this.toFiniteNumber(raw.left) ?? 0;
    const top = this.toFiniteNumber(raw.top) ?? 0;
    const width = this.toFiniteNumber(raw.width) ?? 1920;
    const height = this.toFiniteNumber(raw.height) ?? 1080;
    return {
      left: Math.floor(left),
      top: Math.floor(top),
      width: Math.max(200, Math.floor(width)),
      height: Math.max(120, Math.floor(height)),
    };
  }

  private clampPointToBounds(
    x: number,
    y: number,
    bounds: { left: number; top: number; width: number; height: number },
  ): { x: number; y: number } {
    const minX = Math.floor(bounds.left);
    const minY = Math.floor(bounds.top);
    const maxX = Math.max(minX, Math.floor(bounds.left + bounds.width - 1));
    const maxY = Math.max(minY, Math.floor(bounds.top + bounds.height - 1));
    return {
      x: Math.max(minX, Math.min(maxX, Math.floor(x))),
      y: Math.max(minY, Math.min(maxY, Math.floor(y))),
    };
  }

  private extractVisionPointCandidate(
    parsed: Record<string, unknown> | null,
    bounds: { left: number; top: number; width: number; height: number },
  ): { x: number; y: number; source: string; normalized: boolean } | null {
    if (!parsed) return null;
    const relToAbs = (x: number, y: number): { x: number; y: number } => ({
      x: bounds.left + (x * bounds.width),
      y: bounds.top + (y * bounds.height),
    });

    const readPair = (xRaw: unknown, yRaw: unknown, source: string): { x: number; y: number; source: string; normalized: boolean } | null => {
      const x = this.toFiniteNumber(xRaw);
      const y = this.toFiniteNumber(yRaw);
      if (x === null || y === null) return null;

      const looksNormalized = x >= 0 && x <= 1 && y >= 0 && y <= 1;
      if (looksNormalized) {
        const abs = relToAbs(x, y);
        const clamped = this.clampPointToBounds(abs.x, abs.y, bounds);
        return { ...clamped, source, normalized: true };
      }

      const looksScreenRelative = x >= 0 && x <= bounds.width && y >= 0 && y <= bounds.height;
      if (looksScreenRelative && (bounds.left !== 0 || bounds.top !== 0)) {
        const clamped = this.clampPointToBounds(bounds.left + x, bounds.top + y, bounds);
        return { ...clamped, source, normalized: false };
      }

      const clamped = this.clampPointToBounds(x, y, bounds);
      return { ...clamped, source, normalized: false };
    };

    const direct = readPair(parsed.x, parsed.y, "xy");
    if (direct) return direct;

    const center = readPair(parsed.center_x ?? parsed.cx, parsed.center_y ?? parsed.cy, "center");
    if (center) return center;

    if (Array.isArray(parsed.bbox) && parsed.bbox.length >= 4) {
      const raw = parsed.bbox.map((item) => this.toFiniteNumber(item));
      if (raw.every((item) => item !== null)) {
        const [a, b, c, d] = raw as number[];
        const norm = [a, b, c, d].every((value) => value >= 0 && value <= 1);
        if (norm) {
          const x = a + Math.max(0, c) / 2;
          const y = b + Math.max(0, d) / 2;
          const point = readPair(x, y, "bbox_norm");
          if (point) return point;
        } else {
          const asCorners = readPair((a + c) / 2, (b + d) / 2, "bbox_abs");
          if (asCorners) return asCorners;
        }
      }
    }

    const box = (parsed.box && typeof parsed.box === "object") ? parsed.box as Record<string, unknown> : null;
    if (box) {
      const boxPoint = readPair(box.x, box.y, "box_xy");
      if (boxPoint) return boxPoint;
      const boxCenter = readPair(box.cx ?? box.center_x, box.cy ?? box.center_y, "box_center");
      if (boxCenter) return boxCenter;
    }

    return null;
  }

  private normalizeLocatorText(value: string): string {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  }

  private async locatePointByUiAutomationText(
    actionId: string,
    targets: string[],
  ): Promise<{
    found: boolean;
    x?: number;
    y?: number;
    target_text?: string;
    matched_name?: string;
    score?: number;
    reason?: string;
  }> {
    const filtered = targets
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 8);
    if (filtered.length === 0) return { found: false, reason: "no_targets" };
    const payload = JSON.stringify(filtered);
    const script = [
      "Add-Type -AssemblyName UIAutomationClient;",
      "Add-Type -AssemblyName UIAutomationTypes;",
      "$native = @\"",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class OperatorNativeWin {",
      "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
      "  [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();",
      "}",
      "\"@;",
      "try { Add-Type -TypeDefinition $native -Language CSharp -ErrorAction Stop | Out-Null; } catch {}",
      "try { [OperatorNativeWin]::SetProcessDPIAware() | Out-Null; } catch {}",
      ` $targets = ${this.escapePowerShellLiteral(payload)} | ConvertFrom-Json;`,
      "function Normalize([string]$value) {",
      "  if ([string]::IsNullOrWhiteSpace($value)) { return ''; }",
      "  return ([regex]::Replace($value.ToLowerInvariant(), '[^a-z0-9]+', '')).Trim();",
      "}",
      "$resolvedTargets = @();",
      "foreach ($target in $targets) {",
      "  $raw = [string]$target;",
      "  $norm = Normalize $raw;",
      "  if ($norm) {",
      "    $resolvedTargets += [PSCustomObject]@{ raw = $raw; norm = $norm };",
      "  }",
      "}",
      "if ($resolvedTargets.Count -eq 0) {",
      "  Write-Output '{\"found\":false,\"reason\":\"no_normalized_targets\"}';",
      "  exit 0;",
      "}",
      "function Find-BestInRoot($root) {",
      "  if ($null -eq $root) { return $null; }",
      "  try {",
      "    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition);",
      "  } catch {",
      "    return $null;",
      "  }",
      "  $best = $null;",
      "  for ($i = 0; $i -lt $all.Count; $i++) {",
      "    $el = $all.Item($i);",
      "    if ($null -eq $el) { continue; }",
      "    try {",
      "      $name = [string]$el.Current.Name;",
      "      $help = [string]$el.Current.HelpText;",
      "      $aid = [string]$el.Current.AutomationId;",
      "      $ctype = [string]$el.Current.ControlType.ProgrammaticName;",
      "      $combinedName = \"$name $help $aid\";",
      "      $normName = Normalize $combinedName;",
      "      if (-not $normName) { continue; }",
      "      $rect = $el.Current.BoundingRectangle;",
      "      if ($rect.Width -lt 2 -or $rect.Height -lt 2) { continue; }",
      "      if ($el.Current.IsOffscreen) { continue; }",
      "      foreach ($target in $resolvedTargets) {",
      "        $score = 0;",
      "        $targetNormLen = $target.norm.Length;",
      "        $rawTargetLower = ([string]$target.raw).ToLowerInvariant();",
      "        $combinedLower = $combinedName.ToLowerInvariant();",
      "        if ($targetNormLen -le 2) {",
      "          if ($normName -eq $target.norm) {",
      "            $score = 104;",
      "          } elseif ($rawTargetLower -and $combinedLower -match ('(^|\\W)' + [Regex]::Escape($rawTargetLower) + '(\\W|$)')) {",
      "            $score = 88;",
      "          } else {",
      "            continue;",
      "          }",
      "        } else {",
      "          if ($normName -eq $target.norm) {",
      "            $score = 100;",
      "          } elseif ($normName.Contains($target.norm)) {",
      "            $score = 90 - [Math]::Min(20, [Math]::Abs($normName.Length - $target.norm.Length));",
      "          } elseif ($target.norm.Contains($normName)) {",
      "            $score = 70 - [Math]::Min(20, [Math]::Abs($target.norm.Length - $normName.Length));",
      "          }",
      "        }",
      "        if ($score -le 0) { continue; }",
      "        $inputLikeTarget = $target.norm -match '(search|message|write|type|input|field|to|recipient|username|email|password|chat)';",
      "        $buttonLikeTarget = $target.norm -match '(send|next|continue|open|chat|done|submit|login|signin|newmessage)';",
      "        $focusable = $el.Current.IsKeyboardFocusable;",
      "        if ($inputLikeTarget) {",
      "          if ($rect.Width -ge 120) { $score += 6; }",
      "          if ($focusable) { $score += 4; } else { $score -= 12; }",
      "          if ($ctype -match 'ControlType.Edit|ControlType.Document|ControlType.ComboBox') { $score += 22; }",
      "          if ($ctype -match 'ControlType.Button|ControlType.Text|ControlType.Hyperlink') { $score -= 14; }",
      "        }",
      "        if ($buttonLikeTarget) {",
      "          if ($ctype -match 'ControlType.Button|ControlType.Hyperlink|ControlType.MenuItem') { $score += 12; }",
      "        }",
      "        if ($target.norm -match 'search' -and $normName -match 'search') { $score += 6; }",
      "        if ($target.norm -match 'message' -and $normName -match 'message') { $score += 6; }",
      "        $x = [int]($rect.Left + ($rect.Width / 2));",
      "        $y = [int]($rect.Top + ($rect.Height / 2));",
      "        try {",
      "          $pt = $el.GetClickablePoint();",
      "          $x = [int]$pt.X;",
      "          $y = [int]$pt.Y;",
      "          $score += 3;",
      "        } catch {}",
      "        $candidate = [PSCustomObject]@{",
      "          score = $score;",
      "          x = $x;",
      "          y = $y;",
      "          target_text = $target.raw;",
      "          matched_name = $combinedName;",
      "        };",
      "        if ($null -eq $best -or $candidate.score -gt $best.score) {",
      "          $best = $candidate;",
      "        }",
      "      }",
      "    } catch {}",
      "  }",
      "  return $best;",
      "}",
      "$foregroundRoot = $null;",
      "try {",
      "  $hwnd = [OperatorNativeWin]::GetForegroundWindow();",
      "  if ($hwnd -ne [IntPtr]::Zero) {",
      "    $foregroundRoot = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd);",
      "  }",
      "} catch {}",
      "$best = Find-BestInRoot $foregroundRoot;",
      "if ($null -eq $best) {",
      "  $best = Find-BestInRoot([System.Windows.Automation.AutomationElement]::RootElement);",
      "}",
      "if ($null -eq $best) {",
      "  Write-Output '{\"found\":false,\"reason\":\"uia_no_match\"}';",
      "  exit 0;",
      "}",
      "$out = @{",
      "  found = $true;",
      "  method = 'uia';",
      "  x = $best.x;",
      "  y = $best.y;",
      "  target_text = $best.target_text;",
      "  matched_name = $best.matched_name;",
      "  score = $best.score;",
      "};",
      "Write-Output (ConvertTo-Json $out -Compress);",
    ].join("\n");
    try {
      const result = await this.runPowerShellScript(actionId, script, {
        sensitive: true,
        displayCommand: "powershell [uia-locate-text]",
      });
      const parsed = this.parseJsonObjectFromText(result.stdout);
      if (!parsed) return { found: false, reason: "uia_parse_failed" };
      const found = Boolean(parsed.found);
      if (!found) {
        return {
          found: false,
          reason: String(parsed.reason ?? "uia_not_found"),
        };
      }
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        return { found: false, reason: "uia_invalid_coords" };
      }
      return {
        found: true,
        x: Math.floor(x),
        y: Math.floor(y),
        target_text: String(parsed.target_text ?? filtered[0]),
        matched_name: String(parsed.matched_name ?? ""),
        score: Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : undefined,
      };
    } catch (error) {
      return {
        found: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async locatePointByVisionText(
    text: string,
    alternatives: string[] = [],
    retries = 2,
    actionId = "vision_locate",
    onVisionParse?: (payload: Record<string, unknown>) => void,
  ): Promise<{ x: number; y: number; target_text: string }> {
    const targets = [text, ...alternatives.map((item) => String(item || "").trim()).filter(Boolean)];
    const normalizedTargets = targets
      .map((item) => this.normalizeLocatorText(item))
      .filter(Boolean);
    if (normalizedTargets.length > 0) {
      const uia = await this.locatePointByUiAutomationText(actionId, targets);
      onVisionParse?.({
        purpose: "locate_text_uia",
        targets,
        found: uia.found,
        reason: uia.reason,
        matched_name: uia.matched_name,
        score: uia.score,
        parsed: uia,
      });
      if (uia.found && Number.isFinite(uia.x) && Number.isFinite(uia.y)) {
        return {
          x: Math.floor(Number(uia.x)),
          y: Math.floor(Number(uia.y)),
          target_text: String(uia.target_text ?? text),
        };
      }
    }
    const maxAttempts = Math.max(1, Math.min(6, retries));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      for (const target of targets) {
        const prompt = [
          "Return JSON only.",
          "Find the center pixel coordinate of the requested UI target.",
          "Schema: {\"found\":true|false,\"x\":number,\"y\":number,\"confidence\":0-1}",
          `Target text: ${target}`,
        ].join("\n");

        const analysis = await this.analyzeScreenWithOllama(prompt, undefined, { force_json: true });
        const parsed = this.parseJsonObjectFromText(String(analysis.analysis ?? ""));
        const screenBounds = this.screenBoundsFromVisionAnalysis(analysis);
        const point = this.extractVisionPointCandidate(parsed, screenBounds);
        const foundSignal = Boolean(parsed?.found ?? parsed?.located ?? parsed?.match ?? parsed?.visible);
        const confidenceRaw = Number(parsed?.confidence ?? parsed?.score ?? parsed?.probability ?? 0);
        const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
        const acceptedPoint = Boolean(point) && (
          (foundSignal && confidence >= 0.3)
          || (!foundSignal && confidence >= 0.82)
        );
        onVisionParse?.({
          purpose: "locate_text",
          attempt,
          target,
          parsed: parsed ?? null,
          found_signal: foundSignal,
          confidence,
          resolved_point: point ?? null,
          accepted_point: acceptedPoint,
          screen_bounds: screenBounds,
          screenshot_path: String(analysis.screenshot_path ?? "") || undefined,
          model: String(analysis.model ?? "") || undefined,
        });
        if (acceptedPoint && point) {
          return {
            x: point.x,
            y: point.y,
            target_text: target,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 240));
    }

    throw new Error(`Vision could not locate target text: ${text}`);
  }

  private async runCommand(
    actionId: string,
    command: string,
    args: string[],
    cwd: string,
    opts?: { tolerateFailure?: boolean; sensitive?: boolean; displayCommand?: string; shell?: boolean },
  ): Promise<{ command: string; cwd: string; exit_code: number; duration_ms: number; stdout: string; stderr: string }> {
    const started = Date.now();

    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: opts?.shell ?? (process.platform === "win32"),
        env: process.env,
      });
      this.currentChild = child;

      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // noop
        }
      }, this.settings.per_action_timeout_ms);

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const pausedInterrupt = this.pauseInterruptRequested && this.paused;
        this.pauseInterruptRequested = false;
        const renderedCommand = opts?.displayCommand
          ? opts.displayCommand
          : opts?.sensitive
            ? `${command} [sensitive-args-hidden]`
            : `${command} ${args.join(" ")}`;
        const result = {
          command: renderedCommand,
          cwd,
          exit_code: code ?? -1,
          duration_ms: Date.now() - started,
          stdout: redactSecrets(stdout).slice(-12000),
          stderr: redactSecrets(stderr).slice(-12000),
        };

        this.logs.emitLog("info", "command_executed", `Command: ${result.command}`, { action_id: actionId, exit_code: result.exit_code }, actionId);

        if (pausedInterrupt) {
          reject(new PauseInterruptedError("Paused by operator. Review and approve to continue.", {
            reason_code: "manual_pause",
            user_handoff: true,
          }));
          return;
        }

        if ((code ?? 1) !== 0 && !opts?.tolerateFailure) {
          reject(new Error(`Command failed (${result.command}) with exit code ${String(code)}: ${result.stderr}`));
          return;
        }

        resolve(result);
      });
    });
  }

  private async runPowerShellScript(
    actionId: string,
    script: string,
    opts?: { sensitive?: boolean; displayCommand?: string },
  ): Promise<{ command: string; cwd: string; exit_code: number; duration_ms: number; stdout: string; stderr: string }> {
    const scriptText = String(script ?? "");
    const tempDir = path.join(DATA_DIR, "tmp-ps");
    await fsp.mkdir(tempDir, { recursive: true });
    const scriptPath = path.join(tempDir, `script-${Date.now()}-${newId().slice(0, 8)}.ps1`);
    await fsp.writeFile(scriptPath, scriptText, "utf8");
    try {
      return await this.runCommand(
        actionId,
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        process.cwd(),
        {
          sensitive: opts?.sensitive ?? true,
          displayCommand: opts?.displayCommand || "powershell [script-file]",
          shell: false,
        },
      );
    } finally {
      await fsp.unlink(scriptPath).catch(() => {
        // noop
      });
    }
  }
}
