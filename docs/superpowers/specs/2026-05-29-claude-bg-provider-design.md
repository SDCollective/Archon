# Design: `claude-bg` provider — a subscription-billed invocation substrate for Archon

- **Date:** 2026-05-29
- **Status:** Draft for review
- **Author:** Mark (with Claude)
- **Topic:** Add a `claude --bg` (background-agent) provider to Archon so its deterministic DAG engine can run autonomous batch workflows billed against a Claude *subscription* instead of the post-June-15-2026 Agent SDK credit pool.

---

## 1. Problem & Goal

As of **June 15, 2026**, programmatic Claude usage on subscription plans — the `@anthropic-ai/claude-agent-sdk` **and** `claude -p` — draws from a new, capped, non-rollover monthly "Agent SDK credit" pool (Pro $20 / Max 5x $100 / Max 20x $200). Archon's `ClaudeProvider` invokes Claude exclusively through that SDK (`packages/providers/src/claude/provider.ts:933`, `query({ prompt, options })`), so sustained autonomous workflow execution becomes cost-prohibitive for an org that cannot yet move to API billing tiers.

**`claude --bg` (background agents / "agent view") is the exception:** Anthropic's agent-view docs state background sessions "consume your subscription usage the same as interactive sessions," and `--bg` is absent from the official list of surfaces moving to the capped credit pool. It is billed on the **interactive** side of the line.

**Goal:** Keep Archon's deterministic harness (its DAG engine and everything built on it) exactly as-is, and add a new `IAgentProvider` — `claude-bg` — that performs invocation by dispatching and polling `claude --bg` sessions. Workflows opt in with `provider: claude-bg` and become subscription-billed.

This is the chosen approach (**Approach A**) from a feasibility investigation recorded at `.claude/archon/research/2026-05-28-sdk-vs-cli-cost-feasibility.md`. The driving constraint is **cost only** — Archon's workflow model, determinism, and ownership are all acceptable as-is.

---

## 2. Confirmed requirements (from brainstorming)

- **Sole driver:** cost/billing. Not workflow-fit, ownership, or determinism gaps.
- **Execution model:** autonomous **batch only**. No live token-streaming to a UI is required. Humans observe a running session on demand via `claude attach` or the `claude agents` interface.
- **Deployment/auth:** a persistent host where Claude Code is interactively **OAuth-logged-in** (subscription/keychain), with the supervisor daemon running — the same kind of host the SDC pipeline already uses.
- **Node communication:** **orchestration-only** is the foundation — nodes pass information by dumping/reading **artifacts** (files), and the harness controls order/dependencies/gates. Archon-style `$nodeId.output` data-flow is a **nice-to-have**, acceptable to drop if it costs consistency.

---

## 3. Non-goals (YAGNI)

- No from-scratch DAG engine. We reuse Archon's.
- No changes to the chat/orchestrator streaming path. `claude-bg` serves workflow execution; interactive chat (low volume) can stay on the SDK `claude` provider and live inside the capped credit pool.
- No real-time structured streaming, tool-call telemetry, or per-run cost accounting from `--bg`. Observability is via `claude attach` / `claude agents`.
- No support for `--bg`-incompatible features on this provider (inline skills/agents, hooks, structured-output schema enforcement, `maxBudgetUsd`). These are declared unsupported (§7) so the engine warns rather than failing silently.
- No multi-host / distributed dispatch. Sessions are local to the supervisor daemon on the single OAuth host.

---

## 4. Architecture

Archon is unchanged except for one new community provider plugged into the registry seam designed for exactly this.

```
   .archon/workflows/*.yaml          ← deterministic DAG workflows (provider: claude-bg)
            │
   Archon DAG engine (UNCHANGED)     ← depends_on, trigger_rule, when:, approval gates,
   executor.ts / dag-executor.ts        retries, resume, $ARTIFACTS_DIR, $nodeId.output
            │
   IAgentProvider.sendQuery()        ← the swap seam (registry boundary, types.ts:384)
            │
   ┌────────┴───────────┐
   │  claude-bg provider │   ← NEW: packages/providers/src/community/claude-bg/
   │  (dispatch + poll)  │      builtIn: false, registered in registerCommunityProviders()
   └────────┬───────────┘
            │ cd <cwd> && claude --agent X -n "<node>" --bg "<prompt>"
            │ capture "backgrounded · <id>" → poll ~/.claude/jobs/<id>/state.json
            │ terminal state → done
   Background agent (OAuth/subscription-billed, runs in a worktree)
            │ communicates out-of-band
   git commits / artifacts in $ARTIFACTS_DIR / PRs / Monday
```

