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

  test("structured output reads the native StructuredOutput result without a text wrapper", async () => {
    const sessionID = "structured-native-result-test"
    resetMessageCursor(sessionID)
    const structured = {
      artifact_kind: "thinker_raw_verdict_v21",
      role: "explore",
      status: "completed",
    }
    const messages = [
      {
        info: {
          id: "assistant-final",
          role: "assistant",
          parentID: "current-user",
          time: { created: 1 },
          structured,
        },
        parts: [{
          type: "tool",
          tool: "StructuredOutput",
          state: { status: "completed" },
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

    expect(result).toBe(JSON.stringify(structured))
  })

  test("structured output can use the bound prompt response without fetching session history", async () => {
    const structured = {
      artifact_kind: "thinker_raw_verdict_v21",
      role: "explore",
    }
    const context = {
      client: {
        session: {
          messages: async () => {
            throw new Error("OpenCode rejected its persisted OutputFormatJsonSchema")
          },
        },
      },
    }

    const result = await processMessages(
      "structured-bound-prompt-response-test",
      context as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict_v21",
        promptResponse: {
          data: {
            info: {
              id: "assistant-final",
              role: "assistant",
              parentID: "current-user",
              time: { created: 1 },
              structured,
            },
            parts: [],
          },
        },
      },
    )

    expect(result).toBe(JSON.stringify(structured))
  })

  test("structured output rejects multiple native results linked to one prompt", async () => {
    const sessionID = "structured-duplicate-native-results-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: {
          id: "assistant-first",
          role: "assistant",
          parentID: "current-user",
          time: { created: 1 },
          structured: { artifact_kind: "thinker_raw_verdict_v21", role: "explore" },
        },
      },
      {
        info: {
          id: "assistant-second",
          role: "assistant",
          parentID: "current-user",
          time: { created: 2 },
          structured: { artifact_kind: "thinker_raw_verdict_v21", role: "oracle" },
        },
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict_v21",
      },
    )).rejects.toThrow("exactly one final assistant response")
  })

  test("structured output rejects mixed native and text-wrapper results for one prompt", async () => {
    const sessionID = "structured-mixed-native-text-results-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: {
          id: "assistant-native",
          role: "assistant",
          parentID: "current-user",
          time: { created: 1 },
          structured: { artifact_kind: "thinker_raw_verdict_v21", role: "explore" },
        },
      },
      {
        info: {
          id: "assistant-text",
          role: "assistant",
          parentID: "current-user",
          time: { created: 2 },
        },
        parts: [{
          type: "text",
          text: "```json\n{\"artifact_kind\":\"thinker_raw_verdict_v21\",\"role\":\"oracle\"}\n```",
        }],
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict_v21",
      },
    )).rejects.toThrow("exactly one final assistant response")
  })

  test("structured output rejects a native result mixed with a wrong-artifact text result", async () => {
    const sessionID = "structured-native-wrong-artifact-text-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: {
          id: "assistant-native",
          role: "assistant",
          parentID: "current-user",
          time: { created: 1 },
          structured: { artifact_kind: "thinker_raw_verdict_v21", role: "explore" },
        },
      },
      {
        info: { id: "assistant-text", role: "assistant", parentID: "current-user", time: { created: 2 } },
        parts: [{
          type: "text",
          text: "```json\n{\"artifact_kind\":\"unexpected\",\"role\":\"oracle\"}\n```",
        }],
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict_v21",
      },
    )).rejects.toThrow("must declare artifact_kind thinker_raw_verdict_v21")
  })

  test("structured output rejects a native result mixed with a malformed JSON fence", async () => {
    const sessionID = "structured-native-malformed-fence-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: {
          id: "assistant-native",
          role: "assistant",
          parentID: "current-user",
          time: { created: 1 },
          structured: { artifact_kind: "thinker_raw_verdict_v21", role: "explore" },
        },
      },
      {
        info: { id: "assistant-text", role: "assistant", parentID: "current-user", time: { created: 2 } },
        parts: [{
          type: "text",
          text: "```json\n{\"artifact_kind\":\"thinker_raw_verdict_v21\"",
        }],
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict_v21",
      },
    )).rejects.toThrow("must be one JSON mapping")
  })

  test("structured output rejects two text results when either result is invalid", async () => {
    const sessionID = "structured-valid-invalid-text-results-test"
    resetMessageCursor(sessionID)
    const messages = [
      {
        info: { id: "assistant-valid", role: "assistant", parentID: "current-user", time: { created: 1 } },
        parts: [{
          type: "text",
          text: "```json\n{\"artifact_kind\":\"thinker_raw_verdict_v21\",\"role\":\"explore\"}\n```",
        }],
      },
      {
        info: { id: "assistant-invalid", role: "assistant", parentID: "current-user", time: { created: 2 } },
        parts: [{
          type: "text",
          text: "```json\n{\"artifact_kind\":\"unexpected\",\"role\":\"oracle\"}\n```",
        }],
      },
    ]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict_v21",
      },
    )).rejects.toThrow("must declare artifact_kind thinker_raw_verdict_v21")
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

  test("structured output rejects mixed unfenced and fenced JSON mappings", async () => {
    const sessionID = "structured-mixed-mapping-test"
    resetMessageCursor(sessionID)
    const unfencedJson = '{"artifact_kind":"thinker_raw_verdict_v21","role":"explore"}'
    const fencedJson = '{"artifact_kind":"thinker_raw_verdict_v21","role":"momus"}'
    const messages = [{
      info: { id: "assistant-final", role: "assistant", parentID: "current-user", time: { created: 1 } },
      parts: [{
        type: "text",
        text: `${unfencedJson}\n\n\`\`\`json\n${fencedJson}\n\`\`\``,
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

  test("structured output rejects an oversized brace-heavy response", async () => {
    const sessionID = "structured-oversized-response-test"
    resetMessageCursor(sessionID)
    const fencedJson = '{"artifact_kind":"thinker_raw_verdict_v21","role":"momus"}'
    const messages = [{
      info: { id: "assistant-final", role: "assistant", parentID: "current-user", time: { created: 1 } },
      parts: [{
        type: "text",
        text: `${"{".repeat(32 * 1024 + 1)}\n\n\`\`\`json\n${fencedJson}\n\`\`\``,
      }],
    }]

    await expect(processMessages(
      sessionID,
      createContext(messages) as never,
      {
        expectedPromptMessageID: "current-user",
        expectedArtifactKind: "thinker_raw_verdict_v21",
      },
    )).rejects.toThrow("Structured reviewer response exceeds 32768 characters")
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
