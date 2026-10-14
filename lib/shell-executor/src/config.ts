import { z } from 'zod';

// The minimal environment every shell command starts from. Configured `env`
// entries are layered on top at spawn time (see spawnCommand) rather than
// baked in as a schema default — a schema-level default would be written into
// config.yaml by any partial settings save, and would be dropped entirely the
// moment a user configured a single variable (issue #220).
export function defaultShellEnv(): Record<string, string> {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    USER: process.env.USER ?? '',
  };
}

// A tripwire against obvious, destructive mistakes — not a security boundary.
// evaluatePolicy matches the literal command string (anchored, glob-only),
// so this does not catch sudo-wrapped, variable-substituted, or otherwise
// obfuscated forms of the same command. See docs/superpowers/specs/
// 2026-10-13-workspace-shell-auto-approve-design.md §3.
const DEFAULT_DENYLIST = [
  // Resource exhaustion
  ':(){ :|:& };:',
  // Unscoped destructive filesystem ops
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  // Disk / block devices
  'mkfs.*',
  'dd *of=/dev/*',
  'wipefs *',
  'shred *',
  'fdisk /dev/*',
  'parted /dev/* rm*',
  // Blast-wide permissions/ownership
  'chmod -R 777 /',
  'chmod -R 777 /*',
  'chown -R * /',
  // Host/container availability
  'reboot',
  'shutdown *',
  'halt',
  'poweroff',
  'init 0',
  // Remote-fetch-into-shell
  'curl * | sh*',
  'curl * | bash*',
  'wget * -O- | sh*',
  // Force-push / history rewrite
  'git push --force*',
  'git push -f*',
  // Uncommitted-work wipe
  'git clean -fdx*',
  'git clean -fd*',
];

export const ShellExecutorConfigSchema = z.object({
  workingDirectory: z.string().default('/app'),
  allowlist: z.array(z.string()).default([]),
  denylist: z.array(z.string()).default(DEFAULT_DENYLIST),
  // Extra variables on top of defaultShellEnv(); a same-named entry overrides.
  env: z.record(z.string(), z.string()).default({}),
});

export type ShellExecutorConfig = z.infer<typeof ShellExecutorConfigSchema>;
