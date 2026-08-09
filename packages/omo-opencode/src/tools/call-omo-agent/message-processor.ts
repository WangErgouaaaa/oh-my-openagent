import type { PluginInput } from "@opencode-ai/plugin"
import { log } from "../../shared"
import { buildMessageKey, consumeNewMessages } from "../../shared/session-cursor"

interface SDKMessage {
  info?: {
    id?: string
    role?: string
    parentID?: string
    structured?: unknown
    time?: { created?: number }
  }
  parts?: Array<{ type: string; text?: string; content?: string | Array<{ type: string; text?: string }> }>
}

export interface ProcessMessagesOptions {
  baselineMessageKeys?: ReadonlySet<string>
  expectedPromptMessageID?: string
  expectedArtifactKind?: "thinker_raw_verdict" | "thinker_raw_verdict_v21"
}

const MAX_STRUCTURED_REVIEW_RESPONSE_CHARS = 32 * 1024

function containsJsonMapping(text: string): boolean {
  // ponytail: O(n²) scan is capped at 32 KiB; use a streaming parser if larger verdicts become necessary.
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = start; index < text.length; index += 1) {
      const character = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === "\"") inString = false
        continue
      }
      if (character === "\"") {
        inString = true
      } else if (character === "{") {
        depth += 1
      } else if (character === "}" && --depth === 0) {
        try {
          JSON.parse(text.slice(start, index + 1))
          return true
        } catch {
          break
        }
      }
    }
  }
  return false
}

function normalizeStructuredReviewResponse(
  responseText: string,
  expectedArtifactKind: NonNullable<ProcessMessagesOptions["expectedArtifactKind"]>,
): string {
  if (responseText.length > MAX_STRUCTURED_REVIEW_RESPONSE_CHARS) {
    throw new Error(`Structured reviewer response exceeds ${MAX_STRUCTURED_REVIEW_RESPONSE_CHARS} characters.`)
  }

  let candidate = responseText
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    const fencedMappingPattern = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gi
    const fencedMappings = [...responseText.matchAll(fencedMappingPattern)]
    const unfencedText = responseText.replace(fencedMappingPattern, "")
    if (fencedMappings.length !== 1 || containsJsonMapping(unfencedText)) {
      throw new Error("Structured reviewer response must be one JSON mapping.")
    }
    candidate = fencedMappings[0][1].trim()
    try {
      parsed = JSON.parse(candidate)
    } catch {
      throw new Error("Structured reviewer response must be one JSON mapping.")
    }
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || (parsed as { artifact_kind?: unknown }).artifact_kind !== expectedArtifactKind
  ) {
    throw new Error(`Structured reviewer response must declare artifact_kind ${expectedArtifactKind}.`)
  }
  return candidate
}

