import type { PluginInput } from "@opencode-ai/plugin"
import { clearSessionAgent, handedBackSyncSessions, setSessionAgent, subagentSessions, syncSubagentSessions } from "../../features/claude-code-session-state"
import { generateMessageId } from "../../features/hook-message-injector/id-generation"
import { dispatchInternalPrompt, isInternalPromptDispatchAccepted } from "../../hooks/shared/prompt-async-gate"
import { getAgentToolRestrictions, isAmbiguousPostDispatchPromptFailure, log } from "../../shared"
import { normalizeAgentForPrompt, stripAgentListSortPrefix } from "../../shared/agent-display-names"
import {
  clearDelegatedChildSessionBootstrap,
  registerDelegatedChildSessionBootstrap,
} from "../../shared/delegated-child-session-bootstrap"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers"
import { deleteSessionTools, setSessionTools } from "../../shared/session-tools-store"
import { captureMessageBaseline, waitForCompletion } from "./completion-poller"
import { processMessages } from "./message-processor"
import { createOrGetSession } from "./session-creator"
import type { CallOmoAgentArgs, StructuredReviewResponseMode } from "./types"

type SessionWithPrompt = {
  prompt: (opts: { path: { id: string }; body: Record<string, unknown> }) => Promise<unknown>
}

function hasPrompt(session: PluginInput["client"]["session"]): session is PluginInput["client"]["session"] & SessionWithPrompt {
  return "prompt" in session && typeof session.prompt === "function"
}

type ExecuteSyncDeps = {
  createOrGetSession: typeof createOrGetSession
  captureMessageBaseline: typeof captureMessageBaseline
  waitForCompletion: typeof waitForCompletion
  processMessages: typeof processMessages
  setSessionFallbackChain: (sessionID: string, fallbackChain: FallbackEntry[] | undefined) => void
  clearSessionFallbackChain: (sessionID: string) => void
}

type SpawnReservation = {
  commit: () => number
  rollback: () => void
}

const defaultDeps: ExecuteSyncDeps = {
  createOrGetSession,
  captureMessageBaseline,
  waitForCompletion,
  processMessages,
  setSessionFallbackChain: () => {},
  clearSessionFallbackChain: () => {},
}

function buildPromptGenerationParams(model: DelegatedModelConfig | undefined): Record<string, unknown> {
  if (!model) {
    return {}
  }

  const promptOptions: Record<string, unknown> = {
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    ...(model.thinking ? { thinking: model.thinking } : {}),
  }

  return {
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.top_p !== undefined ? { topP: model.top_p } : {}),
    ...(model.maxTokens !== undefined ? { maxOutputTokens: model.maxTokens } : {}),
    ...(Object.keys(promptOptions).length > 0 ? { options: promptOptions } : {}),
  }
}

function buildSyncPromptTools(agent: string): Record<string, boolean> {
  return {
    ...getAgentToolRestrictions(agent),
    task: false,
    question: false,
  }
}

const STRUCTURED_REVIEW_PROTOCOLS: Record<StructuredReviewResponseMode, {
  allowedAgents: readonly string[]
  expectedArtifactKind: "thinker_raw_verdict" | "thinker_raw_verdict_v21"
}> = {
  thinker_v2: {
    allowedAgents: ["momus", "oracle"],
    expectedArtifactKind: "thinker_raw_verdict",
  },
  thinker_v21: {
    allowedAgents: ["explore", "momus", "oracle"],
    expectedArtifactKind: "thinker_raw_verdict_v21",
  },
}

function resolveStructuredReviewProtocol(args: CallOmoAgentArgs) {
  if (!args.response_mode) {
    return undefined
  }
  const protocol = STRUCTURED_REVIEW_PROTOCOLS[args.response_mode]
  if (!protocol.allowedAgents.includes(args.subagent_type.toLowerCase())) {
    throw new Error(
      `response_mode ${args.response_mode} is only supported by ${protocol.allowedAgents.join(", ")}.`,
    )
  }
  return protocol
}

function promptReceiptMetadata(args: CallOmoAgentArgs): Record<string, unknown> {
  if (!args.prompt_receipt) {
    return {}
  }
  return {
    promptSource: args.prompt_receipt.source,
    promptByteCount: args.prompt_receipt.byteCount,
    promptSha256: args.prompt_receipt.sha256,
  }
}

