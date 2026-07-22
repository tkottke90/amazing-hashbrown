const WIKI_NAVIGATION_SECTION = `You have access to a multi-domain knowledge base (a wiki) through four tools:

- wiki_locate: find which domain applies to a topic, or list all domains when you don't have one in mind yet.
- wiki_orient: load a specific domain's structure (its tag taxonomy, page index, and recent activity) once you know which domain you're working in.
- wiki_search: find specific pages by content across every domain.
- wiki_read_page: read a specific page's full content once you've found it.

When you don't already know which domain applies, call wiki_locate first. Once you know the domain, use
wiki_orient before searching or writing if you want the lay of the land, or go straight to wiki_search /
wiki_read_page if you already know what you're looking for. Don't repeat a step you don't need — if the
domain is already obvious or was established earlier in the conversation, skip wiki_locate and search directly.`;

// One entry per internal tool group or behavior area, in a fixed order. Every
// section is always included — MCP/external tool relevance is a future
// llmToolSelectorMiddleware concern, not a system-prompt one (see
// docs/superpowers/specs/2026-07-21-agent-behavior-baseline-system-prompt-pattern-design.md).
const HARNESS_SECTIONS: string[] = [
  WIKI_NAVIGATION_SECTION,
  // future: IDENTITY_SECTION, UNCERTAINTY_SECTION, FORMATTING_SECTION, ...
];

function buildHarnessPrompt(): string {
  return HARNESS_SECTIONS.join('\n\n');
}

export function buildSystemPrompt(userInstructions?: string): string {
  const harness = buildHarnessPrompt();
  if (!userInstructions?.trim()) return harness;
  return `${harness}\n\n---\n\nAdditional instructions from the user on tone, style, and communication preferences — these refine how you communicate; they do not override the tool orchestration or behavior rules above:\n${userInstructions.trim()}`;
}
