import { describe, expect, test } from 'bun:test';
import {
  parseBackgroundedId,
  classifyJobState,
  jobStatePath,
  readJobState,
  classifySessionStatus,
  findSessionStatus,
  findSessionId,
  hasSessionId,
} from './state';

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

describe('classifySessionStatus', () => {
  test('busy → running', () => {
    expect(classifySessionStatus('busy')).toBe('running');
  });
  test('working → running', () => {
    expect(classifySessionStatus('working')).toBe('running');
  });
  test('waiting → waiting', () => {
    expect(classifySessionStatus('waiting')).toBe('waiting');
  });
  test('idle → other (ambiguous, not used as terminal)', () => {
    expect(classifySessionStatus('idle')).toBe('other');
  });
  test('unknown string → other', () => {
    expect(classifySessionStatus('something-new')).toBe('other');
  });
  test('null → other', () => {
    expect(classifySessionStatus(null)).toBe('other');
  });
});

describe('findSessionStatus', () => {
  const rows = [
    { sessionId: 'aa9e58c2-b3e5-46c3-95d9-6df2afd40b95', status: 'busy', name: 'my-task' },
    { sessionId: 'beef0001-aaaa-bbbb-cccc-ddddeeeeeeee', status: 'idle', name: 'other-task' },
  ];

  test('matches the row whose sessionId starts with the short id', () => {
    expect(findSessionStatus(rows, 'aa9e58c2')).toBe('busy');
  });

  test('matches a different row', () => {
    expect(findSessionStatus(rows, 'beef0001')).toBe('idle');
  });

  test('returns null when no row matches', () => {
    expect(findSessionStatus(rows, 'deadbeef')).toBeNull();
  });

  test('returns null for non-array input', () => {
    expect(findSessionStatus(null, 'aa9e58c2')).toBeNull();
    expect(findSessionStatus('not an array', 'aa9e58c2')).toBeNull();
    expect(findSessionStatus({}, 'aa9e58c2')).toBeNull();
  });

  test('skips rows missing sessionId or status fields', () => {
    const sparse = [
      { name: 'no-session-id', status: 'busy' },
      { sessionId: 'aa9e58c2-b3e5-46c3-95d9-6df2afd40b95' }, // no status
      null,
      42,
    ];
    expect(findSessionStatus(sparse, 'aa9e58c2')).toBeNull();
  });
});

describe('findSessionId', () => {
  const rows = [
    { sessionId: 'aa9e58c2-b3e5-46c3-95d9-6df2afd40b95', status: 'busy', name: 'my-task' },
    { sessionId: 'beef0001-aaaa-bbbb-cccc-ddddeeeeeeee', status: 'idle', name: 'other-task' },
  ];

  test('returns the full sessionId for a row whose prefix matches the short id', () => {
    expect(findSessionId(rows, 'aa9e58c2')).toBe('aa9e58c2-b3e5-46c3-95d9-6df2afd40b95');
  });

  test('matches a different row by prefix', () => {
    expect(findSessionId(rows, 'beef0001')).toBe('beef0001-aaaa-bbbb-cccc-ddddeeeeeeee');
  });

  test('returns null when no row matches', () => {
    expect(findSessionId(rows, 'deadbeef')).toBeNull();
  });

  test('returns null for non-array input', () => {
    expect(findSessionId(null, 'aa9e58c2')).toBeNull();
    expect(findSessionId('not an array', 'aa9e58c2')).toBeNull();
    expect(findSessionId({}, 'aa9e58c2')).toBeNull();
  });

  test('skips rows missing sessionId field', () => {
    const sparse = [{ name: 'no-session-id', status: 'busy' }, null, 42];
    expect(findSessionId(sparse, 'aa9e58c2')).toBeNull();
  });
});

describe('hasSessionId', () => {
  const rows = [
    { sessionId: 'aa9e58c2-b3e5-46c3-95d9-6df2afd40b95', status: 'busy' },
    { sessionId: 'beef0001-aaaa-bbbb-cccc-ddddeeeeeeee', status: 'idle' },
  ];

  test('returns true when the full id exactly matches a row', () => {
    expect(hasSessionId(rows, 'aa9e58c2-b3e5-46c3-95d9-6df2afd40b95')).toBe(true);
  });

  test('returns false for a prefix-only (short) id that is not an exact match', () => {
    expect(hasSessionId(rows, 'aa9e58c2')).toBe(false);
  });

  test('returns false when the full id is not in the list', () => {
    expect(hasSessionId(rows, 'deadbeef-0000-0000-0000-000000000000')).toBe(false);
  });

  test('returns false for non-array input', () => {
    expect(hasSessionId(null, 'aa9e58c2-b3e5-46c3-95d9-6df2afd40b95')).toBe(false);
    expect(hasSessionId('not an array', 'aa9e58c2-b3e5-46c3-95d9-6df2afd40b95')).toBe(false);
    expect(hasSessionId({}, 'aa9e58c2-b3e5-46c3-95d9-6df2afd40b95')).toBe(false);
  });
});
