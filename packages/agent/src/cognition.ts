import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import type {
  ActionEnvelope,
  CognitionGoalRequest,
  CognitionInteractionRequest,
  CognitionState,
  GoalRecord,
  GoalStatus,
  ToolRecord,
} from "@operator-assist/shared";
import {
  CognitionGoalRequestSchema,
  CognitionInteractionRequestSchema,
  CognitionStateSchema,
  GoalRecordSchema,
  GoalStatusSchema,
  ToolRecordSchema,
} from "@operator-assist/shared";

import { type ActionEngine } from "./engine.js";
import { type LogBus } from "./bus.js";
import { type Storage } from "./storage.js";
import { buildPlan } from "./pipeline.js";
import { newId, nowIso, slugify } from "./utils.js";

type WorldModel = {
  system: {
    workspace_projects: string[];
    running_processes: string[];
    local_servers: Record<string, boolean>;
    network_online: boolean;
    cpu_load: number;
    memory_free_mb: number;
    memory_total_mb: number;
  };
  task: {
    queued: number;
    running: number;
    failed: number;
    success: number;
    awaiting_approval: number;
    running_action_id: string | null;
  };
  user: {
    last_interaction_at: string;
    watching: "unknown" | "active" | "passive";
    interruption_count: number;
    manual_input_count: number;
  };
  time: {
    now: string;
  };
};

type RuntimeMemory = {
  user: {
    interruption_count: number;
    manual_input_count: number;
    style: "concise" | "balanced" | "detailed";
    last_interaction_at: string;
  };
  patterns: Array<{
    id: string;
    context: string;
    solution: string;
    outcome: "success" | "failed";
    created_at: string;
  }>;
  projects: Record<string, {
    last_objective: string;
    updated_at: string;
    success_count: number;
    failure_count: number;
  }>;
};

const GOALS_KEY = "cognition_goals_v1";
const STATE_KEY = "cognition_state_v1";
const MEMORY_KEY = "cognition_memory_v1";
const TOOLS_KEY = "cognition_tools_v1";

const priorityWeight: Record<GoalRecord["priority"], number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function clampHistory<T>(arr: T[], max = 60): T[] {
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
}

async function isPortOpen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(240, () => done(false));
  });
}

function listProcesses(): string[] {
  try {
    if (process.platform === "win32") {
      const out = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 1800 });
      if (out.status !== 0) return [];
      return String(out.stdout)
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^"|"$/g, "").split("\",\"")[0])
        .filter(Boolean)
        .slice(0, 60);
    }

    const out = spawnSync("ps", ["-eo", "comm"], { encoding: "utf8", timeout: 1800 });
    if (out.status !== 0) return [];
    return String(out.stdout)
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(1, 61);
  } catch {
    return [];
  }
}

