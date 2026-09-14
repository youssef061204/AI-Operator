import { z } from "zod";
import { CognitionStateSchema, IntentEntrySchema } from "./schemas.js";

export const LogEventSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),
  level: z.enum(["debug", "info", "warn", "error"]),
  event_type: z.string(),
  action_id: z.string().optional(),
  message: z.string(),
  data: z.record(z.any()).optional(),
});

export const QueueSnapshotSchema = z.object({
  actions: z.array(z.record(z.any())),
  counts: z.object({
    queued: z.number(),
    awaiting_approval: z.number(),
    running: z.number(),
    success: z.number(),
    failed: z.number(),
    canceled: z.number(),
  }),
});

export const CognitionSnapshotSchema = z.object({
  state: CognitionStateSchema,
  goals: z.array(z.record(z.any())).default([]),
  active_goals: z.array(z.record(z.any())).default([]),
  world: z.record(z.any()).default({}),
  memory: z.record(z.any()).default({}),
});

export const IntentEventSchema = IntentEntrySchema;

export type LogEvent = z.infer<typeof LogEventSchema>;
export type QueueSnapshot = z.infer<typeof QueueSnapshotSchema>;
export type CognitionSnapshot = z.infer<typeof CognitionSnapshotSchema>;
export type IntentEvent = z.infer<typeof IntentEventSchema>;
