// The choices a Loop-Guard Escalation offers, and the HITL prompt kinds the
// Loop Guard raises. Shared so Telemetry buckets a stored answer against the
// exact strings the middleware offered — a reworded choice must not silently
// turn every answer into `custom`. See GLOSSARY.md § Loop Guard.
export const CONTINUE_CHOICE = 'Continue working';
export const STOP_AND_SUMMARIZE_CHOICE = 'Stop and summarize what you have done so far';

export const LOOP_GUARD_ESCALATION_KINDS = [
  'recursion_limit_warning',
  'loop_stagnation_warning',
] as const;