async function checkNetworkOnline(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch("https://example.com", {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

export class CognitionRuntime {
  private running = false;
  private paused = false;
  private cycleInFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private lastVerifiedAt = "";

  private world: WorldModel = {
    system: {
      workspace_projects: [],
      running_processes: [],
      local_servers: {},
      network_online: false,
      cpu_load: 0,
      memory_free_mb: 0,
      memory_total_mb: 0,
    },
    task: {
      queued: 0,
      running: 0,
      failed: 0,
      success: 0,
      awaiting_approval: 0,
      running_action_id: null,
    },
    user: {
      last_interaction_at: "",
      watching: "unknown",
      interruption_count: 0,
      manual_input_count: 0,
    },
    time: {
      now: nowIso(),
    },
  };

  private state: CognitionState;
  private goals: GoalRecord[];
  private tools: ToolRecord[];
  private memory: RuntimeMemory;

  constructor(
    private readonly storage: Storage,
    private readonly bus: LogBus,
    private readonly engine: ActionEngine,
  ) {
    const initialState: CognitionState = {
      running: true,
      paused: false,
      phase: "PERCEIVE",
      current_intent: "Recovering world state",
      micro_thought: "",
      objective: "Awaiting user objective",
      autonomy_behavior: "adaptive",
      observed_user_activity: "unknown",
      last_update_at: nowIso(),
      cycle_count: 0,
      recent_intents: [],
    };

    this.state = CognitionStateSchema.parse(this.storage.getJsonSetting<CognitionState>(STATE_KEY, initialState));
    this.goals = this.storage
      .getJsonSetting<GoalRecord[]>(GOALS_KEY, [])
      .map((goal) => GoalRecordSchema.parse(goal));
    this.tools = this.storage
      .getJsonSetting<ToolRecord[]>(TOOLS_KEY, [])
      .map((tool) => ToolRecordSchema.parse(tool));
    this.memory = this.storage.getJsonSetting<RuntimeMemory>(MEMORY_KEY, {
      user: {
        interruption_count: 0,
        manual_input_count: 0,
        style: "balanced",
        last_interaction_at: nowIso(),
      },
      patterns: [],
      projects: {},
    });

    this.paused = Boolean(this.state.paused);
    this.state.running = true;
    this.state.last_update_at = nowIso();
    this.persist();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emitIntent("Cognition loop online", "Monitoring system and objectives", "running");
    this.schedule(120);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.running = false;
    this.persist();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.state.paused = paused;
    this.state.phase = paused ? "REFLECT" : "PERCEIVE";
    this.state.current_intent = paused ? "Paused by user" : "Resuming autonomous loop";
    this.state.micro_thought = paused ? "Execution body is safely idle" : "Rebuilding context before next action";
    this.state.last_update_at = nowIso();
    this.persist();
    this.broadcastState();
  }

  suspendOperationalGoals(reason = "manual_stop"): void {
    const now = nowIso();
    let changed = 0;
    for (const goal of this.goals) {
      if (goal.status === "ACTIVE" || goal.status === "BLOCKED") {
        goal.status = "SUSPENDED";
        goal.updated_at = now;
        goal.metadata = {
          ...goal.metadata,
          suspended_reason: reason,
          suspended_at: now,
        };
        changed += 1;
      }
    }
    if (changed > 0) {
      this.state.objective = "Awaiting user objective";
      this.state.current_intent = "Operational goals suspended";
      this.state.micro_thought = "Waiting for explicit resume or new command.";
      this.state.last_update_at = now;
      this.persist();
      this.broadcastState();
    }
  }

  getSnapshot(): Record<string, unknown> {
    const activeGoals = this.goals.filter((goal) => goal.status === "ACTIVE" || goal.status === "BLOCKED");
    return {
      state: this.state,
      goals: this.goals,
      active_goals: activeGoals,
      world: this.world,
      memory: {
        user: this.memory.user,
        pattern_count: this.memory.patterns.length,
        project_count: Object.keys(this.memory.projects).length,
      },
    };
  }

  listGoals(): GoalRecord[] {
    return [...this.goals].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  listTools(): ToolRecord[] {
    return [...this.tools].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  upsertGoal(input: CognitionGoalRequest): GoalRecord {
    const req = CognitionGoalRequestSchema.parse(input);
    const now = nowIso();
    const currentActive = this.goals.filter((goal) => goal.status === "ACTIVE");
    for (const goal of currentActive) {
      goal.status = "SUSPENDED";
      goal.updated_at = now;
    }

    const goal: GoalRecord = {
      id: newId(),
      title: req.objective.slice(0, 72),
      objective: req.objective,
      priority: req.priority,
      status: "ACTIVE",
      dependencies: [],
      success_criteria: req.success_criteria,
      reversibility: req.reversibility,
      project_id: req.project_id,
      created_at: now,
      updated_at: now,
      metadata: {
        leverage_estimate: this.estimateLeverage(req.objective),
      },
    };

    this.goals.push(goal);
    this.state.objective = goal.objective;
    this.emitIntent(`New objective accepted: ${goal.title}`, "Goal graph reprioritized", "running", {
      goal_id: goal.id,
      priority: goal.priority,
    });
    this.persist();
    this.broadcastState();
    return goal;
  }

  registerTool(tool: ToolRecord): void {
    const parsed = ToolRecordSchema.parse(tool);
    const idx = this.tools.findIndex((item) => item.id === parsed.id);
    if (idx >= 0) this.tools[idx] = parsed;
    else this.tools.push(parsed);
    this.persist();
  }

  recordInteraction(input: CognitionInteractionRequest): void {
    const event = CognitionInteractionRequestSchema.parse(input);
    const now = nowIso();
    this.memory.user.last_interaction_at = now;
    this.world.user.last_interaction_at = now;

    if (event.kind === "interruption" || event.kind === "pause") {
      this.memory.user.interruption_count += 1;
      this.world.user.interruption_count += 1;
    }
    if (event.kind === "manual_input") {
      this.memory.user.manual_input_count += 1;
      this.world.user.manual_input_count += 1;
    }
    if (typeof event.active === "boolean") {
      this.world.user.watching = event.active ? "active" : "passive";
      this.state.observed_user_activity = this.world.user.watching;
    }
    if (event.kind === "pause") this.setPaused(true);
    if (event.kind === "resume") this.setPaused(false);

    this.updateAutonomyBehavior();
    this.persist();
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.runCycle();
    }, delayMs);
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;
    if (this.cycleInFlight) {
      this.schedule(640);
      return;
    }
    if (this.paused) {
      this.schedule(1200);
      return;
    }

    this.cycleInFlight = true;
    try {
      await this.perceive();
      this.model();
      this.prioritize();
      const actions = this.decide();
      await this.act(actions);
      this.verify();
      this.reflect();
      this.evolve();
      this.state.cycle_count += 1;
      this.state.last_update_at = nowIso();
      this.persist();
      this.broadcastState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.phase = "REFLECT";
      this.state.current_intent = "Recovering from cognition fault";
      this.state.micro_thought = message.slice(0, 160);
      this.bus.emitLog("error", "cognition_cycle_error", "Cognition cycle failed", { error: message });
      this.broadcastState();
    } finally {
      this.cycleInFlight = false;
      this.schedule(this.state.observed_user_activity === "active" ? 1300 : 780);
    }
  }

  private async perceive(): Promise<void> {
    this.state.phase = "PERCEIVE";
    this.state.current_intent = "Perceiving system and user context";
    this.state.micro_thought = "Updating live world model";

    const workspaceRoot = this.engine.settings.workspace_root;
    const status = this.engine.getOperatorStatus() as Record<string, unknown>;
    const counts = (status.counts ?? {}) as Record<string, number>;

    const [networkOnline, server3000, server7788, server5173] = await Promise.all([
      checkNetworkOnline(),
      isPortOpen(3000),
      isPortOpen(7788),
      isPortOpen(5173),
    ]);

    let workspaceProjects: string[] = [];
    try {
      const entries = await import("node:fs/promises").then((fs) => fs.readdir(workspaceRoot, { withFileTypes: true }));
      workspaceProjects = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .slice(0, 80);
    } catch {
      workspaceProjects = [];
    }

    const memTotal = os.totalmem();
    const memFree = os.freemem();

    this.world = {
      system: {
        workspace_projects: workspaceProjects,
        running_processes: listProcesses(),
        local_servers: {
          "127.0.0.1:3000": server3000,
          "127.0.0.1:5173": server5173,
          "127.0.0.1:7788": server7788,
        },
        network_online: networkOnline,
        cpu_load: Number(os.loadavg()[0] ?? 0),
        memory_free_mb: Math.round(memFree / (1024 * 1024)),
        memory_total_mb: Math.round(memTotal / (1024 * 1024)),
      },
      task: {
        queued: Number(counts.queued ?? 0),
        running: Number(counts.running ?? 0),
        failed: Number(counts.failed ?? 0),
        success: Number(counts.success ?? 0),
        awaiting_approval: Number(counts.awaiting_approval ?? 0),
        running_action_id: typeof status.running_action_id === "string" ? status.running_action_id : null,
      },
      user: {
        last_interaction_at: this.memory.user.last_interaction_at,
        watching: this.world.user.watching,
        interruption_count: this.memory.user.interruption_count,
        manual_input_count: this.memory.user.manual_input_count,
      },
      time: {
        now: nowIso(),
      },
    };
  }

  private model(): void {
    this.state.phase = "UNDERSTAND";
    this.state.current_intent = "Modeling what exists and what is missing";

    const active = this.goals.find((goal) => goal.status === "ACTIVE") ?? this.goals[0];
    if (active) {
      this.state.objective = active.objective;
      this.state.micro_thought = `Top leverage path selected for ${active.title.slice(0, 48)}`;
      return;
    }

    if (this.world.system.workspace_projects.length > 0) {
      this.state.objective = "Improve and launch highest-potential existing asset";
      this.state.micro_thought = "No active goal. Falling back to value-creation meta-loop.";
    } else {
      this.state.objective = "Awaiting user objective";
      this.state.micro_thought = "Standing by while maintaining situational awareness.";
    }
  }

  private prioritize(): void {
    this.state.phase = "DECIDE";
    this.state.current_intent = "Prioritizing goal graph";

    if (this.goals.length === 0 && this.world.system.workspace_projects.length > 0) {
      const inferred = this.world.system.workspace_projects[0] ?? "existing project";
      this.goals.push({
        id: newId(),
        title: `Optimize ${inferred}`,
        objective: `Improve and stabilize project ${inferred} with measurable conversion and reliability gains`,
        priority: "MEDIUM",
        status: "ACTIVE",
        dependencies: [],
        success_criteria: ["Build passes", "Preview is running", "Core conversion path exists"],
        reversibility: "REVERSIBLE",
        project_id: inferred,
        created_at: nowIso(),
        updated_at: nowIso(),
        metadata: {
          inferred: true,
          leverage_estimate: 2,
        },
      });
      this.emitIntent("Inferred objective from existing assets", "Switching to background value creation", "running");
    }

    const scored = this.goals
      .map((goal) => {
        const leverage = Number(goal.metadata?.leverage_estimate ?? this.estimateLeverage(goal.objective));
        const dependencyPenalty = goal.dependencies.length > 0 ? 0.2 : 0;
        const suspendedReason = String(goal.metadata?.suspended_reason ?? "");
        const suspendLocked = goal.status === "SUSPENDED" && (suspendedReason === "kill_switch" || suspendedReason === "manual_stop");
        const statusMultiplier = suspendLocked ? 0 : goal.status === "BLOCKED" ? 0.3 : goal.status === "SUSPENDED" ? 0.6 : 1;
        const score = (priorityWeight[goal.priority] + leverage - dependencyPenalty) * statusMultiplier;
        return { goal, score };
      })
      .filter((item) => item.score > 0);

    scored.sort((a, b) => b.score - a.score || b.goal.updated_at.localeCompare(a.goal.updated_at));
    const top = scored[0]?.goal;
    for (const goal of this.goals) {
      if (!top) {
        if (goal.status === "ACTIVE") goal.status = "SUSPENDED";
        goal.updated_at = nowIso();
        continue;
      }
      if (goal.id === top.id) goal.status = goal.status === "BLOCKED" ? "BLOCKED" : "ACTIVE";
      else if (goal.status === "ACTIVE") goal.status = "SUSPENDED";
      goal.updated_at = nowIso();
    }
  }

  private decide(): ActionEnvelope[] {
    this.state.phase = "DECIDE";
    this.state.current_intent = "Deciding next highest-leverage actions";

    if (this.world.task.running > 0 || this.world.task.queued > 0) {
      this.state.micro_thought = "Execution body already occupied; keeping queue stable.";
      return [];
    }

    const active = this.goals.find((goal) => goal.status === "ACTIVE");
    if (!active) {
      this.state.micro_thought = "No active goal available.";
      return [];
    }

    const lastPlannedAt = String(active.metadata?.last_planned_at ?? "");
    if (lastPlannedAt) {
      const diff = Date.now() - Date.parse(lastPlannedAt);
      if (Number.isFinite(diff) && diff < 7000) {
        this.state.micro_thought = "Recent plan exists; waiting for verification window.";
        return [];
      }
    }

    const specialists = this.spawnSpecialists(active.objective);
    this.state.micro_thought = specialists[0] ?? "Generating adaptive plan.";

    const actions = this.buildActionsForGoal(active);
    active.metadata = {
      ...active.metadata,
      last_planned_at: nowIso(),
      specialist_notes: specialists,
    };
    active.updated_at = nowIso();
    return actions;
  }

  private async act(actions: ActionEnvelope[]): Promise<void> {
    this.state.phase = "ACT";
    if (actions.length === 0) return;

    const summary = actions[0]?.description ?? "Executing queued actions";
    this.state.current_intent = summary;
    this.emitIntent(summary, this.state.micro_thought || "Dispatching to execution body", "running", {
      action_count: actions.length,
    });

    this.engine.pushActions(actions);
  }

  private verify(): void {
    this.state.phase = "VERIFY";
    this.state.current_intent = "Verifying action outcomes";

    const actions = this.engine.listActions();
    const recent = actions
      .filter((action) => ["SUCCESS", "FAILED", "CANCELED"].includes(action.state))
      .filter((action) => !this.lastVerifiedAt || String(action.updated_at ?? action.created_at) > this.lastVerifiedAt)
      .sort((a, b) => String(a.updated_at ?? a.created_at).localeCompare(String(b.updated_at ?? b.created_at)));

    if (recent.length === 0) {
      this.state.micro_thought = "No new terminal actions to verify.";
      return;
    }

    const latest = recent[recent.length - 1];
    this.lastVerifiedAt = String(latest.updated_at ?? latest.created_at);

    for (const action of recent) {
      if (action.state === "SUCCESS") {
        this.memory.patterns.push({
          id: newId(),
          context: action.description,
          solution: action.type,
          outcome: "success",
          created_at: nowIso(),
        });
      } else if (action.state === "FAILED") {
        this.memory.patterns.push({
          id: newId(),
          context: action.description,
          solution: action.type,
          outcome: "failed",
          created_at: nowIso(),
        });
      }

      if (action.type === "SYNTHESIZE_TOOL" && action.result) {
        const tool = action.result.tool as ToolRecord | undefined;
        if (tool) this.registerTool(tool);
      }
      if (action.type === "RUN_SYNTHESIZED_TOOL" && action.result) {
        const toolId = String(action.result.tool_id ?? "");
        if (toolId) {
          const index = this.tools.findIndex((item) => item.id === toolId);
          if (index >= 0) {
            const current = this.tools[index];
            const now = nowIso();
            this.tools[index] = {
              ...current,
              last_used_at: now,
              updated_at: now,
              success_count: current.success_count + (action.state === "SUCCESS" ? 1 : 0),
            };
          }
        }
      }
    }

    this.memory.patterns = clampHistory(this.memory.patterns, 220);

    const active = this.goals.find((goal) => goal.status === "ACTIVE" || goal.status === "BLOCKED");
    if (!active) return;

    const lastPlannedAt = String(active.metadata?.last_planned_at ?? "");
    const goalActions = actions.filter((action) => {
      if (!action.project_id || !active.project_id) return false;
      if (action.project_id !== active.project_id) return false;
      if (!lastPlannedAt) return true;
      return String(action.created_at) >= lastPlannedAt;
    });
    if (goalActions.length > 0) {
      const hasFailure = goalActions.some((action) => action.state === "FAILED");
      const allTerminal = goalActions.every((action) => ["SUCCESS", "FAILED", "CANCELED"].includes(action.state));
      const allSuccess = allTerminal && goalActions.every((action) => action.state === "SUCCESS");

      if (allSuccess) {
        active.status = "DONE";
        active.updated_at = nowIso();
        this.emitIntent(`Goal completed: ${active.title}`, "All planned actions verified", "completed");
      } else if (hasFailure) {
        active.status = "BLOCKED";
        active.updated_at = nowIso();
        this.emitIntent(`Goal blocked: ${active.title}`, "Switching strategy after verification failure", "blocked");
      }
    }
  }

  private reflect(): void {
    this.state.phase = "REFLECT";
    this.state.current_intent = "Reflecting on strategy quality";

    const failed = this.world.task.failed;
    const completed = this.world.task.success;
    if (failed > 0 && failed >= completed) {
      this.state.micro_thought = "Failure pressure is high; pivoting to safer reversible actions.";
      const active = this.goals.find((goal) => goal.status === "BLOCKED");
      if (active) {
        active.metadata = {
          ...active.metadata,
          recovery_mode: true,
        };
      }
      return;
    }

    this.state.micro_thought = "Current trajectory remains viable.";
  }

  private evolve(): void {
    this.state.phase = "UPDATE_SELF";
    this.state.current_intent = "Updating memory and capabilities";

    this.updateAutonomyBehavior();

    const active = this.goals.find((goal) => goal.status === "ACTIVE");
    if (active?.project_id) {
      const record = this.memory.projects[active.project_id] ?? {
        last_objective: active.objective,
        updated_at: nowIso(),
        success_count: 0,
        failure_count: 0,
      };
      record.last_objective = active.objective;
      record.updated_at = nowIso();
      this.memory.projects[active.project_id] = record;
    }

    for (const tool of this.tools) {
      if (tool.failure_count >= 3 && tool.success_count === 0 && tool.status !== "retired") {
        tool.status = "deprecated";
        tool.updated_at = nowIso();
      }
    }
  }

  private updateAutonomyBehavior(): void {
    const interruptions = this.memory.user.interruption_count;
    const manualInputs = this.memory.user.manual_input_count;

    if (interruptions >= manualInputs + 3) {
      this.state.autonomy_behavior = "explanatory";
    } else if (manualInputs >= interruptions + 4) {
      this.state.autonomy_behavior = "fast";
    } else {
      this.state.autonomy_behavior = "adaptive";
    }
  }

  private estimateLeverage(objective: string): number {
    const text = objective.toLowerCase();
    let score = 1;
    if (/launch|deploy|ship|release/.test(text)) score += 2;
    if (/revenue|sales|conversion|pricing|payment|subscription/.test(text)) score += 2;
    if (/website|landing|product/.test(text)) score += 1;
    if (/outreach|lead|growth/.test(text)) score += 1;
    return score;
  }

  private detectCapabilityGap(objective: string): { capability: string; purpose: string } | null {
    const text = objective.toLowerCase();
    if (/payment|subscription|billing|checkout/.test(text)) {
      if (!this.tools.some((tool) => tool.capability === "payments.integration" && tool.status === "ready")) {
        return {
          capability: "payments.integration",
          purpose: "Generate reusable payment integration module and wiring scripts",
        };
      }
    }

    if (/deploy|release|launch/.test(text)) {
      if (!this.tools.some((tool) => tool.capability === "deploy.optimizer" && tool.status === "ready")) {
        return {
          capability: "deploy.optimizer",
          purpose: "Build deployment consistency checks and retry tool",
        };
      }
    }

    if (/outreach|lead|research/.test(text)) {
      if (!this.tools.some((tool) => tool.capability === "lead.research" && tool.status === "ready")) {
        return {
          capability: "lead.research",
          purpose: "Build reusable lead research and enrichment tool",
        };
      }
    }

    return null;
  }

  private spawnSpecialists(objective: string): string[] {
    const text = objective.toLowerCase();
    const notes: string[] = [];
    if (/website|landing|design/.test(text)) notes.push("Design optimizer is evaluating conversion clarity");
    if (/outreach|lead|growth/.test(text)) notes.push("Growth operator is proposing distribution sequence");
    if (/deploy|infra|performance/.test(text)) notes.push("Code architect is minimizing launch risk");
    if (notes.length === 0) notes.push("Product strategist is selecting highest-leverage next step");
    return notes;
  }

  private buildActionsForGoal(goal: GoalRecord): ActionEnvelope[] {
    const now = nowIso();
    const runId = newId();
    const plan = buildPlan(goal.objective);
    const workspaceRoot = this.engine.settings.workspace_root;
    const projectId = goal.project_id || `${slugify(plan.offer.offer_name)}-${goal.id.slice(0, 8)}`;
    const projectDir = path.join(workspaceRoot, projectId);

    if (!goal.project_id) {
      goal.project_id = projectId;
      goal.updated_at = now;
    }

    const createAction = (params: {
      type: ActionEnvelope["type"];
      description: string;
      risk: ActionEnvelope["risk_level"];
      permissions: string[];
      inputs: Record<string, unknown>;
    }): ActionEnvelope => ({
      id: newId(),
      run_id: runId,
      project_id: projectId,
      type: params.type,
      description: params.description,
      risk_level: params.risk,
      required_permissions: params.permissions,
      inputs: params.inputs,
      state: "QUEUED",
      created_at: now,
      updated_at: now,
    });

    const actions: ActionEnvelope[] = [];

    const capabilityGap = this.detectCapabilityGap(goal.objective);
    if (capabilityGap) {
      actions.push(createAction({
        type: "SYNTHESIZE_TOOL",
        description: `Design and build tool: ${capabilityGap.capability}`,
        risk: "MEDIUM",
        permissions: ["filesystem.write", "cli.node"],
        inputs: {
          capability: capabilityGap.capability,
          purpose: capabilityGap.purpose,
          project_id: projectId,
          sample_input: { objective: goal.objective },
        },
      }));
    }

    const text = goal.objective.toLowerCase();

    if (/website|landing|site|launch|product/.test(text)) {
      actions.push(
        createAction({
          type: "CREATE_BUSINESS_FOLDER",
          description: "Create local project structure",
          risk: "MEDIUM",
          permissions: ["filesystem.write"],
          inputs: {
            workspace_root: workspaceRoot,
            project_slug: projectId,
            project_dir: projectDir,
          },
        }),
        createAction({
          type: "SCAFFOLD_NEXTJS_SITE",
          description: "Write local website codebase",
          risk: "MEDIUM",
          permissions: ["filesystem.write"],
          inputs: {
            project_dir: projectDir,
            offer_name: plan.offer.offer_name,
            offer_value: plan.offer.offer_value,
            niche: plan.offer.niche,
            city: plan.offer.city,
            bullets: plan.offer.offer_bullets,
          },
        }),
        createAction({
          type: "INSTALL_DEPENDENCIES",
          description: "Install local dependencies",
          risk: "MEDIUM",
          permissions: ["cli.package_manager"],
          inputs: {
            project_dir: projectDir,
            package_manager: "npm",
          },
        }),
        createAction({
          type: "START_LOCAL_PREVIEW",
          description: "Start live local preview server",
          risk: "LOW",
          permissions: ["cli.process"],
          inputs: {
            project_dir: projectDir,
            command: "npm run dev -- --port 3000",
            port: 3000,
          },
        }),
        createAction({
          type: "CHECK_SERVER_HEALTH",
          description: "Verify live preview availability",
          risk: "LOW",
          permissions: ["network.local"],
          inputs: {
            url: "http://127.0.0.1:3000",
            expected_status: 200,
          },
        }),
      );

      if (/launch now|deploy|ship/.test(text)) {
        actions.push(createAction({
          type: "DEPLOY_SITE",
          description: `Deploy with ${this.engine.settings.provider}`,
          risk: "HIGH",
          permissions: ["network.deploy"],
          inputs: {
            project_dir: projectDir,
            provider: this.engine.settings.provider,
            prod: true,
          },
        }));
      }
    }

    if (/outreach|lead|growth|prospect/.test(text)) {
      actions.push(
        createAction({
          type: "LOCAL_RESEARCH",
          description: "Research targets and market signals",
          risk: "LOW",
          permissions: ["network.request"],
          inputs: {
            query: `${plan.offer.niche} ${plan.offer.city} outreach strategy`,
            max_results: 6,
            sources: [],
          },
        }),
        createAction({
          type: "GMAIL_DRAFTS",
          description: "Generate outreach draft stack",
          risk: "MEDIUM",
          permissions: ["filesystem.write", "browser.open_tab"],
          inputs: {
            project_dir: projectDir,
            drafts: plan.outreach_drafts,
            compose_urls: [],
          },
        }),
      );
    }

    if (actions.length === 0) {
      actions.push(createAction({
        type: "PLAN_GOAL",
        description: "Model objective and produce execution hypotheses",
        risk: "LOW",
        permissions: ["planning"],
        inputs: { goal: goal.objective },
      }));
    }

    return actions;
  }

  private emitIntent(intent: string, microThought: string, status: "running" | "completed" | "blocked" | "failed", data?: Record<string, unknown>): void {
    const entry = {
      id: newId(),
      intent,
      objective: this.state.objective,
      phase: this.state.phase,
      status,
      micro_thought: microThought,
      created_at: nowIso(),
      data: data ?? {},
    };

    this.state.recent_intents = clampHistory([...this.state.recent_intents, entry], 40);
    this.state.current_intent = intent;
    this.state.micro_thought = microThought;
    this.state.last_update_at = nowIso();
    this.bus.broadcast({ type: "intent_event", data: entry });
  }

  private broadcastState(): void {
    this.bus.broadcast({ type: "cognition_state", data: this.getSnapshot() });
  }

  private persist(): void {
    this.storage.setJsonSetting(STATE_KEY, this.state);
    this.storage.setJsonSetting(GOALS_KEY, this.goals);
    this.storage.setJsonSetting(TOOLS_KEY, this.tools);
    this.storage.setJsonSetting(MEMORY_KEY, this.memory);
  }

  updateGoalStatus(goalId: string, status: GoalStatus): GoalRecord {
    const parsedStatus = GoalStatusSchema.parse(status);
    const goal = this.goals.find((item) => item.id === goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    goal.status = parsedStatus;
    goal.updated_at = nowIso();
    this.persist();
    this.broadcastState();
    return goal;
  }
}
