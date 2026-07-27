import { expect, test } from "bun:test"
import { createCallOmoAgent } from "./tools"

type PluginInput = import("@opencode-ai/plugin").PluginInput
type BackgroundManager = import("../../features/background-agent").BackgroundManager

test("preserves frozen-prompt review capabilities in the installed tool schema", () => {
  const toolDefinition = createCallOmoAgent(
    {
      client: {},
      directory: "/tmp",
    } as unknown as PluginInput,
    {} as BackgroundManager,
    [],
    undefined,
    undefined,
    undefined,
    {
      env: { OMO_CALL_OMO_REVIEW_AGENTS: "1" },
    },
  )

  expect(toolDefinition.description).toContain("- momus:")
  expect(toolDefinition.description).toContain("- oracle:")
  expect(toolDefinition.args.prompt_file).toBeDefined()
  expect(toolDefinition.args.prompt_sha256).toBeDefined()
  expect(toolDefinition.args.response_mode).toBeDefined()
})
