import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin"
import {
  CALL_OMO_AGENT_DESCRIPTION,
  STRUCTURED_REVIEW_RESPONSE_MODES,
} from "./constants"
import type {
  CallOmoAgentArgs,
  CallOmoAgentRuntimeOptions,
  CallOmoAgentToolArgs,
  ToolContextWithMetadata,
} from "./types"
import type { BackgroundManager } from "../../features/background-agent"
import type { ModelFallbackControllerAccessor } from "../../hooks/model-fallback"
import type { CategoriesConfig, AgentOverrides } from "../../config/schema"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import type { FallbackEntry } from "../../shared/model-requirements"
import { AGENT_MODEL_REQUIREMENTS } from "../../shared/model-requirements"
import { getAgentConfigKey, stripInvisibleAgentCharacters } from "../../shared/agent-display-names"
import { normalizeFallbackModels } from "../../shared/model-resolver"
import { buildFallbackChainFromModels } from "../../shared/fallback-chain-from-models"
import { log } from "../../shared"
import { parseModelString } from "../../shared"
import { executeBackground } from "./background-executor"
import { executeSync } from "./sync-executor"
import {
  getConfiguredCallableAgents,
  resolveCallableAgents,
} from "./agent-resolver"
import {
  getExternalPromptFileRoots,
  resolveCallOmoPromptWithReceipt,
} from "./prompt-resolver"
import { createOrGetSession } from "./session-creator"
import { processMessages } from "./message-processor"
import { captureMessageBaseline, waitForCompletion } from "./completion-poller"
import { getFirstFallbackModel } from "../../agents/builtin-agents/model-resolution"

function createSyncExecutorDeps(modelFallbackControllerAccessor?: ModelFallbackControllerAccessor) {
  return {
    createOrGetSession,
    captureMessageBaseline,
    waitForCompletion,
    processMessages,
    setSessionFallbackChain: (sessionID: string, fallbackChain: FallbackEntry[] | undefined) => {
      modelFallbackControllerAccessor?.setSessionFallbackChain(sessionID, fallbackChain)
    },
    clearSessionFallbackChain: (sessionID: string) => {
      modelFallbackControllerAccessor?.clearSessionFallbackChain(sessionID)
    },
  }
}

function resolveModelAndFallbackChain(args: {
  subagentType: string
  agentOverrides?: AgentOverrides
  userCategories?: CategoriesConfig
}): { model: DelegatedModelConfig | undefined; fallbackChain: FallbackEntry[] | undefined } {
  const { subagentType, agentOverrides, userCategories } = args
  const agentConfigKey = getAgentConfigKey(subagentType)
  const agentRequirement = AGENT_MODEL_REQUIREMENTS[agentConfigKey]

  const agentOverride = agentOverrides?.[agentConfigKey as keyof AgentOverrides]
    ?? (agentOverrides
      ? Object.entries(agentOverrides).find(([key]) => key.toLowerCase() === agentConfigKey)?.[1]
      : undefined)
  const agentCategoryModel = agentOverride?.category
    ? userCategories?.[agentOverride.category]?.model
    : undefined
  const agentCategoryVariant = agentOverride?.category
    ? userCategories?.[agentOverride.category]?.variant
    : undefined

  let model: DelegatedModelConfig | undefined
  if (agentOverride?.model) {
    const normalized = parseModelString(agentOverride.model)
    if (normalized) {
      model = agentOverride.variant ? { ...normalized, variant: agentOverride.variant } : normalized
      log("[call_omo_agent] Resolved model override from agent config", {
        agent: subagentType,
        model: agentOverride.model,
        variant: agentOverride.variant,
      })
    }
  } else if (agentCategoryModel) {
    const normalized = parseModelString(agentCategoryModel)
    if (normalized) {
      const variantToUse = agentOverride?.variant ?? agentCategoryVariant
      model = variantToUse ? { ...normalized, variant: variantToUse } : normalized
      log("[call_omo_agent] Resolved model override from agent category", {
        agent: subagentType,
        category: agentOverride?.category,
        model: agentCategoryModel,
        variant: variantToUse,
      })
    }
  } else {
    const firstFallback = getFirstFallbackModel(agentRequirement)
    if (firstFallback) {
      const normalized = parseModelString(firstFallback.model)
      if (normalized) {
        model = firstFallback.variant ? { ...normalized, variant: firstFallback.variant } : normalized
        log("[call_omo_agent] Resolved model from first fallbackChain entry", {
          agent: subagentType,
          model: firstFallback.model,
          variant: firstFallback.variant,
        })
      }
    }
  }

  const normalizedFallbackModels = normalizeFallbackModels(
    agentOverride?.fallback_models
    ?? (agentOverride?.category ? userCategories?.[agentOverride.category]?.fallback_models : undefined)
  )
  const defaultProviderID = model?.providerID
    ?? agentRequirement?.fallbackChain?.[0]?.providers?.[0]
    ?? "opencode"
  const configuredFallbackChain = buildFallbackChainFromModels(normalizedFallbackModels, defaultProviderID)

  return {
    model,
    fallbackChain: configuredFallbackChain ?? agentRequirement?.fallbackChain,
  }
}

