import { describe, expect, test } from 'bun:test';
import { parseBackgroundedId, classifyJobState, jobStatePath, readJobState } from './state';

describe('parseBackgroundedId', () => {
  test('extracts the id from the backgrounded line', () => {
    expect(parseBackgroundedId('backgrounded · 7c5dcf5d · flaky-test-fix\n  claude agents')).toBe(
      '7c5dcf5d'
    );
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
  test('provisional vocabulary: done / working / error / stopped', () => {
    expect(classifyJobState({ state: 'done' })).toBe('completed');
    expect(classifyJobState({ state: 'working' })).toBe('running');
    expect(classifyJobState({ state: 'error' })).toBe('failed');
    expect(classifyJobState({ state: 'stopped' })).toBe('failed');
  });
});

describe('jobStatePath', () => {
  test('builds the per-job state path under the home jobs dir', () => {
    expect(jobStatePath('abc')).toMatch(/\.claude\/jobs\/abc\/state\.json$/);
  });
});

describe('readJobState', () => {
  test('returns null for a non-existent id (errors swallowed, never throws)', async () => {
    const result = await readJobState('definitely-not-a-real-job-id-9f90c217');
    expect(result).toBeNull();
  });
});
