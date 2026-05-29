import type { ProviderCapabilities } from '../../types';

/**
 * claude-bg capabilities — deliberately narrower than CLAUDE_CAPABILITIES.
 * `claude --bg` is the interactive CLI in batch mode: no in-process hooks,
 * no inline agent/skill definitions, no -p-only flags (json schema output,
 * max-budget). Declaring these false makes the dag-executor warn when a
 * workflow node asks for them, instead of failing silently (CLAUDE.md:
 * Fail Fast + Explicit Errors).
 */
export const CLAUDE_BG_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: true,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
