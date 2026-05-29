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