export async function processMessages(
  sessionID: string,
  ctx: PluginInput,
  options: ProcessMessagesOptions = {},
): Promise<string> {
  const messagesResult = await ctx.client.session.messages({
    path: { id: sessionID },
  })

  if (messagesResult.error) {
    log(`[call_omo_agent] Messages error:`, messagesResult.error)
    throw new Error(`Failed to get messages: ${messagesResult.error}`)
  }

  const messages = messagesResult.data
  log(`[call_omo_agent] Got ${messages.length} messages`)

  // Include both assistant messages AND tool messages
  // Tool results (grep, glob, bash output) come from role "tool"
  const relevantMessages = messages
    .map((message: SDKMessage, index: number) => ({
      key: buildMessageKey(message, index),
      message,
    }))
    .filter(
      ({ message }) => message.info?.role === "assistant" || message.info?.role === "tool",
    )

  if (relevantMessages.length === 0) {
    log(`[call_omo_agent] No assistant or tool messages found`)
    log(`[call_omo_agent] All messages:`, JSON.stringify(messages, null, 2))
    throw new Error("No assistant or tool response found")
  }

  log(`[call_omo_agent] Found ${relevantMessages.length} relevant messages`)

  // Sort by time ascending (oldest first) to process messages in order
  const sortedMessages = [...relevantMessages].sort((a, b) => {
    const timeA = a.message.info?.time?.created ?? 0
    const timeB = b.message.info?.time?.created ?? 0
    return timeA - timeB
  })

  const newMessages = options.baselineMessageKeys
    ? sortedMessages
      .filter(({ key }) => !options.baselineMessageKeys?.has(key))
      .map(({ message }) => message)
    : consumeNewMessages(sessionID, sortedMessages.map(({ message }) => message))

  if (newMessages.length === 0) {
    if (options.expectedArtifactKind) {
      throw new Error("No fresh assistant response found")
    }
    return "No new output since last check."
  }

  if (options.expectedArtifactKind) {
    const expectedArtifactKind = options.expectedArtifactKind
    if (!options.expectedPromptMessageID) {
      throw new Error("Structured reviewer response requires a dispatched prompt message ID.")
    }

    const linkedAssistants = newMessages
      .filter((message: SDKMessage) =>
        message.info?.role === "assistant"
        && message.info.parentID === options.expectedPromptMessageID
      )
    const nativeResponses = linkedAssistants
      .filter((message) => message.info?.structured !== undefined)
      .map((message) => JSON.stringify(message.info?.structured))
    const textResponses = linkedAssistants
      .map((message) => (message.parts ?? [])
          .filter((part) => part.type === "text" && Boolean(part.text))
          .map((part) => (part as { text: string }).text)
          .join(""))
      .filter(Boolean)

    if (nativeResponses.length === 0 && textResponses.length === 0) {
      throw new Error("No final assistant response linked to the dispatched prompt found")
    }

    const structuredTextResponses = textResponses.filter((responseText) =>
      responseText.length > MAX_STRUCTURED_REVIEW_RESPONSE_CHARS
      || /```json\b/i.test(responseText)
      || containsJsonMapping(responseText)
    )
    const normalizedTextResponses = structuredTextResponses.map((responseText) =>
      normalizeStructuredReviewResponse(responseText, expectedArtifactKind)
    )
    if (
      nativeResponses.length > 1
      || normalizedTextResponses.length > 1
      || (nativeResponses.length === 1 && normalizedTextResponses.length === 1)
    ) {
      throw new Error("Structured reviewer response must contain exactly one final assistant response.")
    }

    const responseText = nativeResponses[0] ?? normalizedTextResponses[0] ?? textResponses.at(-1)!
    log(`[call_omo_agent] Got final assistant response, length: ${responseText.length}`)
    return normalizeStructuredReviewResponse(responseText, expectedArtifactKind)
  }

  // Extract content from ALL messages, not just the last one
  // Tool results may be in earlier messages while the final message is empty
  const extractedContent: string[] = []

  for (const message of newMessages) {
    for (const part of message.parts ?? []) {
      // Handle both "text" and "reasoning" parts (thinking models use "reasoning")
      if ((part.type === "text" || part.type === "reasoning") && part.text) {
        extractedContent.push(part.text)
      } else if ((part.type as string) === "tool_result") {
        // Tool results contain the actual output from tool calls
        const toolResult = part as { content?: string | Array<{ type: string; text?: string }> }
        if (typeof toolResult.content === "string" && toolResult.content) {
          extractedContent.push(toolResult.content)
        } else if (Array.isArray(toolResult.content)) {
          // Handle array of content blocks
          for (const block of toolResult.content) {
            if ((block.type === "text" || block.type === "reasoning") && block.text) {
              extractedContent.push(block.text)
            }
          }
        }
      }
    }
  }

  const responseText = extractedContent
    .filter((text) => text.length > 0)
    .join("\n\n")

  log(`[call_omo_agent] Got response, length: ${responseText.length}`)

  return responseText
}
