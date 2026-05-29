import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { CLAUDE_BG_CAPABILITIES } from './capabilities';
import { parseClaudeBgConfig } from './config';
import { buildClaudeBgArgs } from './invocation';
import {
  classifyJobState,
  classifySessionStatus,
  findSessionId,
  findSessionStatus,
  hasSessionId,
  parseBackgroundedId,
  readJobState,
} from './state';

const execFileAsync = promisify(execFile);

const DEFAULT_POLL_INTERVAL_MS = 4000;
const VERIFY_DELAY_MS = 2000;
const BG_BLOCKED_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const MAX_LOG_OUTPUT_CHARS = 100_000;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude-bg');
  return cachedLog;
}

/**
 * Injectable side-effecting dependencies. Production uses the real
 * implementations below; tests pass scripted fakes (no subprocess, no timers).
 */
export interface ClaudeBgDeps {
  run: (
    args: string[],
    opts: { cwd: string; env?: NodeJS.ProcessEnv }
  ) => Promise<{
    stdout: string;
    stderr: string;
  }>;
  stop: (id: string) => Promise<void>;
  readState: (id: string) => Promise<unknown>;
  /** Return the parsed `claude agents --json` array (or null/[] on error). */
  listSessions: () => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  /** Scrape `claude logs <id>`; returns '' on any error, never throws. */
  readLogs: (id: string) => Promise<string>;
}

