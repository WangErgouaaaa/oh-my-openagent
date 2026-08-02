import { z } from "zod"

export const FallbackModelObjectSchema = z.object({
  model: z.string(),
  reasoning: z.string().optional(),
  variant: z.string().optional(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  maxTokens: z.number().optional(),
  provider_options: z.record(z.string(), z.unknown()).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  thinking: z
    .object({
      type: z.enum(["enabled", "disabled"]),
      budgetTokens: z.number().optional(),
    })
    .optional(),
})

export type FallbackModelObject = z.infer<typeof FallbackModelObjectSchema>

export const FallbackModelStringArraySchema = z.array(z.string())
export const FallbackModelObjectArraySchema = z.array(FallbackModelObjectSchema)
export const FallbackModelMixedArraySchema = z.array(z.union([z.string(), FallbackModelObjectSchema]))

export const FallbackModelsSchema = z.union([
  z.string(),
  FallbackModelStringArraySchema,
  FallbackModelObjectArraySchema,
  FallbackModelMixedArraySchema,
])

export type FallbackModels = z.infer<typeof FallbackModelsSchema>
