# claude-bg Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `claude-bg` community `IAgentProvider` that performs invocation by dispatching and polling `claude --bg` background-agent sessions, so Archon's deterministic DAG engine can run autonomous batch workflows billed against a Claude subscription.

**Architecture:** A new provider directory `packages/providers/src/community/claude-bg/` mirroring `community/pi/`. Pure helpers (`config`, `capabilities`, `invocation`, `state`) are unit-tested in isolation; the `provider` composes them into a dispatch-and-poll async generator with **injectable dependencies** (`run`/`stop`/`readState`/`sleep`) so tests drive it without real subprocesses or timers. Registration is one line added to `registerCommunityProviders()`. The DAG engine, executor, and schemas are unchanged.

**Tech Stack:** Bun + TypeScript, `bun:test`, `@archon/providers` contract types (`IAgentProvider`, `SendQueryOptions`, `NodeConfig`, `MessageChunk`, `ProviderCapabilities`).

**Spec:** `docs/superpowers/specs/2026-05-29-claude-bg-provider-design.md`

---

## Shared type & signature reference (used across tasks — keep consistent)

```ts
// config.ts
export interface ClaudeBgProviderDefaults {
  model?: string;
  claudeBinaryPath?: string;
  defaultAgent?: string;
  pollIntervalMs?: number;
}
export function parseClaudeBgConfig(raw: Record<string, unknown>): ClaudeBgProviderDefaults;

// capabilities.ts
export const CLAUDE_BG_CAPABILITIES: ProviderCapabilities;

// invocation.ts
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
export function buildClaudeBgArgs(input: BuildArgsInput): string[];

// state.ts
export function parseBackgroundedId(stdout: string): string | null;
export type JobStateClass = 'running' | 'completed' | 'failed' | 'stalled' | 'unknown';
export function classifyJobState(raw: unknown): JobStateClass;
export function jobStatePath(id: string): string;            // ~/.claude/jobs/<id>/state.json
export function readJobState(id: string): Promise<unknown | null>;

// provider.ts
export interface ClaudeBgDeps {
  run: (args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;
  stop: (id: string) => Promise<void>;
  readState: (id: string) => Promise<unknown | null>;
  sleep: (ms: number) => Promise<void>;
}
export class ClaudeBgProvider implements IAgentProvider { /* sendQuery, getType, getCapabilities */ }
```

