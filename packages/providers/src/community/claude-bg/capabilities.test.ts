import { describe, expect, test } from 'bun:test';
import { CLAUDE_BG_CAPABILITIES } from './capabilities';

describe('CLAUDE_BG_CAPABILITIES', () => {
  test('declares the supported flags true', () => {
    expect(CLAUDE_BG_CAPABILITIES.sessionResume).toBe(true);
    expect(CLAUDE_BG_CAPABILITIES.mcp).toBe(true);
    expect(CLAUDE_BG_CAPABILITIES.toolRestrictions).toBe(true);
    expect(CLAUDE_BG_CAPABILITIES.effortControl).toBe(true);
    expect(CLAUDE_BG_CAPABILITIES.envInjection).toBe(true);
  });

  test('declares the unsupported --bg features false', () => {
    expect(CLAUDE_BG_CAPABILITIES.hooks).toBe(false);
    expect(CLAUDE_BG_CAPABILITIES.skills).toBe(false);
    expect(CLAUDE_BG_CAPABILITIES.agents).toBe(false);
    expect(CLAUDE_BG_CAPABILITIES.structuredOutput).toBe(false);
    expect(CLAUDE_BG_CAPABILITIES.costControl).toBe(false);
    expect(CLAUDE_BG_CAPABILITIES.thinkingControl).toBe(false);
    expect(CLAUDE_BG_CAPABILITIES.fallbackModel).toBe(false);
    expect(CLAUDE_BG_CAPABILITIES.sandbox).toBe(false);
  });
});
