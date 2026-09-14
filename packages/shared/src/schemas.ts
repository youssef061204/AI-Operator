import { z } from "zod";

export const ActionStateSchema = z.enum([
  "QUEUED",
  "AWAITING_APPROVAL",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "CANCELED",
]);

export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const BrowserAutomationModeSchema = z.enum(["playwright", "browser"]);
export const DeployProviderSchema = z.enum(["vercel", "netlify"]);
export const ControlModeSchema = z.enum(["assistive", "operator"]);

export const ActionTypeSchema = z.enum([
  "PLAN_GOAL",
  "CREATE_BUSINESS_FOLDER",
  "SCAFFOLD_NEXTJS_SITE",
  "GIT_INIT",
  "INSTALL_DEPENDENCIES",
  "OPEN_TABS",
  "GMAIL_DRAFTS",
  "OPEN_LOVABLE",
  "LOVABLE_AUTOMATE",
  "PUBLISH_GITHUB",
  "DEPLOY_SITE",
  "LOCAL_RESEARCH",
  "START_LOCAL_PREVIEW",
  "CHECK_SERVER_HEALTH",
  "SYNTHESIZE_TOOL",
  "RUN_SYNTHESIZED_TOOL",
  "OS_DEMO_CONTROL",
  "OS_INPUT_CONTROL",
]);

export const PlanGoalInputSchema = z.object({
  goal: z.string().min(3),
});

export const CreateBusinessFolderInputSchema = z.object({
  workspace_root: z.string().min(1),
  project_slug: z.string().min(1).optional(),
  project_dir: z.string().min(1).optional(),
});

export const ScaffoldNextJsInputSchema = z.object({
  project_dir: z.string().min(1),
  offer_name: z.string().min(1),
  offer_value: z.string().min(1),
  niche: z.string().min(1),
  city: z.string().min(1),
  bullets: z.array(z.string().min(1)).default([]),
});

export const GitInitInputSchema = z.object({
  project_dir: z.string().min(1),
});

export const InstallDependenciesInputSchema = z.object({
  project_dir: z.string().min(1),
  package_manager: z.enum(["npm", "pnpm"]).default("npm"),
});

export const OpenTabsInputSchema = z.object({
  urls: z.array(z.string().url()).min(1),
});

export const GmailDraftsInputSchema = z.object({
  project_dir: z.string().min(1),
  drafts: z.array(z.string().min(1)).default([]),
  compose_urls: z.array(z.string().url()).default([]),
});

export const OpenLovableInputSchema = z.object({
  prompt: z.string().min(3),
});

export const LovableAutomateInputSchema = z.object({
  prompt: z.string().min(3),
  revision: z.boolean().default(false),
});

export const PublishGithubInputSchema = z.object({
  project_dir: z.string().min(1),
  repo_name: z.string().min(1),
  private: z.boolean().default(true),
});

export const DeploySiteInputSchema = z.object({
  project_dir: z.string().min(1),
  provider: DeployProviderSchema,
  prod: z.boolean().default(false),
});

export const LocalResearchInputSchema = z.object({
  query: z.string().min(3),
  max_results: z.number().int().min(1).max(20).default(6),
  sources: z.array(z.string().url()).default([]),
});

export const StartLocalPreviewInputSchema = z.object({
  project_dir: z.string().min(1),
  command: z.string().min(1).default("npm run dev"),
  port: z.number().int().positive().default(3000),
});

export const CheckServerHealthInputSchema = z.object({
  url: z.string().url(),
  expected_status: z.number().int().min(100).max(599).default(200),
});

export const SynthesizeToolInputSchema = z.object({
  capability: z.string().min(2),
  purpose: z.string().min(3),
  project_id: z.string().min(1).optional(),
  sample_input: z.record(z.any()).default({}),
});

export const RunSynthesizedToolInputSchema = z.object({
  tool_id: z.string().min(1),
  input: z.record(z.any()).default({}),
});

export const OsDemoControlInputSchema = z.object({
  scenario: z.enum(["cursor", "full", "smoke"]).default("full"),
  text: z.string().default("Operator control demo is running."),
  duration_ms: z.number().int().min(300).max(30000).default(3500),
});

export const OsInputStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("move"),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    duration_ms: z.number().int().min(0).max(5000).default(180),
  }),
  z.object({
    kind: z.literal("drag"),
    from_x: z.number().int().min(0),
    from_y: z.number().int().min(0),
    to_x: z.number().int().min(0),
    to_y: z.number().int().min(0),
    duration_ms: z.number().int().min(60).max(10000).default(420),
    button: z.enum(["left", "right"]).default("left"),
  }),
  z.object({
    kind: z.literal("click"),
    button: z.enum(["left", "right"]).default("left"),
    count: z.number().int().min(1).max(3).default(1),
  }),
  z.object({
    kind: z.literal("scroll"),
    delta: z.number().int().min(-2400).max(2400),
    repeats: z.number().int().min(1).max(20).default(1),
    delay_ms: z.number().int().min(0).max(1000).default(70),
  }),
  z.object({
    kind: z.literal("vision_click_text"),
    text: z.string().min(1).max(120),
    alternatives: z.array(z.string().min(1).max(120)).max(4).default([]),
    button: z.enum(["left", "right"]).default("left"),
    retries: z.number().int().min(1).max(6).default(2),
  }),
  z.object({
    kind: z.literal("type"),
    text: z.string().min(1).max(400),
  }),
  z.object({
    kind: z.literal("key"),
    key: z.string().min(1).max(32),
  }),
  z.object({
    kind: z.literal("hotkey"),
    keys: z.array(z.string().min(1).max(32)).min(1).max(4),
  }),
  z.object({
    kind: z.literal("delay"),
    ms: z.number().int().min(10).max(10000),
  }),
]);

