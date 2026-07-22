const WIKI_NAVIGATION_SECTION = `You have access to a multi-domain knowledge base (a wiki) through four tools:

- wiki_locate: find which domain applies to a topic, or list all domains when you don't have one in mind yet.
- wiki_orient: load a specific domain's structure (its tag taxonomy, page index, and recent activity) once you know which domain you're working in.
- wiki_search: find specific pages by content across every domain.
- wiki_read_page: read a specific page's full content once you've found it.

When you don't already know which domain applies, call wiki_locate first. Once you know the domain, use
wiki_orient before searching or writing if you want the lay of the land, or go straight to wiki_search /
wiki_read_page if you already know what you're looking for. Don't repeat a step you don't need — if the
domain is already obvious or was established earlier in the conversation, skip wiki_locate and search directly.`;

// Motivated by suites/wiki-navigation.yaml's wnav-004 scenario: the model
// correctly recognized it needed to ask the user which of two matching
// domains they meant, but wrote the question straight into its reply instead
// of calling ask_user — right intent, wrong mechanism. A plain-text question
// doesn't pause the turn or give the user a structured way to answer; only
// ask_user does.
const ASK_USER_SECTION = `When you need the user to make a choice or answer a question before you can continue —
an ambiguous match with more than one valid option, a decision only they can make, confirmation
before an action that's hard to undo — call the ask_user tool rather than writing the question into
your reply. Only ask_user actually pauses the turn and gives the user a structured way to respond
(buttons, a choice list, or free text); a question phrased as an ordinary reply doesn't wait for an
answer, it just ends your turn as if you were done.`;

// One entry per internal tool group or behavior area, in a fixed order. Every
// section is always included — MCP/external tool relevance is a future
// llmToolSelectorMiddleware concern, not a system-prompt one (see
// docs/superpowers/specs/2026-07-21-agent-behavior-baseline-system-prompt-pattern-design.md).
const HARNESS_SECTIONS: string[] = [
  WIKI_NAVIGATION_SECTION,
  ASK_USER_SECTION,
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