The contract boundary `IAgentProvider` (`packages/providers/src/types.ts:376-401`) is the only integration point. The DAG executor calls `deps.getAgentProvider(provider).sendQuery(...)` (`dag-executor.ts:695,723`); it does not care whether the provider streams from an SDK subprocess or polls a background job.

---

## 5. The `claude-bg` provider — internals

**Location:** `packages/providers/src/community/claude-bg/` — mirroring `community/pi/`:
- `provider.ts` — the `ClaudeBgProvider` class
- `config.ts` — `parseClaudeBgConfig()` (assistant defaults: `claudeBinaryPath`, default `--agent`, poll/heartbeat cadences)
- `capabilities.ts` — `CLAUDE_BG_CAPABILITIES`
- `index.ts` — `registerClaudeBgProvider()`, called from `registry.ts` `registerCommunityProviders()` (`registry.ts:156`), `builtIn: false`.

### 5.1 `sendQuery()` lifecycle

`sendQuery(prompt, cwd, resumeSessionId?, options?): AsyncGenerator<MessageChunk>` runs as a dispatch-and-poll generator:

```
1. BUILD     — translate options → `claude` args (§5.2)
2. DISPATCH  — execFileAsync('claude', args, { cwd }) ; parse "backgrounded · <id>" from stdout
3. VERIFY    — await delay (~2s) ; read ~/.claude/jobs/<id>/state.json
               state === 'failed' → throw classified error (Archon retry machinery handles it)
               state file absent after one retry → throw 'session never spawned'
4. POLL      — loop, every POLL_INTERVAL_MS, re-read state.json:
                 • abortSignal aborted → execFileAsync('claude', ['stop', id]) ; throw aborted
                 • state in {running, busy} → yield { type:'system', content:'' }  // heartbeat (§5.5)
                 • state in {needs_input, idle-while-awaiting-input} → STALL: there is no operator,
                   so this is almost always a permission prompt the allowlist didn't cover (§6/§7).
                   Fail fast with a clear error ("background session blocked awaiting input —
                   broaden the repo allowlist"); do NOT treat as success.
                 • state === 'completed' → break (success)
                 • state === 'failed' → break (error)
5. CAPTURE   — (bonus, gated) if the workflow references $<node>.output:
                 best-effort `claude logs <id>` → yield { type:'assistant', content:text }
                 (if unavailable/empty, node relies on artifacts — acceptable per §2)
6. RESULT    — yield { type:'result', sessionId:id, isError:(state==='failed'),
                       errorSubtype:(state==='failed' ? 'error_during_execution' : undefined) }
               generator returns → executor records sessionId, marks node done → DAG advances
```

Completion of the async generator is the signal the DAG executor uses to advance. No SDK, no `query()`.

### 5.2 Option → CLI flag translation

Built from `SendQueryOptions` + `NodeConfig` (`types.ts:242-316`) and the worktree decision in §6:

| Archon input | `claude --bg` arg | Notes |
|---|---|---|
| `cwd` (param) | `execFileAsync` `cwd` (and `cd`) | required so repo settings/worktree resolve; matches SDC orient lesson |
| `resumeSessionId` | `--resume <id>` | cross-node continuity; relies on `--bg` resuming a normal session |
| `nodeConfig.agents` (named) or default | `--agent <name>` | **named** agents only |
| `options.model` / assistant default | `--model` | passthrough, unvalidated (per Archon model policy) |
| `options.systemPrompt` | `--append-system-prompt` | |
| `nodeConfig.allowed_tools` / `denied_tools` | `--allowedTools` / `--disallowedTools` | subject to `--bg` permission model (§7) |
| `nodeConfig.mcp` | `--mcp-config <file>` | path on disk; expand env first (reuse `mcp/config.ts`) |
| `nodeConfig.effort` | `--effort` | |
| node id | `-n "<node-id>"` | identifies the session in `claude agents` |
| `options.abortSignal` | → `claude stop <id>` | cancellation (§5.4) |

