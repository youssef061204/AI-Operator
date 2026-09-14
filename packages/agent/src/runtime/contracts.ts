import { z } from "zod";
import { ToolCallSchema, type ToolCall } from "./tools.js";

export const DecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("act"),
      reason: z.string().min(1).max(1000),
      plan: z.array(z.string().max(300)).max(12),
      call: ToolCallSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("finish"), summary: z.string().min(1).max(3000) })
    .strict(),
]);
export type Decision = z.infer<typeof DecisionSchema>;
export const VerificationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file_contains"),
      path: z.string().min(1).max(1000),
      text: z.string().max(10000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command"),
      command: z.string().min(1).max(1000),
      args: z.array(z.string().max(10000)).max(100),
      cwd: z.string().default("."),
    })
    .strict(),
]);
export const TaskRequestSchema = z
  .object({
    objective: z.string().trim().min(3).max(8000),
    verification: z.array(VerificationSchema).min(1).max(8),
    limits: z
      .object({
        maxSteps: z.number().int().min(1).max(100).default(20),
        timeoutMs: z.number().int().min(100).max(3600000).default(300000),
        maxErrors: z.number().int().min(1).max(10).default(3),
      })
      .strict()
      .default({}),
    policy: z.record(z.enum(["ask", "allow_task", "deny"])).default({}),
  })
  .strict();
export type TaskRequest = z.infer<typeof TaskRequestSchema>;
export type Status =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";
export const terminal = (s: Status) =>
  ["completed", "failed", "canceled", "interrupted"].includes(s);
export interface Approval {
  id: string;
  digest: string;
  call: ToolCall;
  reason: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  resources: string[];
  expiresAt: number;
  purpose: "action" | "verification" | "restore";
}
export interface Observation {
  step: number;
  call?: ToolCall;
  result?: Record<string, unknown>;
  error?: string;
}
export interface Task extends TaskRequest {
  id: string;
  status: Status;
  plan: string[];
  steps: number;
  createdAt: number;
  updatedAt: number;
  deadline: number;
  observations: Observation[];
  checkpoints: string[];
  approval?: Approval;
  summary?: string;
  error?: string;
  metrics: {
    modelCalls: number;
    toolCalls: number;
    toolErrors: number;
    modelMs: number;
    toolMs: number;
    tokens: number;
  };
}
export interface TaskEvent {
  seq: number;
  taskId: string;
  type: string;
  at: number;
  data: Record<string, unknown>;
}
export interface ModelContext {
  objective: string;
  plan: string[];
  observations: Observation[];
  verification: TaskRequest["verification"];
  stepsRemaining: number;
}
export interface Provider {
  name: string;
  decide(
    context: ModelContext,
    signal: AbortSignal,
  ): Promise<{ decision: unknown; tokens?: number }>;
}

export const PersistedTaskSchema = TaskRequestSchema.extend({
  id: z.string().min(1),
  status: z.enum([
    "queued",
    "running",
    "awaiting_approval",
    "paused",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ]),
  plan: z.array(z.string()),
  steps: z.number().int().nonnegative(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  deadline: z.number().finite(),
  observations: z.array(
    z.object({
      step: z.number().int().nonnegative(),
      call: ToolCallSchema.optional(),
      result: z.record(z.unknown()).optional(),
      error: z.string().optional(),
    }),
  ),
  checkpoints: z.array(z.string()),
  summary: z.string().optional(),
  error: z.string().optional(),
  approval: z
    .object({
      id: z.string(),
      digest: z.string(),
      call: ToolCallSchema,
      reason: z.string(),
      risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
      resources: z.array(z.string()),
      expiresAt: z.number(),
      purpose: z.enum(["action", "verification", "restore"]),
    })
    .optional(),
  metrics: z.object({
    modelCalls: z.number().nonnegative(),
    toolCalls: z.number().nonnegative(),
    toolErrors: z.number().nonnegative(),
    modelMs: z.number().nonnegative(),
    toolMs: z.number().nonnegative(),
    tokens: z.number().nonnegative(),
  }),
});

const transitions: Record<Status, Status[]> = {
  queued: ["running", "canceled", "failed", "interrupted"],
  running: [
    "awaiting_approval",
    "paused",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ],
  awaiting_approval: ["running", "paused", "failed", "canceled", "interrupted"],
  paused: ["running", "canceled", "failed", "interrupted"],
  completed: [],
  failed: [],
  canceled: [],
  interrupted: [],
};
export function transition(task: Task, next: Status): void {
  if (task.status === next) return;
  if (!transitions[task.status].includes(next))
    throw new Error(`Invalid transition ${task.status} -> ${next}`);
  task.status = next;
  task.updatedAt = Date.now();
}