function taskMetadata(sessionID: string, args: CallOmoAgentArgs): string {
  const lines = ["<task_metadata>", `session_id: ${sessionID}`]
  if (args.prompt_receipt) {
    lines.push(
      `prompt_source: ${args.prompt_receipt.source}`,
      `prompt_bytes: ${args.prompt_receipt.byteCount}`,
      `prompt_sha256: ${args.prompt_receipt.sha256}`,
    )
  }
  lines.push("</task_metadata>")
  return lines.join("\n")
}

function getPromptResponseParentID(response: unknown): string | undefined {
  const payload = typeof response === "object" && response !== null && "data" in response
    ? (response as { data?: unknown }).data
    : response
  if (typeof payload !== "object" || payload === null || !("info" in payload)) {
    return undefined
  }
  const info = (payload as { info?: unknown }).info
  if (typeof info !== "object" || info === null || !("parentID" in info)) {
    return undefined
  }
  const parentID = (info as { parentID?: unknown }).parentID
  return typeof parentID === "string" && parentID.length > 0 ? parentID : undefined
}

export async function executeSync(
  args: CallOmoAgentArgs,
  toolContext: {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void | Promise<void>
  },
  ctx: PluginInput,
  deps: ExecuteSyncDeps = defaultDeps,
  fallbackChain?: FallbackEntry[],
  spawnReservation?: SpawnReservation,
  model?: DelegatedModelConfig,
): Promise<string> {
  let sessionID: string | undefined
  let createdSessionForExecution = false
  let appliedFallbackChain = false
  let baselineMessageKeys: ReadonlySet<string> = new Set()
  let promptMessageID: string | undefined

  try {
    const structuredReviewProtocol = resolveStructuredReviewProtocol(args)
    const structuredReviewSystem = structuredReviewProtocol
      ? [
          "The caller selected a strict structured reviewer response mode.",
          "This contract overrides the agent's default final response format.",
          "Complete the requested review, then use StructuredOutput exactly once for the final response.",
          "The StructuredOutput schema enforces transport only; include every field required by the caller prompt.",
          "Do not emit XML, Markdown, code fences, analysis, or a plain-text final response.",
        ].join("\n")
      : undefined
    const structuredReviewFormat = structuredReviewProtocol
      ? {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              artifact_kind: {
                type: "string",
                enum: [structuredReviewProtocol.expectedArtifactKind],
              },
            },
            required: ["artifact_kind"],
          },
        }
      : undefined
    const promptModel = structuredReviewProtocol && model?.providerID === "deepseek"
      ? {
          ...model,
          variant: undefined,
          reasoningEffort: undefined,
          thinking: { type: "disabled" as const },
        }
      : model
    const session = await deps.createOrGetSession(args, toolContext, ctx, model)
    sessionID = session.sessionID
    createdSessionForExecution = session.isNew
    subagentSessions.add(sessionID)
    syncSubagentSessions.add(sessionID)

    if (session.isNew) {
      spawnReservation?.commit()
    }

    if (fallbackChain && fallbackChain.length > 0) {
      deps.setSessionFallbackChain(sessionID, fallbackChain)
      appliedFallbackChain = true
    }

    applySessionPromptParams(sessionID, promptModel)

    await Promise.resolve(
      toolContext.metadata?.({
        title: args.description,
        metadata: {
          sessionId: sessionID,
          ...promptReceiptMetadata(args),
        },
      })
    )

    log(`[call_omo_agent] Sending prompt to session ${sessionID}`)
    log(`[call_omo_agent] Prompt text:`, args.prompt.substring(0, 100))
    const normalizedSubagentType = stripAgentListSortPrefix(args.subagent_type)
    const promptAgent = normalizeAgentForPrompt(normalizedSubagentType) ?? normalizedSubagentType
    const promptTools = buildSyncPromptTools(normalizedSubagentType)
    setSessionAgent(sessionID, promptAgent)
    setSessionTools(sessionID, promptTools)
    registerDelegatedChildSessionBootstrap({
      sessionID,
      promptText: args.prompt,
      fallbackChain,
      format: structuredReviewFormat,
      system: structuredReviewSystem,
      tools: promptTools,
    })

    try {
      if (!hasPrompt(ctx.client.session)) {
        return `Error: Failed to send prompt: prompt is not available on this OpenCode client.\n\n${taskMetadata(sessionID, args)}`
      }

      baselineMessageKeys = await deps.captureMessageBaseline(sessionID, ctx)
      promptMessageID = generateMessageId()
      const promptResult = await dispatchInternalPrompt({
        mode: "sync",
        client: ctx.client,
        sessionID,
        source: "call-omo-agent:sync",
        settleMs: 0,
        queueBehavior: "defer",
        input: {
          path: { id: sessionID },
          body: {
            messageID: promptMessageID,
            agent: promptAgent,
            ...(structuredReviewFormat ? { format: structuredReviewFormat } : {}),
            ...(structuredReviewSystem ? { system: structuredReviewSystem } : {}),
            tools: promptTools,
            parts: [{ type: "text", text: args.prompt }],
            ...(promptModel ? { model: { providerID: promptModel.providerID, modelID: promptModel.modelID } } : {}),
            ...(promptModel?.variant ? { variant: promptModel.variant } : {}),
            ...buildPromptGenerationParams(promptModel),
          },
        },
      })
      const promptMayHaveBeenAccepted = promptResult.status === "failed"
        && isAmbiguousPostDispatchPromptFailure(promptResult)
      if (promptResult.status === "failed") {
        if (promptMayHaveBeenAccepted) {
          log("[call_omo_agent] Prompt returned an ambiguous error after dispatch; waiting for completion", {
            sessionID,
            error: promptResult.error instanceof Error ? promptResult.error.message : String(promptResult.error),
          })
        } else {
          throw promptResult.error
        }
      }
      if (!promptMayHaveBeenAccepted && !isInternalPromptDispatchAccepted(promptResult)) {
        throw new Error(`prompt skipped by gate: ${promptResult.status}`)
      }
      if (
        structuredReviewProtocol
        && promptResult.status === "dispatched"
        && getPromptResponseParentID(promptResult.response) !== promptMessageID
      ) {
        throw new Error("Structured reviewer prompt response was not linked to the dispatched user message.")
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`[call_omo_agent] Prompt error:`, errorMessage)
      if (errorMessage.includes("agent.name") || errorMessage.includes("undefined")) {
        return `Error: Agent "${normalizedSubagentType}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.\n\n${taskMetadata(sessionID, args)}`
      }
      return `Error: Failed to send prompt: ${errorMessage}\n\n${taskMetadata(sessionID, args)}`
    }

    if (!promptMessageID) {
      throw new Error("No prompt message ID was created for the synchronous dispatch.")
    }

    try {
      if (structuredReviewProtocol) {
        await deps.waitForCompletion(sessionID, toolContext, ctx, {
          maxPollTimeMs: 10 * 60 * 1000,
          baselineMessageKeys,
          expectedPromptMessageID: promptMessageID,
        })
      } else {
        await deps.waitForCompletion(sessionID, toolContext, ctx, {
          baselineMessageKeys,
          expectedPromptMessageID: promptMessageID,
        })
      }

      const responseText = await deps.processMessages(sessionID, ctx, {
        baselineMessageKeys,
        expectedPromptMessageID: promptMessageID,
        expectedArtifactKind: structuredReviewProtocol?.expectedArtifactKind,
      })

      return responseText + "\n\n" + taskMetadata(sessionID, args)
    } catch (error) {
      if (!structuredReviewProtocol) {
        throw error
      }
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`[call_omo_agent] Structured review response error:`, errorMessage)
      return `Error: ${errorMessage}\n\n${taskMetadata(sessionID, args)}`
    }
  } catch (error) {
    spawnReservation?.rollback()
    throw error
  } finally {
    if (sessionID && appliedFallbackChain) {
      deps.clearSessionFallbackChain(sessionID)
    }

    if (sessionID) {
      clearDelegatedChildSessionBootstrap(sessionID)
    }

    if (sessionID && createdSessionForExecution) {
      subagentSessions.delete(sessionID)
      syncSubagentSessions.delete(sessionID)
      deleteSessionTools(sessionID)
      clearSessionAgent(sessionID)
      handedBackSyncSessions.add(sessionID)
    }
  }
}