**Never set:** `--permission-mode bypassPermissions`/`auto` (refused on `--bg` until interactively accepted — §7), `--max-budget-usd` / `--output-format json` (these are `-p` features, declared unsupported — §7), and **never** inject `ANTHROPIC_API_KEY` into the env (disables `--bg`).

### 5.3 `MessageChunk` emission

Minimal, batch-shaped subset of the union (`types.ts:178-222`):
- `system` (empty) — heartbeats during polling (keep the executor's idle timer alive).
- `assistant` — only in the bonus data-flow path, carrying scraped `claude logs` text.
- `result` — terminal chunk carrying `sessionId` (for persistence/resume) and `isError`/`errorSubtype`. `tokens`/`cost`/`structuredOutput` are omitted (unavailable from `--bg`).

`tool` / `tool_result` / `rate_limit` chunks are **not** emitted; tool telemetry is not available from `--bg`.

### 5.4 Cancellation
`options.abortSignal` (set by the executor's per-node `AbortController`, `dag-executor.ts:709-716`) is observed in the poll loop. On abort, run `claude stop <id>` and throw an aborted error so the executor stops the node cleanly.

### 5.5 Idle-timeout interplay (friction point)
The executor aborts a node if `sendQuery` yields nothing for `STEP_IDLE_TIMEOUT_MS` (`withIdleTimeout`, `dag-executor.ts:722`). A long `--bg` task yields nothing until completion → would be killed as "idle." Mitigation: the poll loop yields an empty `system` heartbeat chunk each tick (cadence well under the idle timeout). Workflows running very long agents can also raise `idle_timeout` per node (`NodeConfig.idle_timeout`, `types.ts`).

---

## 6. Worktree & isolation model (the hard part)

Two worktree systems exist and must not collide:
- **Archon isolation** (`@archon/isolation`): `WorktreeProvider` creates worktrees under `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>` and the executor passes that path as `cwd` to `sendQuery`.
- **`--bg` native isolation:** a background session automatically moves into a worktree under `.claude/worktrees/<name>/` before editing files **unless it is already inside a linked worktree**, and `--worktree <name>` lets the caller pre-create one.

### Decision: Archon owns isolation; `--bg` does not re-isolate (Option A — recommended)

The `claude-bg` provider is dispatched with `cwd` = Archon's already-created worktree path and **without** `--worktree`. Because that path is already a linked git worktree, `--bg` should detect it and skip its own isolation. To be explicit and defensive, set `worktree.bgIsolation: "none"` in the repo's `.claude/settings.json` (requires Claude Code ≥ v2.1.143). This keeps a single worktree owner (Archon), reuses Archon's gitignored-file copying (`isolation/worktree-copy.ts`), and avoids nested `.claude/worktrees/` under an Archon worktree.

**Fallback (Option B — proven):** disable Archon isolation for `claude-bg` nodes (run them `--no-worktree` at the Archon layer) and let `claude --bg --worktree <name>` own isolation, porting the SDC machinery — `.worktreeinclude` (gitignore-syntax, repo root; native CLI auto-copy of gitignored files during `--worktree` creation) plus `.worktree-setup.yml` (copy/link/setup) executed by an explicit setup step. This is the battle-tested SDC path; choose it if Option A's "already-in-a-worktree → don't re-isolate" behavior proves unreliable in testing.

**This is the #1 thing to verify in implementation** (see §10).

### The trust-dialog gotcha (applies to BOTH options)
Claude Code **silently drops project-local `.claude/settings.json` for non-interactive (`--bg`/`-p`) sessions whose directory has not been individually trusted** via the workspace-trust dialog. A fresh worktree (Archon's or `--bg`'s) is a new, untrusted directory, so:
- `SessionStart` hooks do **not** fire reliably → cannot depend on hooks for worktree post-setup.
- The allowlist in the worktree's project-local settings may be ignored → the agent hits a permission prompt with **no operator** → the session **stalls silently**.

Mitigations (inherited from SDC `worktree-setup` / `pipeline-agent-orient`):
1. **One-time interactive trust per repo** on the host before dispatching there (also the prerequisite for any `--worktree` use).
2. A **broad-enough allowlist** that survives — practically, accumulate grants in `.claude/settings.local.json` and `link:` it from parent into the worktree (SDC `.worktree-setup.yml` `link:`), or rely on Archon's `worktree-copy.ts` to seed it.
3. If a worktree needs gitignored files (`.env`, credential keys), seed them via Archon's `worktree-copy` (Option A) or `.worktreeinclude` + `.worktree-setup.yml` (Option B). Missing files = silent stalls / failing work.

---

## 7. Permission & auth model

- **Host:** persistent, OAuth/subscription-logged-in, supervisor daemon running. **`ANTHROPIC_API_KEY` / `apiKeyHelper` / `ANTHROPIC_AUTH_TOKEN` must be unset** in the dispatch environment — any of them disables `--bg`/supervisor features. (Conflicts with the SDK `claude` provider if both run on the same host with a key set — document and guard.)
- **Permissions:** `--bg` refuses `bypassPermissions`/`auto` until accepted interactively in the directory once. The agent therefore runs under the repo's `.claude/settings.json` `permissions.allow`, which must be broad enough for the work — a too-narrow allowlist stalls the session silently (no operator).
- **Capabilities (honest declaration — drives executor warnings at `dag-executor.ts:390`):**

| Capability | `claude` (SDK) | `claude-bg` | Reason |
|---|---|---|---|
| `sessionResume` | ✅ | ✅ | `--resume` |
| `mcp` | ✅ | ✅ | `--mcp-config` |
| `toolRestrictions` | ✅ | ✅\* | `--allowed/disallowedTools` (*within `--bg` permission rules) |
| `effortControl` | ✅ | ✅ | `--effort` |
| `envInjection` | ✅ | ⚠️ limited | can pass env **except** API-key vars |
| `hooks` | ✅ | ❌ | no in-process callbacks in `--bg` |
| `skills` (inline preload) | ✅ | ❌ | `dag-node-skills` AgentDefinition is SDK-only |
| `agents` (inline def) | ✅ | ❌ | CLI `--agent` names only |
| `structuredOutput` | ✅ | ❌ | `--output-format json` is a `-p` feature |
| `costControl` | ✅ | ❌ | `--max-budget-usd` is `-p`; `--bg` = subscription quota |
| `thinkingControl` | ✅ | ❌ | covered partially by `--effort`; declare ❌ to be safe |
| `fallbackModel` | ✅ | ❌ | unverified on `--bg`; declare ❌ |
| `sandbox` | ✅ | ❌ | SDK option |

---

## 8. Concurrency & quota
Archon runs independent nodes in a topological layer concurrently (`Promise.allSettled`, `dag-executor.ts:2645`); each becomes a `--bg` dispatch under the supervisor. Background agents burn subscription quota proportionally (≈10× for 10 parallel). Not a blocker — a deliberate concurrency cap (workflow design and/or a provider/host-level limit) is the knob. Document the trade-off; do not add a new engine feature for it in v1 (YAGNI).

---

## 9. Reuse vs build, and LOE

**Reused unchanged (the bulk of "a deterministic harness"):** the entire DAG engine — `depends_on`, `trigger_rule`, `when:`, approval gates, retries, `resume`, validation, `$ARTIFACTS_DIR`, variable substitution, and `$nodeId.output` (works wherever log-scraping yields text). Zero lines written here.

**New build:**

| Work item | Size | Notes |
|---|---|---|
| Provider scaffold + registration | S | copy `community/pi` structure; wire `registerClaudeBgProvider()` |
| Invocation builder (options → args) | M | port SDC `dispatch-agent` recipe; §5.2 table |
| Launch + verify (`state.json` failed-detection) | S | SDC sleep+read+parse pattern |
| Poll loop + heartbeat chunks | M | idle-timer interplay (§5.5) is the fiddly bit |
| `sendQuery` wiring (result chunk, resume, cancel) | M | emit `result` w/ sessionId; `claude stop` on abort |
| `capabilities.ts` | XS | §7 table |
| Worktree integration (Option A wiring + `bgIsolation:none`) | M | the riskiest item — see §10 |
| Optional: `claude logs` scrape → `$nodeId.output` | S | gated, best-effort; can skip in v1 |
| Unit tests (arg building, state parsing, chunk mapping) | M | pure functions |
| Integration test (real `--bg` on host) | M | dispatch a trivial workflow, assert completion |

**Rough total: ~M+ (a few focused days).** Leverage is high — one provider (~size of `community/pi`) inherits the whole engine.

**Operational setup (non-code, one-time per repo; already done for SDC):** OAuth login on host; interactive trust acceptance per repo; broad `.claude/settings.json` allowlist; `.worktreeinclude` / `.worktree-setup.yml` (Option B) or Archon `worktree-copy` config (Option A).

---

## 10. Risks & unknowns to verify during implementation

1. **Worktree ownership (highest risk).** Verify that dispatching `--bg` with `cwd` inside an existing Archon worktree (no `--worktree`, `bgIsolation:none`) does NOT trigger a nested `.claude/worktrees/` isolation. If it does, fall back to Option B. *De-risk first.*
2. **Headless resume-with-new-prompt.** Confirm `claude --resume <id> --bg "<next>"` (or `--continue` form) continues a prior `--bg` session non-interactively. If not, every node is a fresh session (fine for `context: fresh`, a behavior change otherwise) — document and degrade.
3. **Trust-dialog / permission stalls.** Confirm the allowlist strategy prevents silent stalls in fresh worktrees on this host. This is the SDC pipeline's hardest-won lesson; reuse its mitigations.
4. **Flag parity in `--bg`.** Confirm `--append-system-prompt`, `--mcp-config`, `--agent`, `--effort` behave under `--bg` as under interactive.
5. **Heartbeat cadence vs `STEP_IDLE_TIMEOUT_MS`.** Pick a poll interval comfortably under the idle timeout.
6. **Exact `state.json` vocabulary.** Confirm the precise `.state` values the supervisor writes (SDC observed `running`/`idle`/`busy`/`failed`; the agent-view UI shows Working/Needs-input/Idle/Completed/Failed/Stopped). The poll logic in §5.1 must map these correctly — especially distinguishing "done" from "waiting for input." Verify against a real session before finalizing the terminal/stall sets.
7. **Billing durability.** `--bg` subscription billing is inferred (agent-view is a research preview) and sits on the interactive-vs-programmatic fault line; watch for reclassification after June 15.

---

## 11. Testing strategy

- **Unit (deterministic, no network):** arg construction from representative `SendQueryOptions`/`NodeConfig`; `state.json` parsing (running/idle/completed/failed/absent); `MessageChunk` mapping; abort → `claude stop` path. Follow Archon's `mock.module` isolation rules (CLAUDE.md) and the package's test-split conventions.
- **Integration (on the OAuth host, gated/manual):** dispatch a trivial single-node `provider: claude-bg` workflow against a primed repo; assert it reaches a terminal state and the node completes. A second test for a 2-node sequential workflow to exercise resume and ordering.
- **Capability-warning test:** a workflow node using `hooks`/`skills` on `claude-bg` should produce the executor's capability warning (not a crash).
- `bun run validate` must pass (type-check, lint, format, bundled checks, tests) before PR.

---

## 12. Open questions

- Option A vs B for worktrees — resolved by the §10.1 spike, not by discussion.
- Should interactive chat stay on the SDK `claude` provider (accepting its credit-pool cost for low volume), or also move? Out of scope for v1; revisit if chat volume matters.
- Do any current workflows depend on `claude`-only features (inline `agents`/`skills`, `hooks`, structured output) such that they must stay on the SDK provider? Inventory before broad migration.
