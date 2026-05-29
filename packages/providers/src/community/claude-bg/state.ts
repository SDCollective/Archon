import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type JobStateClass = 'running' | 'completed' | 'failed' | 'stalled' | 'unknown';

/** Parse "backgrounded · <id> · <name>" from `claude --bg` stdout. */
export function parseBackgroundedId(stdout: string): string | null {
  const m = /backgrounded\s+·\s+(\S+)/.exec(stdout);
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
export async function readJobState(id: string): Promise<unknown> {
  try {
    const text = await readFile(jobStatePath(id), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session status — from `claude agents --json`
// ---------------------------------------------------------------------------

export type SessionStatusClass = 'running' | 'waiting' | 'other';

/**
 * Classify the `status` field from a `claude agents --json` row.
 *
 * - 'running'  → the session is actively working (busy/working).
 * - 'waiting'  → the session is blocked needing input (permission prompt, no
 *                operator present in --bg mode). This is a stall — fail fast.
 * - 'other'    → idle (ambiguous; could be done or just starting) or unknown.
 *                Terminal detection is delegated to .state (classifyJobState).
 */
export function classifySessionStatus(status: unknown): SessionStatusClass {
  if (status === 'busy' || status === 'working') return 'running';
  if (status === 'waiting') return 'waiting';
  return 'other'; // idle (ambiguous) / unknown — terminal detection comes from .state
}

/**
 * Find the session status for the given short id (first dash-segment of the
 * full UUID) in the parsed array returned by `claude agents --json`.
 *
 * Pure function — takes already-parsed JSON; the exec goes in the provider.
 * Returns the raw `status` string, or null if not found / input is invalid.
 */
export function findSessionStatus(rows: unknown, shortId: string): string | null {
  if (!Array.isArray(rows)) return null;
  for (const r of rows) {
    if (r && typeof r === 'object') {
      const sid = (r as { sessionId?: unknown }).sessionId;
      const status = (r as { status?: unknown }).status;
      if (typeof sid === 'string' && sid.split('-')[0] === shortId && typeof status === 'string') {
        return status;
      }
    }
  }
  return null;
}
