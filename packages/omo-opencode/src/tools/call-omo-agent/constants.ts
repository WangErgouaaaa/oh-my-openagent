export const ALLOWED_AGENTS = [
  "explore",
  "librarian",
] as const

export const OPTIONAL_REVIEW_AGENTS = [
  "momus",
  "oracle",
] as const

export const STRUCTURED_REVIEW_RESPONSE_MODES = [
  "thinker_v2",
  "thinker_v21",
] as const

export const REVIEW_AGENT_OPT_IN_ENV = "OMO_CALL_OMO_REVIEW_AGENTS"

export const CALL_OMO_AGENT_DESCRIPTION = `Spawn a configured direct subagent. run_in_background REQUIRED (true=async with task_id, false=sync).

Allowed agents:
{agents}

Agents outside this configured set, custom agents, and task categories are intentionally not supported by this tool.

Provide exactly one of \`prompt\` or \`prompt_file\`. A \`prompt_file\` requires \`prompt_sha256\` and must be under an approved root.

Pass \`session_id=<id>\` to continue previous agent with full context. Nested subagent depth is tracked automatically and blocked past the configured limit. Prompts MUST be in English. Use \`background_output\` for async results.`
