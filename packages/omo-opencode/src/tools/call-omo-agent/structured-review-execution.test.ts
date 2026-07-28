import { expect, mock, test } from "bun:test"
import { executeSync } from "./sync-executor"

function createContext(sessionID: string) {
  return {
    ctx: {
      client: {
        session: {
          prompt: mock(async (input: { body?: { messageID?: string } }) => ({
            data: { info: { parentID: input.body?.messageID } },
          })),
          promptAsync: mock(async () => ({ data: {} })),
        },
      },
    },
    toolContext: {
      sessionID: `parent-${sessionID}`,
      messageID: "message-1",
      agent: "sisyphus",
      abort: new AbortController().signal,
      metadata: mock(async () => {}),
    },
  }
}

function createDeps(sessionID: string) {
  let observedMessageOptions: unknown
  let observedWaitOptions: unknown
  const deps = {
    createOrGetSession: mock(async () => ({ sessionID, isNew: true })),
    captureMessageBaseline: mock(async () => new Set(["id:old-assistant"])),
    waitForCompletion: mock(async (_id: string, _toolContext: unknown, _ctx: unknown, options: unknown) => {
      observedWaitOptions = options
    }),
    processMessages: mock(async (_id: string, _ctx: unknown, options: unknown) => {
      observedMessageOptions = options
      return '{"artifact_kind":"thinker_raw_verdict_v21"}'
    }),
    setSessionFallbackChain: mock(() => {}),
    clearSessionFallbackChain: mock(() => {}),
  }

  return {
    deps,
    getObservedMessageOptions: () => observedMessageOptions,
    getObservedWaitOptions: () => observedWaitOptions,
  }
}

test.each([
  ["momus", "thinker_v2", "thinker_raw_verdict"],
  ["oracle", "thinker_v2", "thinker_raw_verdict"],
  ["explore", "thinker_v21", "thinker_raw_verdict_v21"],
  ["momus", "thinker_v21", "thinker_raw_verdict_v21"],
  ["oracle", "thinker_v21", "thinker_raw_verdict_v21"],
])("routes %s through explicit %s structured output", async (agent, responseMode, artifactKind) => {
  const sessionID = `ses-structured-${agent}-${responseMode}`
  const { ctx, toolContext } = createContext(sessionID)
  const { deps, getObservedMessageOptions, getObservedWaitOptions } = createDeps(sessionID)

  await executeSync(
    {
      subagent_type: agent,
      description: "structured review",
      prompt: "Review the frozen artifact.",
      response_mode: responseMode,
      run_in_background: false,
    } as never,
    toolContext,
    ctx as never,
    deps as never,
  )

  expect(getObservedMessageOptions()).toEqual(expect.objectContaining({
    expectedArtifactKind: artifactKind,
    baselineMessageKeys: new Set(["id:old-assistant"]),
    expectedPromptMessageID: expect.any(String),
  }))
  expect(getObservedWaitOptions()).toEqual(expect.objectContaining({
    maxPollTimeMs: 10 * 60 * 1000,
    baselineMessageKeys: new Set(["id:old-assistant"]),
    expectedPromptMessageID: expect.any(String),
  }))
})

test("preserves child metadata when structured response processing fails", async () => {
  const sessionID = "ses-structured-invalid-response"
  const { ctx, toolContext } = createContext(sessionID)
  const { deps } = createDeps(sessionID)
  deps.processMessages = mock(async () => {
    throw new Error("Structured reviewer response must be one JSON mapping.")
  })

  const result = await executeSync(
    {
      subagent_type: "explore",
      description: "structured review",
      prompt: "Review the frozen artifact.",
      prompt_receipt: {
        source: "file",
        byteCount: 27,
        sha256: "a".repeat(64),
      },
      response_mode: "thinker_v21",
      run_in_background: false,
    } as never,
    toolContext,
    ctx as never,
    deps as never,
  )

  expect(result).toContain("Error: Structured reviewer response must be one JSON mapping.")
  expect(result).toContain(`<task_metadata>\nsession_id: ${sessionID}`)
  expect(result).toContain("prompt_source: file")
  expect(result).toContain("prompt_bytes: 27")
  expect(result).toContain(`prompt_sha256: ${"a".repeat(64)}`)
  expect(result.match(/<task_metadata>/g)).toHaveLength(1)
  expect(result.match(/<\/task_metadata>/g)).toHaveLength(1)
})

test("keeps combined processing when a prompt happens to mention Thinker markers", async () => {
  const sessionID = "ses-ordinary-review"
  const { ctx, toolContext } = createContext(sessionID)
  const { deps, getObservedMessageOptions, getObservedWaitOptions } = createDeps(sessionID)

  await executeSync(
    {
      subagent_type: "momus",
      description: "ordinary review",
      prompt: "Find THINKER_V2_CONTEXT_MANIFEST_JSON and thinker_raw_verdict references.",
      run_in_background: false,
    },
    toolContext,
    ctx as never,
    deps as never,
  )

  expect(getObservedMessageOptions()).toEqual(expect.objectContaining({
    expectedArtifactKind: undefined,
    baselineMessageKeys: new Set(["id:old-assistant"]),
  }))
  expect(getObservedWaitOptions()).toEqual(expect.objectContaining({
    baselineMessageKeys: new Set(["id:old-assistant"]),
  }))
})

test("rejects structured output modes for an unsupported agent", async () => {
  const sessionID = "ses-unsupported-structured-review"
  const { ctx, toolContext } = createContext(sessionID)
  const { deps } = createDeps(sessionID)

  await expect(executeSync(
    {
      subagent_type: "librarian",
      description: "structured review",
      prompt: "Review the frozen artifact.",
      response_mode: "thinker_v2",
      run_in_background: false,
    } as never,
    toolContext,
    ctx as never,
    deps as never,
  )).rejects.toThrow("response_mode thinker_v2 is only supported")
  expect(deps.createOrGetSession).not.toHaveBeenCalled()
  expect(ctx.client.session.prompt).not.toHaveBeenCalled()
})
