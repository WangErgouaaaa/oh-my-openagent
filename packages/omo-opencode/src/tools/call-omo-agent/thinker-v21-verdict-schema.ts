import { z } from "zod"

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const NON_WHITESPACE_PATTERN = /\S/
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

export const THINKER_V21_REVIEWER_ROLES = [
  "explore",
  "momus",
  "oracle",
  "librarian",
] as const

export type ThinkerV21ReviewerRole =
  (typeof THINKER_V21_REVIEWER_ROLES)[number]

type UnknownKeyPolicy = "strict" | "passthrough"

function reviewerFindingSchema(
  assessment: "supported" | "contradicted" | "insufficient_evidence" | "not_applicable",
  unknownKeyPolicy: UnknownKeyPolicy,
) {
  const requiresAction = assessment === "contradicted"
    || assessment === "insufficient_evidence"
  const schema = z.object({
    finding_id: z.string().regex(NON_WHITESPACE_PATTERN),
    claim_id: z.string().regex(NON_WHITESPACE_PATTERN),
    assessment: z.literal(assessment),
    severity: z.enum(["critical", "major", "minor", "info"]),
    evidence_refs: z.array(z.unknown()),
    reasoning: z.string().optional(),
    recheck_required: z.boolean().optional(),
    required_action: requiresAction
      ? z.string().regex(NON_WHITESPACE_PATTERN)
      : z.string().optional(),
  })
  return unknownKeyPolicy === "strict" ? schema.strict() : schema.passthrough()
}

function buildThinkerV21VerdictSchema(
  expectedRole: ThinkerV21ReviewerRole | undefined,
  unknownKeyPolicy: UnknownKeyPolicy,
) {
  const schema = z.object({
    schema_version: z.literal("2.1"),
    artifact_kind: z.literal("thinker_raw_verdict_v21"),
    role: expectedRole
      ? z.literal(expectedRole)
      : z.enum(THINKER_V21_REVIEWER_ROLES),
    snapshot_id: z.string().regex(NON_WHITESPACE_PATTERN),
    context_hash: z.string().regex(SHA256_PATTERN),
    status: z.enum(["completed", "blocked"]),
    claim_findings: z.array(z.discriminatedUnion("assessment", [
      reviewerFindingSchema("supported", unknownKeyPolicy),
      reviewerFindingSchema("contradicted", unknownKeyPolicy),
      reviewerFindingSchema("insufficient_evidence", unknownKeyPolicy),
      reviewerFindingSchema("not_applicable", unknownKeyPolicy),
    ])),
    registry_gaps: z.array(z.unknown()),
    new_load_bearing_claims: z.array(z.unknown()),
    missing_assumptions: z.array(z.unknown()),
    context_requests: z.array(z.unknown()),
  }).superRefine((payload, context) => {
    const forbiddenField = findForbiddenProviderField(payload)
    if (forbiddenField) {
      context.addIssue({
        code: "custom",
        message: `provider configuration field ${forbiddenField} is forbidden`,
      })
    }
  })
  return unknownKeyPolicy === "strict" ? schema.strict() : schema.passthrough()
}

export function buildThinkerV21VerdictJsonSchema(
  expectedRole: ThinkerV21ReviewerRole,
): Record<string, unknown> {
  const schema = z.toJSONSchema(
    buildThinkerV21VerdictSchema(expectedRole, "strict"),
  ) as Record<string, unknown>
  delete schema["$schema"]
  return schema
}

export function assertThinkerV21Verdict(
  payload: unknown,
  expectedRole?: ThinkerV21ReviewerRole,
): void {
  const result = buildThinkerV21VerdictSchema(
    expectedRole,
    "passthrough",
  ).safeParse(payload)
  if (result.success) {
    return
  }

  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ")
  throw new Error(`Structured reviewer response does not satisfy the thinker v2.1 verdict schema: ${details}`)
}
