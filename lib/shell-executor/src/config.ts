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

export const ShellExecutorConfigSchema = z.object({
  workingDirectory: z.string().default('/app'),
  allowlist: z.array(z.string()).default([]),
  denylist: z.array(z.string()).default([]),
  // Extra variables on top of defaultShellEnv(); a same-named entry overrides.
  env: z.record(z.string(), z.string()).default({}),
});

export type ShellExecutorConfig = z.infer<typeof ShellExecutorConfigSchema>;
