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
    expect(parseClaudeBgConfig({ model: 123, defaultAgent: [], claudeBinaryPath: null })).toEqual(
      {}
    );
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
