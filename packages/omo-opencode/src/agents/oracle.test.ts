import { describe, expect, test } from "bun:test"

import { createOracleAgent } from "./oracle"

describe("createOracleAgent", () => {
  test("#given a caller requires machine-readable output #when creating any Oracle variant #then the caller format takes precedence", () => {
    // given
    const models = [
      "openai/gpt-5.6-sol",
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
    ]

    // when
    const prompts = models.map((model) => createOracleAgent(model).prompt)

    // then
    for (const prompt of prompts) {
      expect(prompt).toContain(
        "When the caller requires a machine-readable response format, that contract replaces the default format below; all consultation rules still apply.",
      )
    }
  })

  test("uses xhigh reasoning effort for gpt-5.6", () => {
    // given
    const model = "openai/gpt-5.6-sol"

    // when
    const agent = createOracleAgent(model)

    // then
    expect(agent.reasoningEffort).toBe("xhigh")
  })

  test("preserves medium reasoning effort for gpt-5.5 fallback", () => {
    // given
    const model = "openai/gpt-5.5"

    // when
    const agent = createOracleAgent(model)

    // then
    expect(agent.reasoningEffort).toBe("medium")
  })
})