**Failure-handling contract (consistent across the provider):**
- **Launch failure** (no id parsed, or `failed` at the post-dispatch verify step) → **throw** (transient; Archon's per-node retry engages).
- **Mid-run terminal `failed`** → **yield** `{ type:'result', sessionId, isError:true, errorSubtype:'error_during_execution' }` (real failure; executor surfaces it).
- **`stalled`** (needs-input / idle-awaiting-input, no operator) → **throw** with the allowlist-hint message.
- **Abort** → call `stop(id)`, then **throw**.

---

## Task 0: De-risking spike (manual, NO code — gates the rest)

The spec flags worktree re-isolation as the highest risk (§10.1). Verify on the OAuth host **before** writing the provider, because the answer decides whether the provider dispatches with or without `--worktree`.

- [ ] **Step 1: Verify `--bg` does not re-isolate inside an existing worktree**

In a primed repo on the host, create a git worktree manually, then dispatch a trivial `--bg` session with its `cwd` inside that worktree and `worktree.bgIsolation: "none"` set in the repo `.claude/settings.json`:

```bash
git worktree add /tmp/wt-probe HEAD
cd /tmp/wt-probe
claude -n "bg-probe" --bg "run 'pwd' and 'git rev-parse --show-toplevel', then stop"
# capture: backgrounded · <id>
sleep 3 && cat ~/.claude/jobs/<id>/state.json
claude logs <id>
```

Expected: the session's toplevel is `/tmp/wt-probe`, NOT a nested `.../.claude/worktrees/...`. Record the result.

- [ ] **Step 2: Capture the exact `state.json` vocabulary**

Inspect `~/.claude/jobs/<id>/state.json` across the lifecycle (running, completed). Record the literal `.state` values observed (e.g. `running`, `idle`, `busy`, `completed`, `failed`). These feed `classifyJobState` in Task 4.

- [ ] **Step 3: Verify headless resume-with-new-prompt**

```bash
sid=$(claude -n "resume-probe" --bg "remember the number 42" )   # capture id
# after completion:
claude --resume <id> --bg "what number did I ask you to remember?"
```

Expected: the second session continues context. If this form is unsupported, note it — the provider then treats every node as a fresh session (still valid).

- [ ] **Step 4: Record findings + confirm Option A vs B**

Append a `## Spike findings (2026-05-29)` section to the spec file (`docs/superpowers/specs/2026-05-29-claude-bg-provider-design.md`) with the three results, and state which worktree option (A or B) the implementation will use. Commit:

```bash
git add docs/superpowers/specs/2026-05-29-claude-bg-provider-design.md
git commit -m "docs(spec): record claude-bg --bg behavior spike findings"
```

> If Step 1 shows `--bg` insists on its own worktree, switch the plan to Option B (the provider passes `--worktree` and relies on `.worktreeinclude`/`.worktree-setup.yml`). Tasks below assume **Option A** (Archon owns the worktree; provider passes no `--worktree`). The only code delta for Option B is adding `--worktree <name>` in `buildClaudeBgArgs` — noted inline in Task 3.

---

## Task 1: Capabilities declaration

**Files:**
- Create: `packages/providers/src/community/claude-bg/capabilities.ts`
- Test: `packages/providers/src/community/claude-bg/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// capabilities.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/providers/src/community/claude-bg/capabilities.test.ts`
Expected: FAIL — `Cannot find module './capabilities'`.

- [ ] **Step 3: Write the implementation**

```ts
// capabilities.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/providers/src/community/claude-bg/capabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/community/claude-bg/capabilities.ts packages/providers/src/community/claude-bg/capabilities.test.ts
git commit -m "feat(providers/claude-bg): add capability declaration"
```

---

## Task 2: Config parsing

**Files:**
- Create: `packages/providers/src/community/claude-bg/config.ts`
- Test: `packages/providers/src/community/claude-bg/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// config.test.ts
import { describe, expect, test } from 'bun:test';
import { parseClaudeBgConfig } from './config';

describe('parseClaudeBgConfig', () => {
  test('parses valid string + number fields', () => {
    expect(
      parseClaudeBgConfig({
        model: 'opus',
        claudeBinaryPath: '/usr/local/bin/claude',
        defaultAgent: 'story-developer',
        pollIntervalMs: 5000,
      })
    ).toEqual({
      model: 'opus',
      claudeBinaryPath: '/usr/local/bin/claude',
      defaultAgent: 'story-developer',
      pollIntervalMs: 5000,
    });
  });

  test('returns empty object for empty input', () => {
    expect(parseClaudeBgConfig({})).toEqual({});
  });

  test('drops invalid types silently', () => {
    expect(parseClaudeBgConfig({ model: 123, defaultAgent: [], claudeBinaryPath: null })).toEqual({});
  });

  test('drops non-positive / non-integer pollIntervalMs', () => {
    expect(parseClaudeBgConfig({ pollIntervalMs: 0 })).toEqual({});
    expect(parseClaudeBgConfig({ pollIntervalMs: -1 })).toEqual({});
    expect(parseClaudeBgConfig({ pollIntervalMs: 1.5 })).toEqual({});
    expect(parseClaudeBgConfig({ pollIntervalMs: 'fast' })).toEqual({});
  });

  test('ignores unknown keys', () => {
    expect(parseClaudeBgConfig({ futureField: 'x', model: 'opus' })).toEqual({ model: 'opus' });
  });

  test('does not throw on malformed input', () => {
    expect(() => parseClaudeBgConfig({ model: null })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/providers/src/community/claude-bg/config.test.ts`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Write the implementation**

```ts
// config.ts
/**
 * Parse raw YAML-derived config into typed claude-bg defaults.
 * Defensive: invalid fields are dropped silently (matches parsePiConfig /
 * parseClaudeConfig — never throws, so broken user config can't block
 * provider registration or workflow discovery).
 */
export interface ClaudeBgProviderDefaults {
  model?: string;
  /** Path to the `claude` executable; falls back to the claude binary resolver / PATH. */
  claudeBinaryPath?: string;
  /** Default `--agent` to dispatch when a node does not name one. */
  defaultAgent?: string;
  /** Poll cadence for ~/.claude/jobs/<id>/state.json (ms). */
  pollIntervalMs?: number;
}

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/providers/src/community/claude-bg/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/community/claude-bg/config.ts packages/providers/src/community/claude-bg/config.test.ts
git commit -m "feat(providers/claude-bg): add config parsing"
```

---

## Task 3: Invocation builder (options → `claude --bg` args)

**Files:**
- Create: `packages/providers/src/community/claude-bg/invocation.ts`
- Test: `packages/providers/src/community/claude-bg/invocation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// invocation.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/providers/src/community/claude-bg/invocation.test.ts`
Expected: FAIL — `Cannot find module './invocation'`.

- [ ] **Step 3: Write the implementation**

```ts
// invocation.ts
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

  // Option B only (worktree owned by --bg): uncomment if the Task 0 spike
  // showed --bg re-isolates inside an existing worktree.
  // if (input.worktree) args.push('--worktree', input.worktree);

  args.push('--bg');
  args.push(input.prompt);
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/providers/src/community/claude-bg/invocation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/community/claude-bg/invocation.ts packages/providers/src/community/claude-bg/invocation.test.ts
git commit -m "feat(providers/claude-bg): add invocation arg builder"
```

---

## Task 4: Job-state parsing & classification

**Files:**
- Create: `packages/providers/src/community/claude-bg/state.ts`
- Test: `packages/providers/src/community/claude-bg/state.test.ts`

> Use the literal `.state` values recorded in Task 0. The mapping below uses the SDC-observed + agent-view vocabulary; adjust the string sets if the spike found different values.

- [ ] **Step 1: Write the failing test**

```ts
// state.test.ts
import { describe, expect, test } from 'bun:test';
import { parseBackgroundedId, classifyJobState, jobStatePath } from './state';

describe('parseBackgroundedId', () => {
  test('extracts the id from the backgrounded line', () => {
    expect(parseBackgroundedId('backgrounded · 7c5dcf5d · flaky-test-fix\n  claude agents')).toBe('7c5dcf5d');
  });
  test('returns null when no backgrounded line present', () => {
    expect(parseBackgroundedId('some unrelated output')).toBeNull();
  });
});

describe('classifyJobState', () => {
  test('completed → completed', () => {
    expect(classifyJobState({ state: 'completed' })).toBe('completed');
  });
  test('failed → failed', () => {
    expect(classifyJobState({ state: 'failed' })).toBe('failed');
  });
  test('running / busy → running', () => {
    expect(classifyJobState({ state: 'running' })).toBe('running');
    expect(classifyJobState({ state: 'busy' })).toBe('running');
  });
  test('needs_input / idle → stalled (no operator to answer)', () => {
    expect(classifyJobState({ state: 'needs_input' })).toBe('stalled');
    expect(classifyJobState({ state: 'idle' })).toBe('stalled');
  });
  test('null / unknown shape → unknown', () => {
    expect(classifyJobState(null)).toBe('unknown');
    expect(classifyJobState({ state: 'something-new' })).toBe('unknown');
    expect(classifyJobState({})).toBe('unknown');
  });
});

describe('jobStatePath', () => {
  test('builds the per-job state path under the home jobs dir', () => {
    expect(jobStatePath('abc')).toMatch(/\.claude\/jobs\/abc\/state\.json$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/providers/src/community/claude-bg/state.test.ts`
Expected: FAIL — `Cannot find module './state'`.

- [ ] **Step 3: Write the implementation**

```ts
// state.ts
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type JobStateClass = 'running' | 'completed' | 'failed' | 'stalled' | 'unknown';

/** Parse "backgrounded · <id> · <name>" from `claude --bg` stdout. */
export function parseBackgroundedId(stdout: string): string | null {
  const m = stdout.match(/backgrounded\s+·\s+(\S+)/);
  return m ? m[1] : null;
}

const RUNNING = new Set(['running', 'busy', 'working']);
const COMPLETED = new Set(['completed', 'done']);
const FAILED = new Set(['failed', 'error', 'stopped']);
// No operator is present to answer; treat as a stall (almost always an
// uncovered permission prompt — spec §6/§7).
const STALLED = new Set(['needs_input', 'idle']);

/** Map a parsed state.json object to a coarse lifecycle class. */
export function classifyJobState(raw: unknown): JobStateClass {
  if (!raw || typeof raw !== 'object') return 'unknown';
  const state = (raw as { state?: unknown }).state;
  if (typeof state !== 'string') return 'unknown';
  if (COMPLETED.has(state)) return 'completed';
  if (FAILED.has(state)) return 'failed';
  if (RUNNING.has(state)) return 'running';
  if (STALLED.has(state)) return 'stalled';
  return 'unknown';
}

export function jobStatePath(id: string): string {
  return join(homedir(), '.claude', 'jobs', id, 'state.json');
}

/** Read + parse the job state file; returns null if absent or unparseable. */
export async function readJobState(id: string): Promise<unknown | null> {
  try {
    const text = await readFile(jobStatePath(id), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/providers/src/community/claude-bg/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/community/claude-bg/state.ts packages/providers/src/community/claude-bg/state.test.ts
git commit -m "feat(providers/claude-bg): add job state parsing + classification"
```

---

## Task 5: The provider (dispatch-and-poll `sendQuery`)

**Files:**
- Create: `packages/providers/src/community/claude-bg/provider.ts`
- Test: `packages/providers/src/community/claude-bg/provider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// provider.test.ts
import { describe, expect, test } from 'bun:test';
import type { MessageChunk } from '../../types';
import { ClaudeBgProvider, type ClaudeBgDeps } from './provider';

/** Collect all chunks a sendQuery generator yields. */
async function drain(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

/** Build a provider whose state readings follow a scripted sequence. */
function providerWith(
  states: Array<unknown | null>,
  overrides: Partial<ClaudeBgDeps> = {}
): { provider: ClaudeBgProvider; runs: string[][]; stops: string[] } {
  const runs: string[][] = [];
  const stops: string[] = [];
  let i = 0;
  const deps: ClaudeBgDeps = {
    run: async (args) => {
      runs.push(args);
      return { stdout: 'backgrounded · job-1 · node\n', stderr: '' };
    },
    stop: async (id) => {
      stops.push(id);
    },
    readState: async () => (i < states.length ? states[i++] : states[states.length - 1]),
    sleep: async () => {},
    ...overrides,
  };
  return { provider: new ClaudeBgProvider(deps), runs, stops };
}

describe('ClaudeBgProvider.sendQuery', () => {
  test('dispatches, polls to completed, yields a result chunk with the session id', async () => {
    const { provider, runs } = providerWith([{ state: 'running' }, { state: 'completed' }]);
    const chunks = await drain(provider.sendQuery('do it', '/repo'));

    expect(runs[0]).toContain('--bg');
    const result = chunks.find((c) => c.type === 'result');
    expect(result).toBeDefined();
    expect((result as Extract<MessageChunk, { type: 'result' }>).sessionId).toBe('job-1');
    expect((result as Extract<MessageChunk, { type: 'result' }>).isError).toBe(false);
  });

  test('yields heartbeat system chunks while running', async () => {
    const { provider } = providerWith([{ state: 'running' }, { state: 'running' }, { state: 'completed' }]);
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    expect(chunks.filter((c) => c.type === 'system').length).toBeGreaterThanOrEqual(1);
  });

  test('throws when no session id is parsed (launch failure → retryable)', async () => {
    const { provider } = providerWith([{ state: 'completed' }], {
      run: async () => ({ stdout: 'no id here', stderr: '' }),
    });
    await expect(drain(provider.sendQuery('x', '/repo'))).rejects.toThrow(/session id/i);
  });

  test('throws when the post-dispatch verify shows failed (launch failure → retryable)', async () => {
    const { provider } = providerWith([{ state: 'failed' }]);
    await expect(drain(provider.sendQuery('x', '/repo'))).rejects.toThrow();
  });

  test('mid-run failed yields an error result chunk (not a throw)', async () => {
    const { provider } = providerWith([{ state: 'running' }, { state: 'failed' }]);
    const chunks = await drain(provider.sendQuery('x', '/repo'));
    const result = chunks.find((c) => c.type === 'result') as Extract<MessageChunk, { type: 'result' }>;
    expect(result.isError).toBe(true);
  });

  test('stalled state throws with an allowlist hint', async () => {
    const { provider } = providerWith([{ state: 'running' }, { state: 'needs_input' }]);
    await expect(drain(provider.sendQuery('x', '/repo'))).rejects.toThrow(/allowlist/i);
  });

  test('abort signal stops the session and throws', async () => {
    const controller = new AbortController();
    const { provider, stops } = providerWith([{ state: 'running' }, { state: 'running' }], {
      // abort right before the second poll read
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

  test('getType / getCapabilities', () => {
    const { provider } = providerWith([{ state: 'completed' }]);
    expect(provider.getType()).toBe('claude-bg');
    expect(provider.getCapabilities().hooks).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/providers/src/community/claude-bg/provider.test.ts`
Expected: FAIL — `Cannot find module './provider'`.

- [ ] **Step 3: Write the implementation**

```ts
// provider.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { CLAUDE_BG_CAPABILITIES } from './capabilities';
import { parseClaudeBgConfig } from './config';
import { buildClaudeBgArgs } from './invocation';
import { classifyJobState, parseBackgroundedId, readJobState } from './state';

const execFileAsync = promisify(execFile);

const DEFAULT_POLL_INTERVAL_MS = 4000;
const VERIFY_DELAY_MS = 2000;

/**
 * Injectable side-effecting dependencies. Production uses the real
 * implementations below; tests pass scripted fakes (no subprocess, no timers).
 */
export interface ClaudeBgDeps {
  run: (args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<{
    stdout: string;
    stderr: string;
  }>;
  stop: (id: string) => Promise<void>;
  readState: (id: string) => Promise<unknown | null>;
  sleep: (ms: number) => Promise<void>;
}

function defaultDeps(binary: string): ClaudeBgDeps {
  return {
    run: async (args, opts) => {
      const { stdout, stderr } = await execFileAsync(binary, args, {
        cwd: opts.cwd,
        env: opts.env,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout: stdout.toString(), stderr: stderr.toString() };
    },
    stop: async (id) => {
      await execFileAsync(binary, ['stop', id]).catch(() => undefined);
    },
    readState: (id) => readJobState(id),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * claude-bg provider: invokes Claude by dispatching a `claude --bg` background
 * session and polling ~/.claude/jobs/<id>/state.json to completion. Subscription-
 * billed (the SDK / `claude -p` move to the capped Agent SDK credit pool on
 * 2026-06-15; `--bg` stays on interactive billing). Batch only — no live
 * structured streaming; observe via `claude attach` / `claude agents`.
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

    // Resolve the named agent (node-level wins over config default).
    const agentNames = nodeConfig?.agents ? Object.keys(nodeConfig.agents) : [];
    const agent = agentNames[0] ?? defaults.defaultAgent;

    const systemPrompt =
      typeof options?.systemPrompt === 'string' ? options.systemPrompt : undefined;

    const args = buildClaudeBgArgs({
      prompt,
      nodeId: nodeConfig?.nodeId,
      model: options?.model ?? defaults.model,
      resumeSessionId,
      agent,
      systemPrompt,
      allowedTools: nodeConfig?.allowed_tools,
      deniedTools: nodeConfig?.denied_tools,
      mcpConfigPath: typeof nodeConfig?.mcp === 'string' ? nodeConfig.mcp : undefined,
      effort: nodeConfig?.effort,
    });

    // NOTE: never inject ANTHROPIC_API_KEY — it disables --bg (spec §7).
    const env = options?.env ? { ...process.env, ...options.env } : process.env;

    // 1. Dispatch
    const { stdout } = await deps.run(args, { cwd, env });
    const id = parseBackgroundedId(stdout);
    if (!id) {
      throw new Error(`claude --bg did not return a session id. stdout: ${stdout.slice(0, 200)}`);
    }

    // 2. Verify launch survived the precheck (spec §5.1 step 3)
    await deps.sleep(VERIFY_DELAY_MS);
    if (classifyJobState(await deps.readState(id)) === 'failed') {
      throw new Error(`claude --bg session ${id} failed during launch (retryable)`);
    }

    // 3. Poll to a terminal state
    for (;;) {
      if (options?.abortSignal?.aborted) {
        await deps.stop(id);
        throw new Error(`claude --bg session ${id} aborted`);
      }
      const klass = classifyJobState(await deps.readState(id));
      if (klass === 'completed') {
        yield { type: 'result', sessionId: id, isError: false };
        return;
      }
      if (klass === 'failed') {
        yield {
          type: 'result',
          sessionId: id,
          isError: true,
          errorSubtype: 'error_during_execution',
        };
        return;
      }
      if (klass === 'stalled') {
        throw new Error(
          `claude --bg session ${id} is blocked awaiting input with no operator — ` +
            `broaden the repo .claude/settings.json allowlist (spec §6/§7)`
        );
      }
      // running / unknown → heartbeat (keeps the executor's idle timer alive) + wait
      yield { type: 'system', content: '' };
      await deps.sleep(pollIntervalMs);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/providers/src/community/claude-bg/provider.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/community/claude-bg/provider.ts packages/providers/src/community/claude-bg/provider.test.ts
git commit -m "feat(providers/claude-bg): add dispatch-and-poll provider"
```

---

## Task 6: Registration + wiring

**Files:**
- Create: `packages/providers/src/community/claude-bg/registration.ts`
- Create: `packages/providers/src/community/claude-bg/index.ts`
- Modify: `packages/providers/src/registry.ts` (import + call in `registerCommunityProviders`, around `registry.ts:156-160`)
- Modify: `packages/providers/package.json` (append the new test files to the `test` script)
- Test: `packages/providers/src/community/claude-bg/registration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// registration.test.ts
import { afterEach, describe, expect, test } from 'bun:test';
import { clearRegistry, getRegistration, isRegisteredProvider } from '../../registry';
import { registerClaudeBgProvider } from './registration';

afterEach(() => clearRegistry());

describe('registerClaudeBgProvider', () => {
  test('registers claude-bg as a non-builtin provider', () => {
    registerClaudeBgProvider();
    expect(isRegisteredProvider('claude-bg')).toBe(true);
    const reg = getRegistration('claude-bg');
    expect(reg.builtIn).toBe(false);
    expect(reg.displayName).toMatch(/community/i);
    expect(reg.capabilities.hooks).toBe(false);
    expect(reg.factory().getType()).toBe('claude-bg');
  });

  test('is idempotent', () => {
    registerClaudeBgProvider();
    expect(() => registerClaudeBgProvider()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/providers/src/community/claude-bg/registration.test.ts`
Expected: FAIL — `Cannot find module './registration'`.

- [ ] **Step 3: Write registration.ts and index.ts**

```ts
// registration.ts
import { isRegisteredProvider, registerProvider } from '../../registry';

import { CLAUDE_BG_CAPABILITIES } from './capabilities';
import { ClaudeBgProvider } from './provider';

/**
 * Register the claude-bg community provider. Idempotent — safe to call from
 * every process entrypoint. builtIn:false (community seam, like Pi/Copilot).
 */
export function registerClaudeBgProvider(): void {
  if (isRegisteredProvider('claude-bg')) return;
  registerProvider({
    id: 'claude-bg',
    displayName: 'Claude (background, community)',
    factory: () => new ClaudeBgProvider(),
    capabilities: CLAUDE_BG_CAPABILITIES,
    builtIn: false,
  });
}
```

```ts
// index.ts
export { CLAUDE_BG_CAPABILITIES } from './capabilities';
export { parseClaudeBgConfig, type ClaudeBgProviderDefaults } from './config';
export { ClaudeBgProvider, type ClaudeBgDeps } from './provider';
export { registerClaudeBgProvider } from './registration';
```

- [ ] **Step 4: Wire into `registerCommunityProviders()`**

In `packages/providers/src/registry.ts`, add the import alongside the other community registration imports (near `registry.ts:20-22`):

```ts
import { registerClaudeBgProvider } from './community/claude-bg/registration';
```

And add the call inside `registerCommunityProviders()` (the body currently at `registry.ts:156-160`):

```ts
export function registerCommunityProviders(): void {
  registerOpencodeProvider();
  registerPiProvider();
  registerCopilotProvider();
  registerClaudeBgProvider();
}
```

- [ ] **Step 5: Add the new test files to the package test script**

In `packages/providers/package.json`, append to the end of the `"test"` script string (each as its own isolated `bun test` invocation, per CLAUDE.md mock-isolation rules):

```
 && bun test src/community/claude-bg/capabilities.test.ts && bun test src/community/claude-bg/config.test.ts && bun test src/community/claude-bg/invocation.test.ts && bun test src/community/claude-bg/state.test.ts && bun test src/community/claude-bg/provider.test.ts && bun test src/community/claude-bg/registration.test.ts
```

- [ ] **Step 6: Run the registration test + the full providers suite**

Run: `bun test packages/providers/src/community/claude-bg/registration.test.ts`
Expected: PASS.

Run: `bun --filter @archon/providers test`
Expected: PASS (all provider tests, including the new claude-bg files).

- [ ] **Step 7: Commit**

```bash
git add packages/providers/src/community/claude-bg/registration.ts packages/providers/src/community/claude-bg/index.ts packages/providers/src/community/claude-bg/registration.test.ts packages/providers/src/registry.ts packages/providers/package.json
git commit -m "feat(providers/claude-bg): register provider + wire test suite"
```

---

## Task 7: Validation gate

**Files:** none (verification only)

- [ ] **Step 1: Type-check, lint, format, tests**

Run: `bun run validate`
Expected: PASS — `check:bundled`, `check:bundled-skill`, type-check, lint, format check, and tests all green.

> If lint flags an unused `betas`/`thinking`/`sandbox` (intentionally not mapped — declared unsupported), confirm they're simply never read (no eslint-disable needed since we never reference them).

- [ ] **Step 2: Commit any formatting fixups**

```bash
git add -A
git commit -m "chore(providers/claude-bg): satisfy validate (format/lint)" || echo "nothing to commit"
```

---

## Task 8: Live integration test (manual, on the OAuth host — gated)

**Files:**
- Create: `.archon/workflows/bg-smoke.yaml` (in a primed test repo, NOT committed to Archon)

- [ ] **Step 1: Author a one-node smoke workflow**

```yaml
# bg-smoke.yaml
name: bg-smoke
provider: claude-bg
nodes:
  - id: hello
    prompt: "Write the text 'claude-bg works' to a file named bg-proof.txt in the repo root, commit nothing, then stop."
```

- [ ] **Step 2: Run it via the CLI in the primed repo**

```bash
cd /path/to/primed-test-repo
bun run cli workflow run bg-smoke --no-worktree "go"   # or with isolation per the Option A decision
```

Expected: the workflow reaches a terminal state; `bg-proof.txt` exists; `claude agents` shows the session named `hello`.

- [ ] **Step 3: Confirm the capability-warning path**

Add `skills: [foo]` to the node, re-run, and confirm the dag-executor emits a capability warning (claude-bg declares `skills:false`) rather than crashing.

- [ ] **Step 4: Record results in the spec**

Append outcomes to the spec's spike-findings section and commit (spec repo).

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §4 architecture (provider behind registry seam) → Tasks 5, 6.
- §5 internals (lifecycle, arg mapping, MessageChunk emission, cancellation, idle heartbeat) → Tasks 3, 4, 5.
- §6 worktree model → Task 0 spike decides A/B; Task 3 carries the Option-B delta inline.
- §7 permission/auth (no API key, no permission-mode flag) + capability table → Tasks 1, 3, 5.
- §9 reuse/LOE → all tasks are within the provider dir + 2 one-line wiring edits.
- §10 verification items → Task 0 (worktree, resume, state vocabulary), Task 8 (live, capability warning).
- §11 testing → Tasks 1–6 (unit), Task 7 (validate), Task 8 (integration).

**Placeholder scan:** no TBD/TODO; every code step has complete code.

**Type consistency:** `ClaudeBgProviderDefaults`, `BuildArgsInput`, `JobStateClass`, `ClaudeBgDeps`, and `ClaudeBgProvider` signatures match across the shared reference and Tasks 2–6. `classifyJobState`/`parseBackgroundedId`/`readJobState` names consistent between state.ts (Task 4) and provider.ts (Task 5). Registration id `claude-bg` consistent across Tasks 5, 6.

**Open dependency:** Task 4's state-string sets must match Task 0's observed vocabulary — called out inline.
