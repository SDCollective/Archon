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
      return { stdout: 'backgrounded · job1 · node\n', stderr: '' };
    },
    stop: async id => {
      stops.push(id);
    },
    readState: async () => (i < states.length ? states[i++] : states[states.length - 1]),
    // Default: empty list → no status, no waiting, full-UUID falls back to short id
    listSessions: async () => [],
    // Yield to the macrotask queue (not a no-op): if a poll loop ever fails to
    // terminate, this lets bun's per-test timeout fire instead of starving the
    // event loop into a tight microtask spin (which OOMs rather than timing out).
    sleep: async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    readLogs: async () => '',
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
    expect((result as Extract<MessageChunk, { type: 'result' }>).sessionId).toBe('job1');
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
    expect(stops).toContain('job1');
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

  // ---------------------------------------------------------------------------
  // Hybrid poll: session status from `claude agents --json`
  // ---------------------------------------------------------------------------

  test('listSessions waiting row → rejects with allowlist hint (does not hang)', async () => {
    // .state stays 'running' — this verifies the stall is caught via agents --json,
    // not via the .state path, and that the generator rejects rather than looping.
    // The dispatched short id is 'job1'; the row's sessionId must start with 'job1'.
    const { provider } = providerWith([{ state: 'running' }, { state: 'running' }], {
      listSessions: async () => [{ sessionId: 'job1-x-y-z', status: 'waiting' }],
    });
    await expect(drain(provider.sendQuery('x', '/repo'))).rejects.toThrow(/allowlist/i);
  });

  test('listSessions busy row with .state running then done → completes normally', async () => {
    const { provider } = providerWith([{ state: 'running' }, { state: 'done' }], {
      listSessions: async () => [{ sessionId: 'job1-x-y-z', status: 'busy' }],
    });
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    const result = chunks.find(c => c.type === 'result') as Extract<
      MessageChunk,
      { type: 'result' }
    >;
    expect(result).toBeDefined();
    expect(result.isError).toBe(false);
  });

  test('listSessions null (agents unavailable) falls through to .state terminal detection', async () => {
    // null means `claude agents --json` failed or the session isn't listed yet;
    // the provider must not treat this as a stall — it falls through to .state.
    const { provider } = providerWith([{ state: 'running' }, { state: 'completed' }], {
      listSessions: async () => null,
    });
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    const result = chunks.find(c => c.type === 'result') as Extract<
      MessageChunk,
      { type: 'result' }
    >;
    expect(result.isError).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Full-UUID capture: result chunk carries full sessionId from agents --json
  // ---------------------------------------------------------------------------

  test('result chunk carries the full UUID resolved from agents --json (not the short id)', async () => {
    const fullUuid = 'job1-4729-4b02-a7af';
    const { provider } = providerWith([{ state: 'running' }, { state: 'done' }], {
      listSessions: async () => [{ sessionId: fullUuid, status: 'idle' }],
    });
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    const result = chunks.find(c => c.type === 'result') as Extract<
      MessageChunk,
      { type: 'result' }
    >;
    expect(result).toBeDefined();
    expect(result.sessionId).toBe(fullUuid);
  });

  test('result chunk falls back to short id when full UUID is not in agents --json', async () => {
    const { provider } = providerWith([{ state: 'completed' }], {
      listSessions: async () => [],
    });
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    const result = chunks.find(c => c.type === 'result') as Extract<
      MessageChunk,
      { type: 'result' }
    >;
    expect(result).toBeDefined();
    // Falls back to the short id parsed from stdout ('job1')
    expect(result.sessionId).toBe('job1');
  });

  // ---------------------------------------------------------------------------
  // Resume guard: --resume only passed when the full UUID is listed
  // ---------------------------------------------------------------------------

  test('resume guard: --resume is omitted when the full UUID is not in agents --json', async () => {
    const { provider, runs } = providerWith([{ state: 'completed' }], {
      listSessions: async () => [],
    });
    await drain(provider.sendQuery('p', '/repo', 'some-stale-full-uuid'));
    expect(runs[0]).not.toContain('--resume');
  });

  test('resume guard: --resume is passed when the full UUID is listed in agents --json', async () => {
    const { provider, runs } = providerWith([{ state: 'completed' }], {
      listSessions: async () => [{ sessionId: 'some-stale-full-uuid', status: 'idle' }],
    });
    await drain(provider.sendQuery('p', '/repo', 'some-stale-full-uuid'));
    const idx = runs[0].indexOf('--resume');
    expect(idx).not.toBe(-1);
    expect(runs[0][idx + 1]).toBe('some-stale-full-uuid');
  });

  // ---------------------------------------------------------------------------
  // Log scraping: assistant chunk emitted before result on completion
  // ---------------------------------------------------------------------------

  test('logs scraped into output: assistant chunk contains log text and precedes result', async () => {
    const { provider } = providerWith([{ state: 'running' }, { state: 'completed' }], {
      readLogs: async () => 'agent did the work\n',
    });
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    const assistantIdx = chunks.findIndex(c => c.type === 'assistant');
    const resultIdx = chunks.findIndex(c => c.type === 'result');
    expect(assistantIdx).not.toBe(-1);
    const assistantChunk = chunks[assistantIdx] as Extract<MessageChunk, { type: 'assistant' }>;
    expect(assistantChunk.content).toContain('agent did the work');
    // assistant must be emitted before the result
    expect(assistantIdx).toBeLessThan(resultIdx);
  });

  test('marker fallback on empty logs: assistant chunk contains "completed" and session id', async () => {
    const { provider } = providerWith([{ state: 'completed' }], {
      readLogs: async () => '',
    });
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    const assistantChunk = chunks.find(c => c.type === 'assistant') as Extract<
      MessageChunk,
      { type: 'assistant' }
    >;
    expect(assistantChunk).toBeDefined();
    expect(assistantChunk.content).toContain('completed');
    // The short id 'job1' (parsed from the stdout stub) appears in the marker
    expect(assistantChunk.content).toContain('job1');
  });

  test('truncation: assistant content is capped at 100k chars when logs are longer', async () => {
    const bigLog = 'x'.repeat(200_000);
    const { provider } = providerWith([{ state: 'completed' }], {
      readLogs: async () => bigLog,
    });
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    const assistantChunk = chunks.find(c => c.type === 'assistant') as Extract<
      MessageChunk,
      { type: 'assistant' }
    >;
    expect(assistantChunk).toBeDefined();
    expect(assistantChunk.content.length).toBeLessThanOrEqual(100_000);
  });
});
