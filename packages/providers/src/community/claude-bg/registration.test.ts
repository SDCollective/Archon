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
