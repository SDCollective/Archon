/**
 * Translate Archon node/request options into `claude --bg` CLI arguments.
 * Pure function (no env, no fs) so it is exhaustively unit-testable.
 *
 * Hard rules (spec §5.2):
 *  - ALWAYS `--bg`; prompt is the final positional arg.
 *  - NEVER a `--permission-mode` flag — bypassPermissions/auto are refused on
 *    --bg until interactively accepted; the agent runs under the repo's
 *    .claude/settings.json allowlist instead.
 *  - NEVER -p-only flags (--max-budget-usd, --output-format json) — declared
 *    unsupported in CLAUDE_BG_CAPABILITIES.
 */
export interface BuildArgsInput {
  prompt: string;
  nodeId?: string;
  model?: string;
  resumeSessionId?: string;
  agent?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  mcpConfigPath?: string;
  effort?: string;
}

export function buildClaudeBgArgs(input: BuildArgsInput): string[] {
  const args: string[] = [];

  if (input.agent) args.push('--agent', input.agent);
  if (input.nodeId) args.push('-n', input.nodeId);
  if (input.model) args.push('--model', input.model);
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);
  if (input.allowedTools && input.allowedTools.length > 0) {
    args.push('--allowedTools', input.allowedTools.join(','));
  }
  if (input.deniedTools && input.deniedTools.length > 0) {
    args.push('--disallowedTools', input.deniedTools.join(','));
  }
  if (input.mcpConfigPath) args.push('--mcp-config', input.mcpConfigPath);
  if (input.effort) args.push('--effort', input.effort);

  args.push('--bg');
  args.push(input.prompt);
  return args;
}
