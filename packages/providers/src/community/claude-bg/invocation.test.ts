import { describe, expect, test } from 'bun:test';
import { buildClaudeBgArgs } from './invocation';

describe('buildClaudeBgArgs', () => {
  test('minimal: always backgrounds, prompt is last positional', () => {
    const args = buildClaudeBgArgs({ prompt: 'do the thing' });
    expect(args).toContain('--bg');
    expect(args[args.length - 1]).toBe('do the thing');
  });

  test('never sets a permission-mode flag (refused on --bg)', () => {
    const args = buildClaudeBgArgs({ prompt: 'x', allowedTools: ['Read'] });
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('bypassPermissions');
  });

  test('maps the supported options to flags', () => {
    const args = buildClaudeBgArgs({
      prompt: 'p',
      nodeId: 'build',
      model: 'opus',
      resumeSessionId: 'abc123',
      agent: 'story-developer',
      systemPrompt: 'be terse',
      allowedTools: ['Read', 'Edit'],
      deniedTools: ['Bash(rm *)'],
      mcpConfigPath: '/tmp/mcp.json',
      effort: 'high',
    });
    const pair = (flag: string) => args[args.indexOf(flag) + 1];
    expect(pair('-n')).toBe('build');
    expect(pair('--model')).toBe('opus');
    expect(pair('--resume')).toBe('abc123');
    expect(pair('--agent')).toBe('story-developer');
    expect(pair('--append-system-prompt')).toBe('be terse');
    expect(pair('--allowedTools')).toBe('Read,Edit');
    expect(pair('--disallowedTools')).toBe('Bash(rm *)');
    expect(pair('--mcp-config')).toBe('/tmp/mcp.json');
    expect(pair('--effort')).toBe('high');
  });

  test('omits flags whose inputs are absent', () => {
    const args = buildClaudeBgArgs({ prompt: 'p' });
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--agent');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--allowedTools');
  });
});
