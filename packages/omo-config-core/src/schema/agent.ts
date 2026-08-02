import * as z from "zod"

import { OmoFallbackModelObjectSchema, OmoReasoningEffortSchema } from "./fallback-models"

/**
 * An agent model chain entry. A bare string keeps every existing config parsing unchanged; the
 * object form shares the same request settings as category and fallback model entries.
 */
export const OmoAgentModelEntrySchema = z.union([
  z.string(),
  OmoFallbackModelObjectSchema,
])

export const OmoAgentDefSchema = z.object({
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  models: z.array(OmoAgentModelEntrySchema).min(1).optional(),
  variant: z.string().optional(),
  reasoningEffort: OmoReasoningEffortSchema.optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  execution_mode: z.enum(["in-process", "process"]).optional(),
  background: z.boolean().optional(),
  max_depth: z.number().int().nonnegative().optional(),
  allowed_subagents: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  max_turns: z.number().int().nonnegative().optional(),
  temperature: z.number().min(0).max(2).optional(),
  disable: z.boolean().optional(),
}).strict()

export const OmoAgentsConfigSchema = z.record(z.string(), OmoAgentDefSchema)

export type OmoAgentModelEntry = z.infer<typeof OmoAgentModelEntrySchema>
export type OmoAgentDef = z.infer<typeof OmoAgentDefSchema>
export type OmoAgentsConfig = z.infer<typeof OmoAgentsConfigSchema>
