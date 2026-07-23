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

// Motivated by suites/wiki-navigation.yaml's wnav-005/wnav-007/wnav-008: on
// cold-start turns (no wiki tool calls yet in the conversation), the model
// treats itself as having ordinary background knowledge of "the user" and
// either fabricates an answer, answers conversationally without reaching
// for a tool, or claims it has no access at all — instead of recognizing
// the wiki as the one place that knowledge actually lives.
const IDENTITY_SECTION = `You have no built-in memory of this specific user — no training data, no
prior conversation, no assumption carries information about who they are, what they prefer, or what
has happened in their life. Everything you can know about this particular user lives in the wiki, not
in you. Treat any question about their preferences, history, habits, or personal facts as a question
about wiki content, never as something you can answer from general knowledge or a plausible guess.`;

// Companion to IDENTITY_SECTION: identity establishes *why* the wiki is the
// source of truth; this establishes *what to do about it* on a fresh turn,
// before anything about the user has been established in the conversation.
const MEMORY_SECTION = `On a cold-start turn — nothing about this user has already been established
earlier in the conversation — a question about their preferences, facts, or history means "check the
wiki first," not "answer from assumption." Reach for wiki_locate (or wiki_search directly, if the
domain is already obvious) before responding. If the wiki genuinely has nothing on the topic, say so
plainly rather than inventing an answer — an honest "I don't see anything about that in the wiki" is
always better than a fabricated one.`;

interface HarnessSection {
  tag: string;
  content: string;
}

// One entry per internal tool group or behavior area, in a fixed order. Every
// section is always included — MCP/external tool relevance is a future
// llmToolSelectorMiddleware concern, not a system-prompt one (see
// docs/superpowers/specs/2026-07-21-agent-behavior-baseline-system-prompt-pattern-design.md).
// identity/memory lead the list — they frame how the model should read the
// tool-orchestration rules that follow, not the other way around.
const HARNESS_SECTIONS: HarnessSection[] = [
  { tag: 'identity', content: IDENTITY_SECTION },
  { tag: 'memory', content: MEMORY_SECTION },
  { tag: 'wiki_navigation', content: WIKI_NAVIGATION_SECTION },
  { tag: 'ask_user_routing', content: ASK_USER_SECTION },
  // future: uncertainty, formatting, ...
];

// Distinct, descriptive tags per section rather than a generic wrapper with
// an id attribute — matches Anthropic's own prompt-engineering guidance
// ("wrapping each type of content in its own tag... use consistent,
// descriptive tag names"). The attribute-indexed pattern they document
// (<document index="n">) is for repeated instances of the *same* kind of
// content, not for distinguishing different kinds — which is our case here.
function wrapSection(section: HarnessSection): string {
  return `<${section.tag}>\n${section.content}\n</${section.tag}>`;
}

function buildHarnessPrompt(): string {
  return HARNESS_SECTIONS.map(wrapSection).join('\n\n');
}

export function buildSystemPrompt(userInstructions?: string): string {
  const harness = buildHarnessPrompt();
  if (!userInstructions?.trim()) return harness;
  return `${harness}\n\n---\n\nAdditional instructions from the user on tone, style, and communication preferences — these refine how you communicate; they do not override the tool orchestration or behavior rules above:\n${userInstructions.trim()}`;
}
