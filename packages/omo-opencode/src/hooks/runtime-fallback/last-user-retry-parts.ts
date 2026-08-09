import { isRecord } from "@oh-my-opencode/utils"
import {
  clearDelegatedChildSessionBootstrap,
  getDelegatedChildSessionBootstrap,
} from "../../shared/delegated-child-session-bootstrap"
import { extractSessionMessages } from "./session-messages"

type RetryPart = { type: "text"; text: string }

export type LastUserRetryPayload = {
  retryParts: RetryPart[]
  format?: Record<string, unknown>
  system?: string
  tools?: Record<string, boolean>
}

export function getLastUserRetryParts(
  messagesResponse: unknown,
  sessionID?: string,
): RetryPart[] {
  return getLastUserRetryPayload(messagesResponse, sessionID).retryParts
}

export function getLastUserRetryPayload(
  messagesResponse: unknown,
  sessionID?: string,
): LastUserRetryPayload {
  const bootstrap = sessionID ? getDelegatedChildSessionBootstrap(sessionID) : undefined
  const messages = extractSessionMessages(messagesResponse)
  const lastUserMessage = messages?.filter((message) => message.info?.role === "user").pop()
  const lastUserParts =
    lastUserMessage?.parts
    ?? (lastUserMessage?.info?.parts as Array<{ type?: string; text?: string }> | undefined)
  const persistedFormat = lastUserMessage?.info?.format
  const format = bootstrap?.format ?? (isRecord(persistedFormat) ? persistedFormat : undefined)

  const retryParts = (lastUserParts ?? [])
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text"
        && typeof part.text === "string"
        && part.text.length > 0,
    )
    .map((part) => ({ type: "text" as const, text: part.text }))

  if (retryParts.length > 0) {
    if (sessionID) {
      clearDelegatedChildSessionBootstrap(sessionID)
    }
    return {
      retryParts,
      ...(format ? { format } : {}),
      ...(bootstrap?.system ? { system: bootstrap.system } : {}),
      ...(bootstrap?.tools ? { tools: bootstrap.tools } : {}),
    }
  }

  if (!sessionID) {
    return { retryParts }
  }

  const bootstrapRetryParts = bootstrap?.retryParts ?? []
  if (bootstrapRetryParts.length > 0) {
    clearDelegatedChildSessionBootstrap(sessionID)
  }

  return {
    retryParts: bootstrapRetryParts,
    ...(format ? { format } : {}),
    ...(bootstrap?.system ? { system: bootstrap.system } : {}),
    ...(bootstrap?.tools ? { tools: bootstrap.tools } : {}),
  }
}