export const OsInputControlInputSchema = z.object({
  objective: z.string().min(3),
  steps: z.array(OsInputStepSchema).default([]),
  dry_run: z.boolean().default(false),
});

export const ActionInputsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PLAN_GOAL"), data: PlanGoalInputSchema }),
  z.object({ type: z.literal("CREATE_BUSINESS_FOLDER"), data: CreateBusinessFolderInputSchema }),
  z.object({ type: z.literal("SCAFFOLD_NEXTJS_SITE"), data: ScaffoldNextJsInputSchema }),
  z.object({ type: z.literal("GIT_INIT"), data: GitInitInputSchema }),
  z.object({ type: z.literal("INSTALL_DEPENDENCIES"), data: InstallDependenciesInputSchema }),
  z.object({ type: z.literal("OPEN_TABS"), data: OpenTabsInputSchema }),
  z.object({ type: z.literal("GMAIL_DRAFTS"), data: GmailDraftsInputSchema }),
  z.object({ type: z.literal("OPEN_LOVABLE"), data: OpenLovableInputSchema }),
  z.object({ type: z.literal("LOVABLE_AUTOMATE"), data: LovableAutomateInputSchema }),
  z.object({ type: z.literal("PUBLISH_GITHUB"), data: PublishGithubInputSchema }),
  z.object({ type: z.literal("DEPLOY_SITE"), data: DeploySiteInputSchema }),
  z.object({ type: z.literal("LOCAL_RESEARCH"), data: LocalResearchInputSchema }),
  z.object({ type: z.literal("START_LOCAL_PREVIEW"), data: StartLocalPreviewInputSchema }),
  z.object({ type: z.literal("CHECK_SERVER_HEALTH"), data: CheckServerHealthInputSchema }),
  z.object({ type: z.literal("SYNTHESIZE_TOOL"), data: SynthesizeToolInputSchema }),
  z.object({ type: z.literal("RUN_SYNTHESIZED_TOOL"), data: RunSynthesizedToolInputSchema }),
  z.object({ type: z.literal("OS_DEMO_CONTROL"), data: OsDemoControlInputSchema }),
  z.object({ type: z.literal("OS_INPUT_CONTROL"), data: OsInputControlInputSchema }),
]);

export const ActionEnvelopeSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  project_id: z.string().min(1).optional(),
  type: ActionTypeSchema,
  description: z.string().min(1),
  risk_level: RiskLevelSchema,
  required_permissions: z.array(z.string().min(1)).default([]),
  inputs: z.record(z.any()).default({}),
  state: ActionStateSchema.default("QUEUED"),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
  result: z.record(z.any()).optional(),
  error: z.string().optional(),
});

export const QueuePushRequestSchema = z.object({
  actions: z.array(ActionEnvelopeSchema).min(1),
});

export const ActionDecisionSchema = z.object({
  id: z.string().min(1),
});

export const DeviceRegisterRequestSchema = z.object({
  pairing_code: z.string().min(4).max(64),
  device_name: z.string().min(1).max(120),
  device_id: z.string().min(1).max(120).optional(),
});

export const PermissionGrantScopeSchema = z.enum(["once", "session", "always"]);

export const PermissionGrantRequestSchema = z.object({
  permissions: z.array(z.string().min(1)).min(1),
  scope: PermissionGrantScopeSchema.default("once"),
  action_id: z.string().min(1).optional(),
});

export const GoalPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const GoalStatusSchema = z.enum(["PLANNED", "ACTIVE", "BLOCKED", "SUSPENDED", "DONE", "FAILED", "RETIRED"]);
export const GoalReversibilitySchema = z.enum(["REVERSIBLE", "CAUTION", "IRREVERSIBLE"]);

export const GoalRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(2),
  objective: z.string().min(3),
  priority: GoalPrioritySchema.default("MEDIUM"),
  status: GoalStatusSchema.default("PLANNED"),
  dependencies: z.array(z.string().min(1)).default([]),
  success_criteria: z.array(z.string().min(3)).default([]),
  reversibility: GoalReversibilitySchema.default("REVERSIBLE"),
  project_id: z.string().min(1).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  metadata: z.record(z.any()).default({}),
});

export const CognitionPhaseSchema = z.enum([
  "PERCEIVE",
  "UNDERSTAND",
  "DECIDE",
  "ACT",
  "VERIFY",
  "REFLECT",
  "UPDATE_SELF",
]);

