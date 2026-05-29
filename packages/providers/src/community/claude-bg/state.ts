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
