import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  _resetForTesting,
  subagentSessions,
  syncSubagentSessions,
} from "../../features/claude-code-session-state"
import { waitForCompletion } from "./completion-poller"
import { executeSync } from "./sync-executor"

type ExecuteSyncArgs = Parameters<typeof executeSync>[0]
type ExecuteSyncToolContext = Parameters<typeof executeSync>[1]
type ExecuteSyncDeps = NonNullable<Parameters<typeof executeSync>[3]>

function createArgs(): ExecuteSyncArgs {
  return {
    subagent_type: "explore",
    description: "cleanup leak",
    prompt: "find something",
    run_in_background: false,
  }
}

function createToolContext(): ExecuteSyncToolContext {
  return {
    sessionID: "parent-session",
    messageID: "msg-1",
    agent: "sisyphus",
    abort: new AbortController().signal,
    metadata: mock(async () => {}),
  }
}

function createContext(
  promptAsync: ReturnType<typeof mock>,
  abort = mock(async () => ({ data: true })),
) {
  return {
    client: {
      session: {
        abort,
        prompt: promptAsync,
        promptAsync,
      },
    },
  }
}

function createDependencies(overrides?: Partial<ExecuteSyncDeps>): ExecuteSyncDeps {
  return {
    createOrGetSession: mock(async () => ({ sessionID: "ses-default", isNew: true })),
    captureMessageBaseline: mock(async () => new Set()),
    waitForCompletion: mock(async () => {}),
    processMessages: mock(async () => "agent response"),
    setSessionFallbackChain: mock(() => {}),
    clearSessionFallbackChain: mock(() => {}),
    ...overrides,
  }
}

