import { z } from 'zod';

export const ShellExecutorConfigSchema = z.object({
  workingDirectory: z.string().default('/app'),
  allowlist: z.array(z.string()).default([]),
  denylist: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  }),
});

export type ShellExecutorConfig = z.infer<typeof ShellExecutorConfigSchema>;
