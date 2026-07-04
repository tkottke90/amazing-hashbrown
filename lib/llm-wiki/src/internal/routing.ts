/**
 * Deterministic wiki routing scorer. Pure port of the skill's `score_wiki`.
 *
 * Scoring weights:
 *   - wiki id appears in context        → +10
 *   - each domain word (>3 chars) hit   → +2
 *   - each tag hit                       → +3
 *   - each routing-note trigger hit      → +8   (only for notes targeting this wiki)
 */

import type { WikiEntry } from '../types.js';

/** A routing note parsed into its trigger phrases and target wiki id. */
interface ParsedNote {
  triggers: string[];
  target: string;
}

/** Parse `"<triggers> -> <wiki-id>"` lines (supports `->` and `→`). */
export function parseRoutingNotes(notes: readonly string[]): ParsedNote[] {
  const parsed: ParsedNote[] = [];
  for (const line of notes) {
    const sep = line.includes('->') ? '->' : line.includes('→') ? '→' : null;
    if (!sep) continue;
    const idx = line.indexOf(sep);
    const triggersRaw = line.slice(0, idx);
    const target = line
      .slice(idx + sep.length)
      .trim()
      .toLowerCase();
    if (!target) continue;
    const triggers = triggersRaw
      .split(/[,-]/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 2);
    parsed.push({ triggers, target });
  }
  return parsed;
}

export function scoreWiki(
  entry: WikiEntry,
  contextLower: string,
  parsedNotes: readonly ParsedNote[],
): number {
  let score = 0;
  const id = entry.id.toLowerCase();

  if (id && contextLower.includes(id)) score += 10;

  for (const word of entry.domain.toLowerCase().split(/\W+/)) {
    if (word.length > 3 && contextLower.includes(word)) score += 2;
  }

  for (const tag of entry.tags) {
    const t = tag.toLowerCase().trim();
    if (t && contextLower.includes(t)) score += 3;
  }

  for (const note of parsedNotes) {
    if (!note.target.includes(id)) continue;
    for (const trigger of note.triggers) {
      if (contextLower.includes(trigger)) score += 8;
    }
  }

  return score;
}

export interface RoutingResult {
  kind: 'match' | 'ambiguous' | 'no_match';
  /** Winner (kind === 'match'). */
  winner?: { entry: WikiEntry; score: number };
  /** Tied top scorers (kind === 'ambiguous'). */
  candidates?: WikiEntry[];
  /** All entries, when no match. */
  available?: WikiEntry[];
}

/** Score every active entry against the context and decide the outcome. */
export function computeRouting(
  entries: readonly WikiEntry[],
  routingNotes: readonly string[],
  context: string,
): RoutingResult {
  const active = entries.filter((e) => e.status === 'active');
  if (active.length === 0) {
    return { kind: 'no_match', available: [] };
  }

  const contextLower = context.toLowerCase();
  const parsedNotes = parseRoutingNotes(routingNotes);

  const scored = active
    .map((entry) => ({ entry, score: scoreWiki(entry, contextLower, parsedNotes) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  if (top.score === 0) {
    return { kind: 'no_match', available: active };
  }

  const tied = scored.filter((s) => s.score === top.score);
  if (tied.length > 1) {
    return { kind: 'ambiguous', candidates: tied.map((s) => s.entry) };
  }

  return { kind: 'match', winner: top };
}
