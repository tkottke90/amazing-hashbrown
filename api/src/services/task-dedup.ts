// Scheduled task de-duplication (Issue #365): deciding whether a new
// cron_once/cron_repeat task creation request describes the same work, at
// the same time, as an already-existing task — so two independently
// created tasks never both end up firing for the same thing. Pure: no I/O,
// no DB access; callers pre-fetch and scope the candidate list. See
// docs/superpowers/specs/2026-11-06-scheduled-task-dedup-design.md and
// GLOSSARY.md -> "Scheduled Task Deduplication" for the Duplicate
// Signature / Matching Time Slot / Duplicate Time Slot Tolerance / Reused
// Task terms this implements.

import { isCronTrigger, type CronOnceConfig, type CronRepeatConfig } from './cron-config.js';
import type { TriggerType } from './workspace-store.js';

// What's compared on both sides of a dedup check — a task's own stored
// fields, or the fields of a not-yet-inserted creation request.
export interface DedupCandidate {
  title: string;
  description: string | null;
  trackerId: string | null;
  triggerType: TriggerType;
  triggerConfig: unknown;
}

// Collapses case/whitespace differences out of free text before comparing
// it as part of a Duplicate Signature — null/undefined reads as ''.
export function normalizeSignatureText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Two tasks share a Duplicate Signature when their normalized title and
// description both match exactly (see GLOSSARY.md).
export function shareDuplicateSignature(a: DedupCandidate, b: DedupCandidate): boolean {
  return (
    normalizeSignatureText(a.title) === normalizeSignatureText(b.title) &&
    normalizeSignatureText(a.description) === normalizeSignatureText(b.description)
  );
}

function fireTimesWithinTolerance(a: string, b: string, toleranceMinutes: number): boolean {
  const diffMs = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return diffMs <= toleranceMinutes * 60_000;
}

// Two tasks share a Matching Time Slot per GLOSSARY.md: both cron_once with
// fireAt within toleranceMinutes of each other, or both cron_repeat with an
// identical normalized expression+timezone. A cron_once task never matches
// a cron_repeat task, regardless of overlap.
export function shareMatchingTimeSlot(
  a: DedupCandidate,
  b: DedupCandidate,
  toleranceMinutes: number,
): boolean {
  if (!isCronTrigger(a.triggerType) || !isCronTrigger(b.triggerType)) return false;
  if (a.triggerType !== b.triggerType) return false;
  if (!a.triggerConfig || !b.triggerConfig) return false;

  if (a.triggerType === 'cron_once') {
    const configA = a.triggerConfig as CronOnceConfig;
    const configB = b.triggerConfig as CronOnceConfig;
    return fireTimesWithinTolerance(configA.fireAt, configB.fireAt, toleranceMinutes);
  }

  const configA = a.triggerConfig as CronRepeatConfig;
  const configB = b.triggerConfig as CronRepeatConfig;
  return (
    configA.expression.trim() === configB.expression.trim() && configA.timezone === configB.timezone
  );
}

// trackerId participates in a match as plain equality, including both
// sides being null — see the design's D5 (closes a false-positive gap
// Duplicate Signature + Matching Time Slot alone would leave open).
function sameTracker(a: DedupCandidate, b: DedupCandidate): boolean {
  return a.trackerId === b.trackerId;
}

// Finds the first existing candidate that counts as a Reused Task for
// `input`: same Duplicate Signature, same Matching Time Slot, same
// trackerId. Callers are responsible for scoping `candidates` to the right
// workspace and to cron-eligible tasks before calling this — this function
// only re-checks that `input` itself is cron-eligible.
export function findDuplicateTask<T extends DedupCandidate>(
  candidates: readonly T[],
  input: DedupCandidate,
  toleranceMinutes: number,
): T | undefined {
  if (!isCronTrigger(input.triggerType) || !input.triggerConfig) return undefined;
  return candidates.find(
    (candidate) =>
      shareDuplicateSignature(candidate, input) &&
      shareMatchingTimeSlot(candidate, input, toleranceMinutes) &&
      sameTracker(candidate, input),
  );
}
