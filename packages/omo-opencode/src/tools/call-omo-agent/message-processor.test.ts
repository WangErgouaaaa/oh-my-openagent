/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { processMessages } from "./message-processor"
import { resetMessageCursor } from "../../shared/session-cursor"

function createContext(messages: unknown[]) {
  return {
    client: {
      session: {
        messages: async () => ({ data: messages }),
      },
    },
  }
}

describe("processMessages", () => {
  test("structured output returns only the final assistant text", async () => {
    const sessionID = "structured-message-processor-test"
    resetMessageCursor(sessionID)
    const finalJson = '{"artifact_kind":"thinker_raw_verdict","role_verdict":"approve"}'
    const messages = [
      {
        info: { id: "assistant-progress", role: "assistant", time: { created: 1 } },
        parts: [{ type: "text", text: "Need inspect the implementation first." }],
      },
      {
        info: { id: "tool-output", role: "tool", time: { created: 2 } },
        parts: [{ type: "tool_result", content: "source lines and test output" }],
      },
      {
        info: { id: "assistant-final", role: "assistant", time: { created: 3 } },
        parts: [{ type: "text", text: finalJson }],
      },
    ]

    const result = await processMessages(
      sessionID,
      createContext(messages) as never,
      { expectedArtifactKind: "thinker_raw_verdict" },
    )

    expect(result).toBe(finalJson)
  })

  test("structured output rejects a stale assistant history", async () => {
    const sessionID = "structured-stale-history-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: { id: "old-assistant", role: "assistant", time: { created: 1 } },
        parts: [{ type: "text", text: '{"artifact_kind":"thinker_raw_verdict"}' }],
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        baselineMessageKeys: new Set(["id:old-assistant"]),
        expectedArtifactKind: "thinker_raw_verdict",
      },
    )).rejects.toThrow("No fresh assistant response found")
  })

  test("structured output rejects a non-matching JSON artifact", async () => {
    const sessionID = "structured-invalid-artifact-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: { id: "assistant-final", role: "assistant", time: { created: 1 } },
        parts: [{ type: "text", text: '{"artifact_kind":"unexpected"}' }],
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      { expectedArtifactKind: "thinker_raw_verdict" },
    )).rejects.toThrow("Structured reviewer response must declare artifact_kind thinker_raw_verdict")
  })

  test("ordinary output keeps the existing combined message behavior", async () => {
    const sessionID = "ordinary-message-processor-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: { id: "assistant-progress-ordinary", role: "assistant", time: { created: 1 } },
        parts: [{ type: "text", text: "progress" }],
      },
      {
        info: { id: "tool-output-ordinary", role: "tool", time: { created: 2 } },
        parts: [{ type: "tool_result", content: "tool result" }],
      },
      {
        info: { id: "assistant-final-ordinary", role: "assistant", time: { created: 3 } },
        parts: [{ type: "text", text: "final" }],
      },
    ]

    const result = await processMessages(
      sessionID,
      createContext(messages) as never,
    )

    expect(result).toContain("progress")
    expect(result).toContain("tool result")
    expect(result).toContain("final")
  })
})
