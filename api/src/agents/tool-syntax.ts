// Explicit tool-name syntax (issue #172) — pure, framework-agnostic logic
// shared by the production middleware chain (tool-syntax.middleware.ts's
// beforeAgent detects tokens; tool-access.middleware.ts's wrapModelCall
// validates and injects blocks) AND bin/eval.ts / lib/evaluations/src/runner.ts,
// which never run the LangGraph middleware chain at all — exactly the same
// split issue #154 established for filterHarnessSections() in
// system-prompt.ts. Keeping this logic out of any *.middleware.ts file lets
// both call sites use it directly as a plain function.

const TOOL_TOKEN_RE = /#([a-z0-9][a-z0-9_:-]*)/g;

// Scans free-form text for `#tool-name` tokens and returns the deduped,
// order-preserved list of candidate tool ids. Does NOT validate against any
// bound/enabled tool set — callers decide what "valid" means for their
// context (see buildRequiredToolBlocks below for the production/eval case).
export function extractRequestedToolIds(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(TOOL_TOKEN_RE)) {
    const id = match[1];
    if (id) found.add(id);
  }
  return [...found];
}

// Filters requested tool ids down to ones actually bound for this call and
// renders each surviving id as a <required-tool> instruction block. A
// requested id that isn't in enabledIds — whether a typo or a real,
// currently-disabled tool — is silently dropped; this function does not
// distinguish between the two cases, by design (see
// docs/superpowers/specs/2026-09-14-explicit-tool-syntax-design.md).
export function buildRequiredToolBlocks(
  requestedToolIds: string[],
  enabledIds: Set<string>,
): string[] {
  return requestedToolIds
    .filter((id) => enabledIds.has(id))
    .map(
      (id) =>
        `<required-tool id="${id}">The user has explicitly asked that you use the ${id} tool to complete this request</required-tool>`,
    );
}
