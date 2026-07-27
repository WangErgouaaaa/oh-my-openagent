import type {
  ALLOWED_AGENTS,
  OPTIONAL_REVIEW_AGENTS,
  STRUCTURED_REVIEW_RESPONSE_MODES,
} from "./constants"

export type AllowedAgentType =
  | (typeof ALLOWED_AGENTS)[number]
  | (typeof OPTIONAL_REVIEW_AGENTS)[number]

export type StructuredReviewResponseMode =
  (typeof STRUCTURED_REVIEW_RESPONSE_MODES)[number]

export interface CallOmoAgentToolArgs {
  description: string
  prompt?: string
  prompt_file?: string
  prompt_sha256?: string
  response_mode?: StructuredReviewResponseMode
  subagent_type: string
  run_in_background: boolean
  session_id?: string
}

export interface CallOmoPromptReceipt {
  source: "literal" | "file"
  byteCount: number
  sha256: string
}

export interface CallOmoAgentArgs {
  description: string
  prompt: string
  prompt_receipt?: CallOmoPromptReceipt
  response_mode?: StructuredReviewResponseMode
  subagent_type: string
  run_in_background: boolean
  session_id?: string
}

export type CallOmoAgentRuntimeOptions = {
  env?: Record<string, string | undefined>
  promptFileRoots?: readonly string[]
}

export interface CallOmoAgentSyncResult {
  title: string
  metadata: {
    summary?: Array<{
      id: string
      tool: string
      state: {
        status: string
        title?: string
      }
    }>
    sessionId: string
  }
  output: string
}
export type ToolContextWithMetadata = {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
}