export const IntentStatusSchema = z.enum(["running", "completed", "blocked", "failed"]);
export const AutonomyBehaviorSchema = z.enum(["adaptive", "fast", "explanatory", "manual_assist"]);

export const IntentEntrySchema = z.object({
  id: z.string().min(1),
  intent: z.string().min(2),
  objective: z.string().min(2),
  phase: CognitionPhaseSchema,
  status: IntentStatusSchema.default("running"),
  micro_thought: z.string().optional(),
  created_at: z.string().datetime(),
  data: z.record(z.any()).default({}),
});

export const CognitionStateSchema = z.object({
  running: z.boolean().default(true),
  paused: z.boolean().default(false),
  phase: CognitionPhaseSchema.default("PERCEIVE"),
  current_intent: z.string().default("Monitoring system state"),
  micro_thought: z.string().default(""),
  objective: z.string().default("Awaiting user objective"),
  autonomy_behavior: AutonomyBehaviorSchema.default("adaptive"),
  observed_user_activity: z.enum(["unknown", "active", "passive"]).default("unknown"),
  last_update_at: z.string().datetime(),
  cycle_count: z.number().int().nonnegative().default(0),
  recent_intents: z.array(IntentEntrySchema).default([]),
});

export const ToolStatusSchema = z.enum(["ready", "deprecated", "retired"]);

export const ToolRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(2),
  capability: z.string().min(2),
  purpose: z.string().min(3),
  entrypoint: z.string().min(1),
  project_id: z.string().min(1).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_used_at: z.string().datetime().optional(),
  success_count: z.number().int().nonnegative().default(0),
  failure_count: z.number().int().nonnegative().default(0),
  status: ToolStatusSchema.default("ready"),
  sandboxed: z.boolean().default(true),
  metadata: z.record(z.any()).default({}),
});

export const CognitionGoalRequestSchema = z.object({
  objective: z.string().min(3),
  priority: GoalPrioritySchema.default("HIGH"),
  project_id: z.string().min(1).optional(),
  success_criteria: z.array(z.string().min(3)).default([]),
  reversibility: GoalReversibilitySchema.default("REVERSIBLE"),
});

export const CognitionInteractionRequestSchema = z.object({
  kind: z.enum(["manual_input", "interruption", "pause", "resume", "observation"]),
  detail: z.string().default(""),
  active: z.boolean().optional(),
});

export const AgentSettingsSchema = z.object({
  approval_mode: z.boolean().default(true),
  desktop_popups: z.boolean().default(true),
  browser_automation_mode: BrowserAutomationModeSchema.default("browser"),
  workspace_root: z.string().min(1),
  provider: DeployProviderSchema.default("vercel"),
  telemetry_enabled: z.boolean().default(false),
  per_action_timeout_ms: z.number().int().positive().default(240000),
  always_allow_permissions: z.array(z.string().min(1)).default([]),
  dry_run_mode: z.boolean().default(false),
  control_mode: ControlModeSchema.default("operator"),
  voice_mode: z.boolean().default(false),
  focus_mode: z.boolean().default(false),
  memory_notes: z.string().default(""),
  autonomous_runtime: z.boolean().default(true),
  intent_stream_compact: z.boolean().default(true),
  irreversible_action_guard: z.enum(["none", "high", "critical"]).default("high"),
});

export const UpdateSettingsSchema = AgentSettingsSchema.partial();

export const PipelineRequestSchema = z.object({
  goal: z.string().min(3),
  provider: DeployProviderSchema.default("vercel"),
  automation_mode: BrowserAutomationModeSchema.default("browser"),
  workspace_root: z.string().min(1),
});

export type ActionState = z.infer<typeof ActionStateSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;
export type QueuePushRequest = z.infer<typeof QueuePushRequestSchema>;
export type ActionDecision = z.infer<typeof ActionDecisionSchema>;
export type DeviceRegisterRequest = z.infer<typeof DeviceRegisterRequestSchema>;
export type PermissionGrantScope = z.infer<typeof PermissionGrantScopeSchema>;
export type PermissionGrantRequest = z.infer<typeof PermissionGrantRequestSchema>;
export type GoalPriority = z.infer<typeof GoalPrioritySchema>;
export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type GoalReversibility = z.infer<typeof GoalReversibilitySchema>;
export type GoalRecord = z.infer<typeof GoalRecordSchema>;
export type CognitionPhase = z.infer<typeof CognitionPhaseSchema>;
export type IntentEntry = z.infer<typeof IntentEntrySchema>;
export type CognitionState = z.infer<typeof CognitionStateSchema>;
export type ToolRecord = z.infer<typeof ToolRecordSchema>;
export type CognitionGoalRequest = z.infer<typeof CognitionGoalRequestSchema>;
export type CognitionInteractionRequest = z.infer<typeof CognitionInteractionRequestSchema>;
export type OsInputStep = z.infer<typeof OsInputStepSchema>;
export type OsInputControlInput = z.infer<typeof OsInputControlInputSchema>;
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;
export type PipelineRequest = z.infer<typeof PipelineRequestSchema>;
