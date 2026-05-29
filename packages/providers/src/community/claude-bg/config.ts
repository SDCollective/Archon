import type { ClaudeBgProviderDefaults } from '../../types';

export type { ClaudeBgProviderDefaults };

/**
 * Parse raw YAML-derived config into typed claude-bg defaults.
 * Defensive: invalid fields are dropped silently (matches parsePiConfig /
 * parseClaudeConfig — never throws, so broken user config can't block
 * provider registration or workflow discovery).
 */
export function parseClaudeBgConfig(raw: Record<string, unknown>): ClaudeBgProviderDefaults {
  const result: ClaudeBgProviderDefaults = {};

  if (typeof raw.model === 'string') result.model = raw.model;
  if (typeof raw.claudeBinaryPath === 'string') result.claudeBinaryPath = raw.claudeBinaryPath;
  if (typeof raw.defaultAgent === 'string') result.defaultAgent = raw.defaultAgent;
  if (
    typeof raw.pollIntervalMs === 'number' &&
    Number.isInteger(raw.pollIntervalMs) &&
    raw.pollIntervalMs > 0
  ) {
    result.pollIntervalMs = raw.pollIntervalMs;
  }

  return result;
}
