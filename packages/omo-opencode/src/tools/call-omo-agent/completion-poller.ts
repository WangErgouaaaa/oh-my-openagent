import type { PluginInput } from "@opencode-ai/plugin"
import { log } from "../../shared"
import { normalizeSDKResponse } from "../../shared"
import { buildMessageKey, type CursorMessage } from "../../shared/session-cursor"

export interface WaitForCompletionOptions {
  maxPollTimeMs?: number
  baselineMessageKeys?: ReadonlySet<string>
  expectedPromptMessageID?: string
}

type CompletionMessage = CursorMessage & {
  info?: NonNullable<CursorMessage["info"]> & { role?: string; parentID?: string }
}

export async function captureMessageBaseline(
  sessionID: string,
  ctx: PluginInput,
): Promise<ReadonlySet<string>> {
  const messagesResult = await ctx.client.session.messages({ path: { id: sessionID } })
  if (messagesResult.error) {
    throw new Error(`Failed to get messages: ${messagesResult.error}`)
  }
  const messages = normalizeSDKResponse(messagesResult, [] as CompletionMessage[], {
    preferResponseOnMissingData: true,
  })
  return new Set(messages.map((message, index) => buildMessageKey(message, index)))
}

export async function waitForCompletion(
  sessionID: string,
  toolContext: {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  },
  ctx: PluginInput,
  options: WaitForCompletionOptions = {},
): Promise<void> {
  log(`[call_omo_agent] Polling for completion...`)

  const POLL_INTERVAL_MS = 500
  const MAX_POLL_TIME_MS = options.maxPollTimeMs ?? 5 * 60 * 1000
  const PROMPT_ACCEPTANCE_TIMEOUT_MS = 30 * 1000
  const pollStart = Date.now()
  let lastMsgCount = 0
  let stablePolls = 0
  const STABILITY_REQUIRED = 3
  let sawActiveStatus = false

  while (Date.now() - pollStart < MAX_POLL_TIME_MS) {
    if (toolContext.abort?.aborted) {
      log(`[call_omo_agent] Aborted by user`)
      throw new Error("Task aborted.")
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))

    const statusResult = await ctx.client.session.status()
    const allStatuses = normalizeSDKResponse(statusResult, {} as Record<string, { type: string }>)
    const sessionStatus = allStatuses[sessionID]

    if (sessionStatus && sessionStatus.type !== "idle") {
      sawActiveStatus = true
      stablePolls = 0
      lastMsgCount = 0
      continue
    }

    const messagesCheck = await ctx.client.session.messages({ path: { id: sessionID } })
    const msgs = normalizeSDKResponse(messagesCheck, [] as CompletionMessage[], {
      preferResponseOnMissingData: true,
    })
    const freshMessages = options.baselineMessageKeys
      ? msgs.filter((message, index) => !options.baselineMessageKeys?.has(buildMessageKey(message, index)))
      : msgs
    const promptWasPersisted = options.expectedPromptMessageID
      ? freshMessages.some((message) =>
        message.info?.role === "user" && message.info.id === options.expectedPromptMessageID,
      )
      : freshMessages.length > 0
    const matchingAssistantMessages = options.expectedPromptMessageID
      ? freshMessages.filter((message) =>
        message.info?.role === "assistant" && message.info.parentID === options.expectedPromptMessageID,
      )
      : freshMessages
    const currentMsgCount = matchingAssistantMessages.length

    if (currentMsgCount === 0) {
      stablePolls = 0
      lastMsgCount = 0
      if (!promptWasPersisted && !sawActiveStatus && Date.now() - pollStart >= PROMPT_ACCEPTANCE_TIMEOUT_MS) {
        throw new Error(`Prompt was not durably accepted by OpenCode for session ${sessionID}.`)
      }
      continue
    }

    if (
      !options.expectedPromptMessageID
      && !freshMessages.some((message) => message.info?.role === "assistant")
    ) {
      stablePolls = 0
      lastMsgCount = currentMsgCount
      continue
    }

    if (currentMsgCount === lastMsgCount) {
      stablePolls++
      if (stablePolls >= STABILITY_REQUIRED) {
        log(`[call_omo_agent] Session complete, ${currentMsgCount} messages`)
        break
      }
    } else {
      stablePolls = 0
      lastMsgCount = currentMsgCount
    }
  }

  if (Date.now() - pollStart >= MAX_POLL_TIME_MS) {
    log(`[call_omo_agent] Timeout reached`)
    throw new Error(`Agent task timed out after ${MAX_POLL_TIME_MS / 60_000} minutes.`)
  }
}
