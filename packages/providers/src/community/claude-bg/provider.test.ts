import { describe, expect, test } from 'bun:test';
import type { MessageChunk } from '../../types';
import { ClaudeBgProvider, type ClaudeBgDeps } from './provider';

async function drain(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

function providerWith(
  states: Array<unknown | null>,
  overrides: Partial<ClaudeBgDeps> = {}
): {
  provider: ClaudeBgProvider;
  runs: string[][];
  stops: string[];
  envs: Array<NodeJS.ProcessEnv | undefined>;
} {
  const runs: string[][] = [];
  const stops: string[] = [];
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  let i = 0;
  const deps: ClaudeBgDeps = {
    run: async (args, opts) => {
      runs.push(args);
      envs.push(opts.env);
      return { stdout: 'backgrounded · job-1 · node\n', stderr: '' };
    },
    stop: async id => {
      stops.push(id);
    },
    readState: async () => (i < states.length ? states[i++] : states[states.length - 1]),
    sleep: async () => {},
    ...overrides,
  };
  return { provider: new ClaudeBgProvider(deps), runs, stops, envs };
}

describe('ClaudeBgProvider.sendQuery', () => {
  test('dispatches, polls to completed, yields a result chunk with the session id', async () => {
    const { provider, runs } = providerWith([{ state: 'running' }, { state: 'completed' }]);
    const chunks = await drain(provider.sendQuery('do it', '/repo'));
    expect(runs[0]).toContain('--bg');
    const result = chunks.find(c => c.type === 'result');
    expect(result).toBeDefined();
    expect((result as Extract<MessageChunk, { type: 'result' }>).sessionId).toBe('job-1');
    expect((result as Extract<MessageChunk, { type: 'result' }>).isError).toBe(false);
  });

  test('yields heartbeat system chunks while running', async () => {
    const { provider } = providerWith([
      { state: 'running' },
      { state: 'running' },
      { state: 'completed' },
    ]);
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    expect(chunks.filter(c => c.type === 'system').length).toBeGreaterThanOrEqual(1);
  });

  test('throws when no session id is parsed (launch failure)', async () => {
    const { provider } = providerWith([{ state: 'completed' }], {
      run: async () => ({ stdout: 'no id here', stderr: '' }),
    });
    await expect(drain(provider.sendQuery('x', '/repo'))).rejects.toThrow(/session id/i);
  });

  test('throws when the post-dispatch verify shows failed (launch failure)', async () => {
    const { provider } = providerWith([{ state: 'failed' }]);
    await expect(drain(provider.sendQuery('x', '/repo'))).rejects.toThrow();
  });

  test('mid-run failed yields an error result chunk (not a throw)', async () => {
    const { provider } = providerWith([{ state: 'running' }, { state: 'failed' }]);
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    const result = chunks.find(c => c.type === 'result') as Extract<
      MessageChunk,
      { type: 'result' }
    >;
    expect(result.isError).toBe(true);
  });

  test('stalled state throws with an allowlist hint', async () => {
    const { provider } = providerWith([{ state: 'running' }, { state: 'needs_input' }]);
    await expect(drain(provider.sendQuery('x', '/repo'))).rejects.toThrow(/allowlist/i);
  });

  test('abort signal stops the session and throws', async () => {
    const controller = new AbortController();
    const { provider, stops } = providerWith([{ state: 'running' }, { state: 'running' }], {
      readState: async () => {
        controller.abort();
        return { state: 'running' };
      },
    });
    await expect(
      drain(provider.sendQuery('x', '/repo', undefined, { abortSignal: controller.signal }))
    ).rejects.toThrow(/abort/i);
    expect(stops).toContain('job-1');
  });

  test('strips API-key env vars from the dispatch env (would disable --bg)', async () => {
    const { provider, envs } = providerWith([{ state: 'completed' }]);
    await drain(
      provider.sendQuery('x', '/repo', undefined, {
        env: { ANTHROPIC_API_KEY: 'sk-test', FOO: 'bar' },
      })
    );
    const env = envs[0];
    expect(env).toBeDefined();
    expect(env?.FOO).toBe('bar');
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test('strips ANTHROPIC_AUTH_TOKEN from the dispatch env (would disable --bg)', async () => {
    const { provider, envs } = providerWith([{ state: 'completed' }]);
    await drain(
      provider.sendQuery('x', '/repo', undefined, {
        env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-test', BAR: 'baz' },
      })
    );
    const env = envs[0];
    expect(env).toBeDefined();
    expect(env?.BAR).toBe('baz');
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test('uses nodeConfig.bgAgent as the --agent flag', async () => {
    const { provider, runs } = providerWith([{ state: 'completed' }]);
    await drain(
      provider.sendQuery('x', '/repo', undefined, {
        nodeConfig: { nodeId: 'n', bgAgent: 'story-reviewer' },
      })
    );
    const idx = runs[0].indexOf('--agent');
    expect(idx).not.toBe(-1);
    expect(runs[0][idx + 1]).toBe('story-reviewer');
  });

  test('inline agents on nodeConfig does NOT produce --agent (agents:false)', async () => {
    const { provider, runs } = providerWith([{ state: 'completed' }]);
    await drain(
      provider.sendQuery('x', '/repo', undefined, {
        nodeConfig: {
          nodeId: 'n',
          agents: { foo: { description: 'a foo agent', prompt: 'do foo' } },
        },
      })
    );
    expect(runs[0]).not.toContain('--agent');
  });

  test('throws when the session never spawns (no state file after retry)', async () => {
    const { provider } = providerWith([null, null]);
    await expect(drain(provider.sendQuery('x', '/repo'))).rejects.toThrow(/never spawned/i);
  });

  test('getType / getCapabilities', () => {
    const { provider } = providerWith([{ state: 'completed' }]);
    expect(provider.getType()).toBe('claude-bg');
    expect(provider.getCapabilities().hooks).toBe(false);
  });
});