describe("executeSync session cleanup", () => {
  beforeEach(() => {
    _resetForTesting()
  })

  afterEach(() => {
    _resetForTesting()
  })

  describe("#given executeSync creates a session", () => {
    test("#when execution completes successfully #then sessionID is removed from subagentSessions and syncSubagentSessions", async () => {
      // given
      const sessionID = "ses-cleanup-success"
      const args = createArgs()
      const toolContext = createToolContext()
      const promptAsync = mock(async () => ({ data: {} }))
      const deps = createDependencies({
        createOrGetSession: mock(async () => {
          subagentSessions.add(sessionID)
          syncSubagentSessions.add(sessionID)
          return { sessionID, isNew: true }
        }),
        waitForCompletion: mock(async (createdSessionID: string) => {
          expect(createdSessionID).toBe(sessionID)
          expect(subagentSessions.has(sessionID)).toBe(true)
          expect(syncSubagentSessions.has(sessionID)).toBe(true)
        }),
      })

      expect(subagentSessions.has(sessionID)).toBe(false)
      expect(syncSubagentSessions.has(sessionID)).toBe(false)

      // when
      const result = await executeSync(args, toolContext, createContext(promptAsync) as never, deps)

      // then
      expect(result).toContain(`session_id: ${sessionID}`)
      expect(subagentSessions.has(sessionID)).toBe(false)
      expect(syncSubagentSessions.has(sessionID)).toBe(false)
    })

    test("#when prompt dispatch fails #then the child session is not aborted", async () => {
      const abort = mock(async () => ({ data: true }))
      const result = await executeSync(
        createArgs(),
        createToolContext(),
        createContext(mock(async () => {
          throw new Error("prompt rejected")
        }), abort) as never,
        createDependencies(),
      )

      expect(result).toContain("Error: Failed to send prompt: prompt rejected")
      expect(abort).not.toHaveBeenCalled()
    })

    test("#when execution throws an error #then sessionID is still removed from both Sets", async () => {
      // given
      const sessionID = "ses-cleanup-error"
      const args = createArgs()
      const toolContext = createToolContext()
      const promptAsync = mock(async () => ({ data: {} }))
      const deps = createDependencies({
        createOrGetSession: mock(async () => {
          subagentSessions.add(sessionID)
          syncSubagentSessions.add(sessionID)
          return { sessionID, isNew: true }
        }),
        waitForCompletion: mock(async (createdSessionID: string) => {
          expect(createdSessionID).toBe(sessionID)
          expect(subagentSessions.has(sessionID)).toBe(true)
          expect(syncSubagentSessions.has(sessionID)).toBe(true)
          throw new Error("poll exploded")
        }),
      })

      // when
      const resultPromise = executeSync(args, toolContext, createContext(promptAsync) as never, deps)

      // then
      let thrownError: Error | undefined

      try {
        await resultPromise
      } catch (error) {
        if (error instanceof Error) {
          thrownError = error
        } else {
          throw error
        }
      }

      expect(thrownError?.message).toBe("poll exploded")
      expect(subagentSessions.has(sessionID)).toBe(false)
      expect(syncSubagentSessions.has(sessionID)).toBe(false)
    })

    test("#when a structured review times out #then the exact child session is aborted", async () => {
      const sessionID = "ses-structured-timeout"
      const abort = mock(async () => ({ data: true }))
      const deps = createDependencies({
        createOrGetSession: mock(async () => ({ sessionID, isNew: true })),
        waitForCompletion: mock(async () => {
          throw new Error("Agent task timed out after 10 minutes.")
        }),
      })

      const result = await executeSync(
        { ...createArgs(), response_mode: "thinker_v21" },
        createToolContext(),
        createContext(mock(async (input: { body: { messageID: string } }) => ({
          data: { info: { parentID: input.body.messageID } },
        })), abort) as never,
        deps,
      )

      expect(result).toContain("Agent task timed out after 10 minutes.")
      expect(abort).toHaveBeenCalledTimes(1)
      expect(abort).toHaveBeenCalledWith({ path: { id: sessionID } })
    })

    test("#when cancellation arrives with a bound structured response #then the exact child session is aborted", async () => {
      const sessionID = "ses-cancel-bound-response"
      const abortController = new AbortController()
      const abort = mock(async () => ({ data: true }))
      const processMessages = mock(async () => "must not run")

      const result = await executeSync(
        { ...createArgs(), response_mode: "thinker_v21" },
        { ...createToolContext(), abort: abortController.signal },
        createContext(mock(async (input: { body: { messageID: string } }) => {
          abortController.abort()
          return {
            data: {
              info: {
                id: "assistant-final",
                role: "assistant",
                parentID: input.body.messageID,
                structured: { artifact_kind: "thinker_raw_verdict_v21" },
              },
              parts: [],
            },
          }
        }), abort) as never,
        createDependencies({
          createOrGetSession: mock(async () => ({ sessionID, isNew: true })),
          processMessages,
        }),
      )

      expect(result).toContain("Task aborted.")
      expect(processMessages).not.toHaveBeenCalled()
      expect(abort).toHaveBeenCalledTimes(1)
      expect(abort).toHaveBeenCalledWith({ path: { id: sessionID } })
    })

    test.each([
      ["returns an SDK error", async () => ({ error: "abort denied" }), false],
      ["rejects", async () => { throw new Error("abort transport failed") }, false],
      ["times out", async () => new Promise<never>(() => {}), true],
    ])("#when completion polling fails and child abort %s #then both failures are surfaced", async (
      _case,
      abortImplementation,
      forceAbortTimeout,
    ) => {
      const sessionID = "ses-abort-cleanup-failure"
      const abort = mock(abortImplementation)
      const originalSetTimeout = globalThis.setTimeout
      if (forceAbortTimeout) {
        globalThis.setTimeout = ((handler: TimerHandler) => {
          if (typeof handler === "function") handler()
          return originalSetTimeout(() => {}, 0)
        }) as typeof globalThis.setTimeout
      }

      try {
        const execution = executeSync(
          { ...createArgs(), response_mode: "thinker_v21" },
          createToolContext(),
          createContext(mock(async (input: { body: { messageID: string } }) => ({
            data: { info: { parentID: input.body.messageID } },
          })), abort) as never,
          createDependencies({
            createOrGetSession: mock(async () => ({ sessionID, isNew: true })),
            waitForCompletion: mock(async () => {
              throw new Error("polling failed")
            }),
          }),
        )

        await expect(execution).rejects.toThrow(
          `Failed to abort child session ${sessionID} after completion polling failed: polling failed`,
        )
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
      expect(abort).toHaveBeenCalledWith({ path: { id: sessionID } })
    })

    test("#when cancellation arrives during the final message read #then the exact child session is aborted", async () => {
      const sessionID = "ses-cancel-during-final-read"
      const abortController = new AbortController()
      const abort = mock(async () => ({ data: true }))
      let promptMessageID = ""
      const promptAsync = mock(async (input: { body: { messageID: string } }) => {
        promptMessageID = input.body.messageID
        return { data: { info: { parentID: promptMessageID } } }
      })
      let messageReads = 0
      const context = {
        client: {
          session: {
            abort,
            prompt: promptAsync,
            promptAsync,
            status: mock(async () => ({ data: { [sessionID]: { type: "idle" } } })),
            messages: mock(async () => {
              if (!promptMessageID) return { data: [] }
              messageReads += 1
              if (messageReads === 4) abortController.abort()
              return {
                data: [
                  { info: { id: promptMessageID, role: "user" } },
                  { info: { id: "answer", role: "assistant", parentID: promptMessageID } },
                ],
              }
            }),
          },
        },
      }

      const result = await executeSync(
        { ...createArgs(), response_mode: "thinker_v21" },
        { ...createToolContext(), abort: abortController.signal },
        context as never,
        createDependencies({
          createOrGetSession: mock(async () => ({ sessionID, isNew: true })),
          waitForCompletion,
        }),
      )

      expect(result).toContain("Task aborted.")
      expect(abort).toHaveBeenCalledTimes(1)
      expect(abort).toHaveBeenCalledWith({ path: { id: sessionID } })
    })

    test("#when structured response processing fails #then the completed child session is not aborted", async () => {
      const abort = mock(async () => ({ data: true }))
      const result = await executeSync(
        { ...createArgs(), response_mode: "thinker_v21" },
        createToolContext(),
        createContext(mock(async (input: { body: { messageID: string } }) => ({
          data: { info: { parentID: input.body.messageID } },
        })), abort) as never,
        createDependencies({
          processMessages: mock(async () => {
            throw new Error("invalid structured response")
          }),
        }),
      )

      expect(result).toContain("Error: invalid structured response")
      expect(abort).not.toHaveBeenCalled()
    })
  })

  describe("#given executeSync reuses an existing session", () => {
    test("#when execution completes successfully #then the reused session is tracked in both Sets", async () => {
      // given
      const sessionID = "ses-reused"
      const args = { ...createArgs(), session_id: sessionID }
      const toolContext = createToolContext()
      const promptAsync = mock(async () => ({ data: {} }))
      const deps = createDependencies({
        createOrGetSession: mock(async () => ({ sessionID, isNew: false })),
        waitForCompletion: mock(async (createdSessionID: string) => {
          expect(createdSessionID).toBe(sessionID)
          expect(subagentSessions.has(sessionID)).toBe(true)
          expect(syncSubagentSessions.has(sessionID)).toBe(true)
        }),
      })

      expect(subagentSessions.has(sessionID)).toBe(false)
      expect(syncSubagentSessions.has(sessionID)).toBe(false)

      // when
      const result = await executeSync(args, toolContext, createContext(promptAsync) as never, deps)

      // then
      expect(result).toContain(`session_id: ${sessionID}`)
      expect(subagentSessions.has(sessionID)).toBe(true)
      expect(syncSubagentSessions.has(sessionID)).toBe(true)
    })

    test("#when completion polling fails #then the exact reused session is aborted", async () => {
      const sessionID = "ses-reused-timeout"
      const abort = mock(async () => ({ data: true }))
      const result = await executeSync(
        { ...createArgs(), session_id: sessionID, response_mode: "thinker_v21" },
        createToolContext(),
        createContext(mock(async (input: { body: { messageID: string } }) => ({
          data: { info: { parentID: input.body.messageID } },
        })), abort) as never,
        createDependencies({
          createOrGetSession: mock(async () => ({ sessionID, isNew: false })),
          waitForCompletion: mock(async () => {
            throw new Error("reused session poll failed")
          }),
        }),
      )

      expect(result).toContain("Error: reused session poll failed")
      expect(abort).toHaveBeenCalledTimes(1)
      expect(abort).toHaveBeenCalledWith({ path: { id: sessionID } })
    })

    test("#when execution applies a fallback chain #then it clears that chain in finally", async () => {
      // given
      const sessionID = "ses-reused-fallback"
      const args = { ...createArgs(), session_id: sessionID }
      const toolContext = createToolContext()
      const promptAsync = mock(async () => ({ data: {} }))
      const clearSessionFallbackChain = mock(() => {})
      const deps = createDependencies({
        createOrGetSession: mock(async () => ({ sessionID, isNew: false })),
        clearSessionFallbackChain,
      })
      const fallbackChain = [{ providers: ["openai"], model: "gpt-5.4" }]

      // when
      await executeSync(args, toolContext, createContext(promptAsync) as never, deps, fallbackChain)

      // then
      expect(clearSessionFallbackChain).toHaveBeenCalledWith(sessionID)
    })
  })
})
