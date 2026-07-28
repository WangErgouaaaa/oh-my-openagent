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
        info: { id: "assistant-progress", role: "assistant", parentID: "current-user", time: { created: 1 } },
        parts: [{ type: "text", text: "Need inspect the implementation first." }],
      },
      {
        info: { id: "tool-output", role: "tool", time: { created: 2 } },
        parts: [{ type: "tool_result", content: "source lines and test output" }],
      },
      {
        info: { id: "assistant-final", role: "assistant", parentID: "current-user", time: { created: 3 } },
        parts: [{ type: "text", text: finalJson }],
      },
    ]

    const result = await processMessages(
      sessionID,
      createContext(messages) as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict",
      },
    )

    expect(result).toBe(finalJson)
  })

  test("structured output extracts one JSON mapping from a native agent wrapper", async () => {
    const sessionID = "structured-native-wrapper-test"
    resetMessageCursor(sessionID)
    const finalJson = '{"artifact_kind":"thinker_raw_verdict_v21","role":"explore"}'
    const messages = [
      {
        info: { id: "assistant-final", role: "assistant", parentID: "current-user", time: { created: 1 } },
        parts: [{
          type: "text",
          text: `Review complete.\n\n\`\`\`json\n${finalJson}\n\`\`\`\n\n<results><answer>Supported.</answer></results>`,
        }],
      },
    ]

    const result = await processMessages(
      sessionID,
      createContext(messages) as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict_v21",
      },
    )

    expect(result).toBe(finalJson)
  })

  test("structured output rejects multiple fenced JSON mappings", async () => {
    const sessionID = "structured-ambiguous-wrapper-test"
    resetMessageCursor(sessionID)
    const finalJson = '{"artifact_kind":"thinker_raw_verdict_v21","role":"explore"}'
    const messages = [{
      info: { id: "assistant-final", role: "assistant", parentID: "current-user", time: { created: 1 } },
      parts: [{
        type: "text",
        text: `\`\`\`json\n${finalJson}\n\`\`\`\n\n\`\`\`json\n${finalJson}\n\`\`\``,
      }],
    }]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict_v21",
      },
    )).rejects.toThrow("Structured reviewer response must be one JSON mapping")
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

  test("structured output rejects a no-id stale assistant after a user message", async () => {
    const sessionID = "structured-no-id-stale-history-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: { role: "user", time: { created: 1 } },
        parts: [{ type: "text", text: "Old review prompt" }],
      },
      {
        info: { role: "assistant", time: { created: 2 } },
        parts: [{ type: "text", text: '{"artifact_kind":"thinker_raw_verdict"}' }],
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        baselineMessageKeys: new Set(["t:1:0", "t:2:1"]),
        expectedArtifactKind: "thinker_raw_verdict",
      },
    )).rejects.toThrow("No fresh assistant response found")
  })

  test("structured output rejects a post-baseline assistant not linked to this prompt", async () => {
    const sessionID = "structured-post-baseline-stale-assistant-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: { id: "old-user", role: "user", time: { created: 1 } },
        parts: [{ type: "text", text: "Old review prompt" }],
      },
      {
        info: {
          id: "late-old-assistant",
          role: "assistant",
          parentID: "old-user",
          time: { created: 2 },
        },
        parts: [{ type: "text", text: '{"artifact_kind":"thinker_raw_verdict"}' }],
      },
      {
        info: { id: "current-user", role: "user", time: { created: 3 } },
        parts: [{ type: "text", text: "Current review prompt" }],
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        baselineMessageKeys: new Set(["id:old-user"]),
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict",
      },
    )).rejects.toThrow("No final assistant response linked to the dispatched prompt found")
  })

  test("structured output requires a dispatched prompt message ID", async () => {
    const sessionID = "structured-missing-prompt-id-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: { id: "assistant-final", role: "assistant", parentID: "current-user", time: { created: 1 } },
        parts: [{ type: "text", text: '{"artifact_kind":"thinker_raw_verdict"}' }],
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      { expectedArtifactKind: "thinker_raw_verdict" },
    )).rejects.toThrow("Structured reviewer response requires a dispatched prompt message ID")
  })

  test("structured output rejects a non-matching JSON artifact", async () => {
    const sessionID = "structured-invalid-artifact-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: { id: "assistant-final", role: "assistant", parentID: "current-user", time: { created: 1 } },
        parts: [{ type: "text", text: '{"artifact_kind":"unexpected"}' }],
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict",
      },
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
