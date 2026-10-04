import type { ScenarioResultDetails } from './schemas.js';

// Cross-cutting categories layered on top of tool-call/tool-sequence/
// llm-judge results — not a new scenario or details type (see
// docs/superpowers/specs/2026-10-03-malformed-tool-call-detection-design.md
// D5). One shared helper so CLI/HTML reporting don't each need their own
// type-switch over every details shape that can carry one of these fields.
export type FailureCategory = 'malformed_tool_call' | 'prose_question';

export function getFailureCategory(details: ScenarioResultDetails): FailureCategory | null {
  if ('malformedToolCall' in details && details.malformedToolCall) return 'malformed_tool_call';
  if ('proseQuestion' in details && details.proseQuestion) return 'prose_question';
  return null;
}
