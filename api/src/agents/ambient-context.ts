import { formatRunTime } from './task-context.js';

export interface AmbientContextInput {
  timezone: string;
  /** Injectable for tests; defaults to `new Date()`. */
  now?: Date;
}

interface AmbientContextProvider {
  // Mirrors HarnessSection.tag (system-prompt.ts) — a future selective-
  // inclusion/testing hook, unused today with one provider.
  tag: string;
  build: (input: AmbientContextInput) => string | null;
}

const CURRENT_TIME_PROVIDER: AmbientContextProvider = {
  tag: 'current_time',
  build: ({ timezone, now = new Date() }) =>
    `Current date and time: ${formatRunTime(now.toISOString(), timezone)}. "Today," "tomorrow," and similar relative dates resolve against this.`,
};

// Every future entry (see docs/research/issue-244/01-ambient-context-survey.md)
// lands here as its own provider, added only once backed by a confirmed
// failure mode — not speculatively. One entry today.
const AMBIENT_CONTEXT_PROVIDERS: AmbientContextProvider[] = [CURRENT_TIME_PROVIDER];

export function buildAmbientContext(input: AmbientContextInput): string {
  return AMBIENT_CONTEXT_PROVIDERS.map((p) => p.build(input))
    .filter((line): line is string => line !== null)
    .join('\n');
}
