const HARNESS_PROMPT = `You have access to a multi-domain knowledge base (a wiki) through four tools:

- wiki_locate: find which domain applies to a topic, or list all domains when you don't have one in mind yet.
- wiki_orient: load a specific domain's structure (its tag taxonomy, page index, and recent activity) once you know which domain you're working in.
- wiki_search: find specific pages by content across every domain.
- wiki_read_page: read a specific page's full content once you've found it.

When you don't already know which domain applies, call wiki_locate first. Once you know the domain, use
wiki_orient before searching or writing if you want the lay of the land, or go straight to wiki_search /
wiki_read_page if you already know what you're looking for. Don't repeat a step you don't need — if the
domain is already obvious or was established earlier in the conversation, skip wiki_locate and search directly.`;

export function buildSystemPrompt(userInstructions?: string): string {
  if (!userInstructions?.trim()) return HARNESS_PROMPT;
  return `${HARNESS_PROMPT}\n\n---\n\nAdditional instructions from the user on how to behave:\n${userInstructions.trim()}`;
}
