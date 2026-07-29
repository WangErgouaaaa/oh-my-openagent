import type { PluginInput } from "@opencode-ai/plugin";
import {
  ALLOWED_AGENTS,
  OPTIONAL_REVIEW_AGENTS,
  REVIEW_AGENT_OPT_IN_ENV,
} from "./constants";

type Environment = Record<string, string | undefined>;

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function getConfiguredCallableAgents(
  env: Environment = process.env,
): string[] {
  if (!isTruthy(env[REVIEW_AGENT_OPT_IN_ENV])) {
    return [...ALLOWED_AGENTS];
  }

  return [...ALLOWED_AGENTS, ...OPTIONAL_REVIEW_AGENTS];
}

export function clearCallableAgentsCache(): void {
  // Kept for existing test setup and external callers; the resolver is now static.
}

/**
 * Resolves the set of callable agent names for call_omo_agent.
 *
 * This tool is deliberately narrower than delegate-task. It launches lookup
 * agents by default and may add the fixed review-agent set only through an
 * explicit runtime opt-in. Dynamic agents still must go through task().
 */
export async function resolveCallableAgents(
  _client?: PluginInput["client"],
  _sessionId?: string,
  env: Environment = process.env,
): Promise<string[]> {
  return getConfiguredCallableAgents(env);
}