function defaultDeps(binary: string): ClaudeBgDeps {
  return {
    run: async (args, opts): Promise<{ stdout: string; stderr: string }> => {
      const { stdout, stderr } = await execFileAsync(binary, args, {
        cwd: opts.cwd,
        env: opts.env,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout, stderr };
    },
    stop: async (id): Promise<void> => {
      await execFileAsync(binary, ['stop', id]).catch(() => undefined);
    },
    readState: id => readJobState(id),
    listSessions: async (): Promise<unknown> => {
      try {
        const { stdout } = await execFileAsync(binary, ['agents', '--json'], {
          maxBuffer: 10 * 1024 * 1024,
        });
        return JSON.parse(stdout);
      } catch {
        return null;
      }
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    readLogs: async (id): Promise<string> => {
      try {
        const { stdout } = await execFileAsync(binary, ['logs', id], {
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
      } catch {
        return '';
      }
    },
  };
}

/**
 * claude-bg provider: invokes Claude by dispatching a `claude --bg` background
 * session and polling ~/.claude/jobs/<id>/state.json to completion.
 * Subscription-billed (SDK / `claude -p` move to the capped Agent SDK credit
 * pool on 2026-06-15; `--bg` stays on interactive billing). Batch only — no
 * live structured streaming; observe via `claude attach` / `claude agents`.
 */
export class ClaudeBgProvider implements IAgentProvider {
  private readonly injectedDeps?: ClaudeBgDeps;

  constructor(deps?: ClaudeBgDeps) {
    this.injectedDeps = deps;
  }

  getType(): string {
    return 'claude-bg';
  }

  getCapabilities(): ProviderCapabilities {
    return CLAUDE_BG_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const defaults = parseClaudeBgConfig(options?.assistantConfig ?? {});
    const nodeConfig = options?.nodeConfig;
    const binary = defaults.claudeBinaryPath ?? 'claude';
    const pollIntervalMs = defaults.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deps = this.injectedDeps ?? defaultDeps(binary);

    // Per-node named agent (bgAgent) wins; else the config-level default. Inline
    // `agents` definitions are NOT consumed here — capabilities declares agents:false.
    const agent = nodeConfig?.bgAgent ?? defaults.defaultAgent;

    const systemPrompt =
      typeof options?.systemPrompt === 'string' ? options.systemPrompt : undefined;

    // Resume guard: only pass a resumeSessionId to --resume if the full UUID is
    // currently listed in `claude agents --json`. A stale/unlisted id would drop
    // `--resume` into an interactive picker that hangs a headless session.
    let effectiveResumeId: string | undefined;
    if (resumeSessionId) {
      const resumeRows = await deps.listSessions();
      if (hasSessionId(resumeRows, resumeSessionId)) {
        effectiveResumeId = resumeSessionId;
      } else {
        getLog().warn({ resumeSessionId }, 'provider.claude-bg.resume_target_missing');
      }
    }

    const args = buildClaudeBgArgs({
      prompt,
      nodeId: nodeConfig?.nodeId,
      model: options?.model ?? defaults.model,
      resumeSessionId: effectiveResumeId,
      agent,
      systemPrompt,
      allowedTools: nodeConfig?.allowed_tools,
      deniedTools: nodeConfig?.denied_tools,
      mcpConfigPath: typeof nodeConfig?.mcp === 'string' ? nodeConfig.mcp : undefined,
      effort: nodeConfig?.effort,
    });

    // Strip API-key vars from the dispatch env — any of them disables --bg (spec §7).
    // Applied even to inherited process.env, since the host may have one set.
    const mergedEnv = options?.env ? { ...process.env, ...options.env } : { ...process.env };
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(mergedEnv).filter(([k]) => !BG_BLOCKED_ENV_KEYS.has(k))
    );

    // 1. Dispatch
    const { stdout } = await deps.run(args, { cwd, env });
    const id = parseBackgroundedId(stdout);
    if (!id) {
      throw new Error(`claude --bg did not return a session id. stdout: ${stdout.slice(0, 200)}`);
    }
    getLog().info({ id, cwd }, 'provider.claude-bg.dispatch_started');

    // 2. Verify launch survived the precheck. The "backgrounded · <id>" line is
    // printed before the precheck runs; a precheck failure leaves no state file.
    await deps.sleep(VERIFY_DELAY_MS);
    let verifyState = await deps.readState(id);
    if (verifyState === null) {
      await deps.sleep(VERIFY_DELAY_MS);
      verifyState = await deps.readState(id);
      if (verifyState === null) {
        getLog().error({ id }, 'provider.claude-bg.never_spawned');
        throw new Error(`claude --bg session ${id} never spawned (no state file written)`);
      }
    }
    if (classifyJobState(verifyState) === 'failed') {
      getLog().error({ id }, 'provider.claude-bg.verify_failed');
      throw new Error(`claude --bg session ${id} failed during launch (retryable)`);
    }

    // 3. Poll to a terminal state (hybrid: check session status FIRST, then .state)
    for (;;) {
      // 3a. Abort check — always first
      if (options?.abortSignal?.aborted) {
        getLog().warn({ id }, 'provider.claude-bg.aborted');
        await deps.stop(id);
        throw new Error(`claude --bg session ${id} aborted`);
      }

      // 3b. Session status from `claude agents --json` — stall detection
      const sessionStatus = classifySessionStatus(findSessionStatus(await deps.listSessions(), id));
      if (sessionStatus === 'waiting') {
        getLog().error({ id }, 'provider.claude-bg.stalled');
        throw new Error(
          `claude --bg session ${id} is blocked awaiting input with no operator — ` +
            'broaden the repo .claude/settings.json allowlist (spec §6/§7)'
        );
      }

      // 3c. Job state from ~/.claude/jobs/<id>/state.json — terminal detection
      const klass = classifyJobState(await deps.readState(id));
      if (klass === 'completed') {
        getLog().info({ id }, 'provider.claude-bg.completed');
        // Resolve the full UUID from agents --json so the caller can resume
        // with --resume <full-uuid> rather than the short id printed by --bg.
        const fullId = findSessionId(await deps.listSessions(), id) ?? id;
        // claude-bg streams no assistant text inline; surface the session's final
        // output by scraping `claude logs`, so the node has non-empty output (the
        // executor fails empty-output nodes) and $nodeId.output works. Marker
        // fallback guarantees non-empty even if logs are empty/unavailable.
        const rawLogs = (await deps.readLogs(id)).trim();
        const output =
          rawLogs.length > 0
            ? rawLogs.slice(0, MAX_LOG_OUTPUT_CHARS)
            : `claude-bg session ${fullId} completed (output produced out-of-band — see artifacts or 'claude logs ${id}').`;
        yield { type: 'assistant', content: output };
        yield { type: 'result', sessionId: fullId, isError: false };
        return;
      }
      if (klass === 'failed') {
        getLog().error({ id }, 'provider.claude-bg.failed');
        const fullId = findSessionId(await deps.listSessions(), id) ?? id;
        yield {
          type: 'result',
          sessionId: fullId,
          isError: true,
          errorSubtype: 'error_during_execution',
        };
        return;
      }
      // klass === 'stalled' from .state (needs_input/idle in state.json) is also a stall;
      // the agents --json check above is the primary signal, but keep this as a fallback.
      if (klass === 'stalled') {
        getLog().error({ id }, 'provider.claude-bg.stalled');
        throw new Error(
          `claude --bg session ${id} is blocked awaiting input with no operator — ` +
            'broaden the repo .claude/settings.json allowlist (spec §6/§7)'
        );
      }

      // Still running (running / unknown / other) — emit heartbeat and wait
      yield { type: 'system', content: '' };
      await deps.sleep(pollIntervalMs);
    }
  }
}
