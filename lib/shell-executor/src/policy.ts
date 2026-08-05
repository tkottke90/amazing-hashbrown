import type { ShellExecutorConfig } from './config.js';

function matchesGlob(command: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(command);
}

export function evaluatePolicy(
  command: string,
  config: Pick<ShellExecutorConfig, 'allowlist' | 'denylist'>,
): 'allowed' | 'denied' | 'requires-approval' {
  for (const pattern of config.denylist) {
    if (matchesGlob(command, pattern)) return 'denied';
  }
  for (const pattern of config.allowlist) {
    if (matchesGlob(command, pattern)) return 'allowed';
  }
  return 'requires-approval';
}
