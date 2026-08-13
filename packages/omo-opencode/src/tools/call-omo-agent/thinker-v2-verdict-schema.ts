import { z } from "zod"

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const EXPLORE_REVIEWER_INSTANCE_PATTERN = /^explore-(?:primary|secondary-[1-9][0-9]*)$/
const FORBIDDEN_PROVIDER_FIELDS = ["api_key", "base_url", "provider_endpoint"] as const

function findForbiddenProviderField(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.map(findForbiddenProviderField).find(Boolean)
  }
  if (typeof value !== "object" || value === null) {
    return undefined
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase()
    if (FORBIDDEN_PROVIDER_FIELDS.some((field) => field === normalizedKey)) {
      return normalizedKey
    }
    const nestedField = findForbiddenProviderField(child)
    if (nestedField) {
      return nestedField
    }
  }
  return undefined
}

const ThinkerV2VerdictSchema = z.object({
  schema_version: z.literal(1),
  artifact_kind: z.literal("thinker_raw_verdict"),
  role: z.enum(["explore", "momus", "oracle", "librarian"]),
  reviewer_instance_id: z.string().regex(EXPLORE_REVIEWER_INSTANCE_PATTERN).optional(),
  role_verdict: z.enum(["approve", "revise", "block"]),
  candidate_plan_sha256: z.string().regex(SHA256_PATTERN),
  context_manifest_sha256: z.string().regex(SHA256_PATTERN),
  claim_verdicts: z.array(z.object({
    claim_id: z.string().min(1),
    verdict: z.enum([
      "supported",
      "partially_supported",
      "unsupported",
      "contradicted",
      "uncertain",
      "not_applicable",
    ]),
    confidence: z.number().min(0).max(1),
    evidence_refs: z.array(z.unknown()),
    reason: z.string().min(1),
  }).strict()),
  new_claim_candidates: z.array(z.unknown()),
  evidence_refs: z.array(z.unknown()),
  findings: z.array(z.unknown()),
}).strict().superRefine((payload, context) => {
  if (payload.reviewer_instance_id !== undefined && payload.role !== "explore") {
    context.addIssue({
      code: "custom",
      path: ["reviewer_instance_id"],
      message: "reviewer_instance_id is only supported for explore",
    })
  }

  const forbiddenField = findForbiddenProviderField(payload)
  if (forbiddenField) {
    context.addIssue({
      code: "custom",
      message: `provider configuration field ${forbiddenField} is forbidden`,
    })
  }
})

function buildThinkerV2VerdictJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ThinkerV2VerdictSchema) as Record<string, unknown>
  delete schema["$schema"]
  return schema
}

export const THINKER_V2_VERDICT_JSON_SCHEMA = buildThinkerV2VerdictJsonSchema()

export function assertThinkerV2Verdict(payload: unknown): void {
  const result = ThinkerV2VerdictSchema.safeParse(payload)
  if (result.success) {
    return
  }

  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ")
  throw new Error(`Structured reviewer response does not satisfy the thinker v2 verdict schema: ${details}`)
}