export function createCallOmoAgent(
  ctx: PluginInput,
  backgroundManager: BackgroundManager,
  disabledAgents: string[] = [],
  agentOverrides?: AgentOverrides,
  userCategories?: CategoriesConfig,
  modelFallbackControllerAccessor?: ModelFallbackControllerAccessor,
  runtimeOptions: CallOmoAgentRuntimeOptions = {},
): ToolDefinition {
  const env = runtimeOptions.env ?? process.env
  const configuredCallableAgents = getConfiguredCallableAgents(env)
  const agentDescriptions = configuredCallableAgents.map(
    (name) => `- ${name}: Specialized agent for ${name} tasks`,
  ).join("\n");
  const description = CALL_OMO_AGENT_DESCRIPTION.replace(
    "{agents}",
    agentDescriptions,
  );

  return tool({
    description,
    args: {
      description: tool.schema
        .string()
        .describe("A short (3-5 words) description of the task"),
      prompt: tool.schema
        .string()
        .describe("Literal task prompt. Provide exactly one of prompt or prompt_file.")
        .optional(),
      prompt_file: tool.schema.preprocess(
        (value) => value === "" ? undefined : value,
        tool.schema.string().optional(),
      )
        .describe("Absolute UTF-8 prompt file under an approved root. Requires prompt_sha256."),
      prompt_sha256: tool.schema.preprocess(
        (value) => value === "" ? undefined : value,
        tool.schema.string().optional(),
      )
        .describe("Expected SHA-256 hexadecimal digest for prompt_file."),
      response_mode: tool.schema.preprocess(
        (value) => value === "" ? undefined : value,
        tool.schema.enum(STRUCTURED_REVIEW_RESPONSE_MODES).optional(),
      )
        .describe("Optional strict reviewer result contract. thinker_v2 is for Momus or Oracle; thinker_v21 also allows Explore."),
      subagent_type: tool.schema
        .string()
        .describe(
          `The agent to invoke. Allowed: ${configuredCallableAgents.join(", ")}.`,
        ),
      run_in_background: tool.schema
        .boolean()
        .describe(
          "REQUIRED. true: run asynchronously (use background_output to get results), false: run synchronously and wait for completion",
        ),
      session_id: tool.schema.preprocess(
        (value) => value === "" ? undefined : value,
        tool.schema.string().optional(),
      )
        .describe("Existing Task session to continue"),
    },
    async execute(args: CallOmoAgentToolArgs, toolContext) {
      const toolCtx = toolContext as ToolContextWithMetadata;
      log(
        `[call_omo_agent] Starting with agent: ${args.subagent_type}, background: ${args.run_in_background}`,
      );

      if (typeof args.subagent_type !== "string" || args.subagent_type.trim() === "") {
        return "Error: subagent_type is required."
      }

      const callableAgents = await resolveCallableAgents(ctx.client, undefined, env);

      // Strip ZWSP and case-insensitive agent validation - allows "Explore", "EXPLORE", "explore" etc.
      const strippedAgentType = stripInvisibleAgentCharacters(args.subagent_type)
      if (
        !callableAgents.some(
          (name) => name.toLowerCase() === strippedAgentType.toLowerCase(),
        )
      ) {
        return `Error: Invalid agent type "${args.subagent_type}". Only ${callableAgents.join(", ")} are allowed.`;
      }

      const normalizedAgent = strippedAgentType.toLowerCase();

      // Check if agent is disabled
      if (disabledAgents.some((disabled) => stripInvisibleAgentCharacters(disabled).toLowerCase() === normalizedAgent)) {
        return `Error: Agent "${normalizedAgent}" is disabled via disabled_agents configuration. Remove it from disabled_agents in your .omo/omo.jsonc to use it.`
      }

      if (args.response_mode && args.run_in_background) {
        return "Error: response_mode is only supported when run_in_background=false."
      }

      let promptResolution
      try {
        promptResolution = resolveCallOmoPromptWithReceipt(args, {
          workspaceDirectory: ctx.directory,
          externalAllowedRoots:
            runtimeOptions.promptFileRoots ?? getExternalPromptFileRoots(env),
        })
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`
      }

      const resolvedArgs: CallOmoAgentArgs = {
        description: args.description,
        prompt: promptResolution.prompt,
        prompt_receipt: promptResolution.receipt,
        ...(args.response_mode ? { response_mode: args.response_mode } : {}),
        subagent_type: normalizedAgent,
        run_in_background: args.run_in_background,
        ...(args.session_id ? { session_id: args.session_id } : {}),
      }

      const { model: resolvedModel, fallbackChain } = resolveModelAndFallbackChain({
        subagentType: resolvedArgs.subagent_type,
        agentOverrides,
        userCategories,
      })

      if (resolvedArgs.run_in_background) {
        if (resolvedArgs.session_id) {
          return `Error: session_id is not supported in background mode. Use run_in_background=false to continue an existing session.`;
        }
        return await executeBackground(resolvedArgs, toolCtx, backgroundManager, ctx.client, fallbackChain, resolvedModel)
      }

      if (!resolvedArgs.session_id) {
        let spawnReservation: Awaited<ReturnType<BackgroundManager["reserveSubagentSpawn"]>> | undefined
        try {
          spawnReservation = await backgroundManager.reserveSubagentSpawn(toolCtx.sessionID)
          return await executeSync(
            resolvedArgs,
            toolCtx,
            ctx,
            createSyncExecutorDeps(modelFallbackControllerAccessor),
            fallbackChain,
            spawnReservation,
            resolvedModel,
          )
        } catch (error) {
          spawnReservation?.rollback()
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      return await executeSync(
        resolvedArgs,
        toolCtx,
        ctx,
        createSyncExecutorDeps(modelFallbackControllerAccessor),
        fallbackChain,
        undefined,
        resolvedModel,
      )
    },
  });
}
