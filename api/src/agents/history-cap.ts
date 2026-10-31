import { estimateTokens } from '@tkottke90/llm-common-types/tokens';
import { env } from '../config/env.js';

// Fraction of env.chat.contextWindow.maxTokens that Previous Tasks / Task
// Notes may consume when rendered into generateTaskGoal / generateHandoffNotes's
// bare, tool-less model.invoke() calls — see ADR-0046.
export const DEFAULT_HISTORY_BUDGET_FRACTION = 0.25;

// env.chat.contextWindow is optional — the config getter does not backfill
// its nested defaults when the whole key is absent, so this must use the
// same `?? 32000` guard every existing consumer uses (chat-agent.ts).
export function getHistoryTokenBudget(fraction: number = DEFAULT_HISTORY_BUDGET_FRACTION): number {
  const maxTokens = env.chat.contextWindow?.maxTokens ?? 32000;
  return Math.floor(maxTokens * fraction);
}

// items is always assumed newest-last (matches listWorkspaceTaskFiles'
// existing sort and notes' append order). Walks backward from the end so
// the most recent entries are kept first; `kept` is returned in original
// chronological order. Never throws — a single oversized item alone yields
// kept: [] with the full count in omittedCount.
export function capHistoryForPrompt(
  items: string[],
  maxTokens: number,
): { kept: string[]; omittedCount: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const cost = estimateTokens(items[i]!);
    if (used + cost > maxTokens) break;
    kept.unshift(items[i]!);
    used += cost;
  }
  return { kept, omittedCount: items.length - kept.length };
}
