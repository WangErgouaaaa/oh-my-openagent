import type { PluginInput } from "@opencode-ai/plugin"
import { log } from "../../shared"
import { buildMessageKey, consumeNewMessages } from "../../shared/session-cursor"

interface SDKMessage {
  info?: { role?: string; time?: { created?: number } }
  parts?: Array<{ type: string; text?: string; content?: string | Array<{ type: string; text?: string }> }>
}

export interface ProcessMessagesOptions {
  baselineMessageKeys?: ReadonlySet<string>
  expectedArtifactKind?: "thinker_raw_verdict" | "thinker_raw_verdict_v21"
}

function validateStructuredReviewResponse(
  responseText: string,
  expectedArtifactKind: NonNullable<ProcessMessagesOptions["expectedArtifactKind"]>,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseText)
  } catch {
    throw new Error("Structured reviewer response must be one JSON mapping.")
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || (parsed as { artifact_kind?: unknown }).artifact_kind !== expectedArtifactKind
  ) {
    throw new Error(`Structured reviewer response must declare artifact_kind ${expectedArtifactKind}.`)
  }
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
  const relevantMessages = messages.filter(
    (m: SDKMessage) => m.info?.role === "assistant" || m.info?.role === "tool"
  )

  if (relevantMessages.length === 0) {
    log(`[call_omo_agent] No assistant or tool messages found`)
    log(`[call_omo_agent] All messages:`, JSON.stringify(messages, null, 2))
    throw new Error("No assistant or tool response found")
  }

  log(`[call_omo_agent] Found ${relevantMessages.length} relevant messages`)

  // Sort by time ascending (oldest first) to process messages in order
  const sortedMessages = [...relevantMessages].sort((a: SDKMessage, b: SDKMessage) => {
    const timeA = a.info?.time?.created ?? 0
    const timeB = b.info?.time?.created ?? 0
    return timeA - timeB
  })

  const newMessages = options.baselineMessageKeys
    ? sortedMessages.filter((message, index) => !options.baselineMessageKeys?.has(buildMessageKey(message, index)))
    : consumeNewMessages(sessionID, sortedMessages)

  if (newMessages.length === 0) {
    if (options.expectedArtifactKind) {
      throw new Error("No fresh assistant response found")
    }
    return "No new output since last check."
  }

  if (options.expectedArtifactKind) {
    const finalAssistant = [...newMessages]
      .reverse()
      .find((message: SDKMessage) =>
        message.info?.role === "assistant"
        && (message.parts ?? []).some((part) => part.type === "text" && Boolean(part.text))
      )

    if (!finalAssistant) {
      throw new Error("No final assistant text response found")
    }

    const responseText = (finalAssistant.parts ?? [])
      .filter((part) => part.type === "text" && Boolean(part.text))
      .map((part) => (part as { text: string }).text)
      .join("")

    log(`[call_omo_agent] Got final assistant response, length: ${responseText.length}`)
    validateStructuredReviewResponse(responseText, options.expectedArtifactKind)
    return responseText
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
