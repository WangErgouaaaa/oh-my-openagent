import { expect, test } from "bun:test"

import { createExploreAgent } from "./explore"

test("#given a caller requires machine-readable output #when creating Explore #then the caller format takes precedence", () => {
  // given
  const model = "deepseek/deepseek-v4-flash"

  // when
  const prompt = createExploreAgent(model).prompt

  // then
  expect(prompt).toContain(
    "When the caller requires a machine-readable response format, that contract replaces the default format below; all exploration rules still apply.",
  )
})
