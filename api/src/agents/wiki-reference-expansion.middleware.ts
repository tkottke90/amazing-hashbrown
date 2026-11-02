import { randomBytes } from 'node:crypto';
import { createMiddleware } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import type { WikiRegistry } from '@tkottke90/llm-wiki';
import type { UserMessageWikiReference } from '@tkottke90/llm-common-types/chat';
import { getWikiRegistry } from '../services/wiki.js';
import { storeToolContent } from '../services/tool-content-store.js';
import { toolStub, STUB_THRESHOLD_CHARS, type StubSection } from './tools/tool-stub.js';

// Resolves every staged Wiki Reference and appends its content to the
// turn's last human message, once at the start of the turn — same
// beforeAgent/last-human-message-rewrite pattern as
// skill-expansion.middleware.ts, not attachment-awareness.middleware.ts's
// split (eager resolution upstream, this middleware only applies it).
// There is no separate resolution step here because nothing needs
// resolving before the turn is invoked: see
// docs/adr/0055-wiki-references-resolve-lazily-like-skills-not-attachments.md
// and GLOSSARY.md's "Wiki References in Chat" section for why. Deliberately
// never truncates (unlike wiki_read_page's own default) — the entire point
// of staging a reference is to carry the full page into the turn.
//
// getRegistry resolves the registry per invocation rather than taking a
// fixed instance, mirroring skill-expansion.middleware.ts's own getSkills
// param — lets tests inject a real WikiRegistry against a temp directory
// (same pattern wiki-create-page.tool.test.ts already uses) instead of the
// real env-configured singleton.
export function createWikiReferenceExpansionMiddleware(
  getRegistry: () => Promise<WikiRegistry> = getWikiRegistry,
) {
  return createMiddleware({
    name: 'WikiReferenceExpansionMiddleware',
    beforeAgent: async (state, runtime) => {
      const threadId = runtime.configurable?.thread_id as string | undefined;
      const references = runtime.configurable?.wikiReferences as
        UserMessageWikiReference[] | undefined;
      if (!references?.length) return undefined;

      const messages = [...state.messages];
      let lastHumanIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.getType() === 'human') {
          lastHumanIdx = i;
          break;
        }
      }
      if (lastHumanIdx === -1) return undefined;
      const lastHuman = messages[lastHumanIdx];
      if (!lastHuman) return undefined;

      const existingText = typeof lastHuman.content === 'string' ? lastHuman.content : '';
      let combinedText = existingText;

      for (const ref of references) {
        const citation = `---\nWiki Reference — Wiki Domain "${ref.wikiId}", path "${ref.path}":`;
        const body = await resolveOneReference(ref, threadId, getRegistry);
        combinedText = `${combinedText}\n\n${citation}\n${body}`;
      }

      messages[lastHumanIdx] = new HumanMessage({
        content: combinedText,
        id: lastHuman.id,
      });
      return { messages };
    },
  });
}

async function resolveOneReference(
  ref: UserMessageWikiReference,
  threadId: string | undefined,
  getRegistry: () => Promise<WikiRegistry>,
): Promise<string> {
  let page;
  try {
    const registry = await getRegistry();
    const wiki = await registry.load(ref.wikiId);
    page = await wiki.readPage(ref.path);
  } catch {
    return `[The user referenced wiki page "${ref.title}" (${ref.wikiId}/${ref.path}) but it no longer exists.]`;
  }

  const tags = page.frontmatter.tags.join(', ');
  const full = `# ${page.title}\n\nType: ${page.frontmatter.type}\nTags: ${tags}\n\n${page.content}`;

  if (full.length <= STUB_THRESHOLD_CHARS || !threadId) {
    return full;
  }

  const toolKey = `wref_${randomBytes(4).toString('hex')}`;
  storeToolContent(threadId, toolKey, full);

  const summary = full.slice(0, 300).replace(/\s+/g, ' ').trim();
  const sections: StubSection[] = [
    { name: 'summary', content: summary },
    {
      name: 'to read the full page',
      content: `get_tool_key({ threadId: "${threadId}", toolKey: "${toolKey}" })`,
    },
  ];

  return toolStub(
    {
      kind: 'wiki',
      wikiId: ref.wikiId,
      path: ref.path,
      chars: full.length,
      threadId,
      toolKey,
    },
    sections,
  );
}

export const wikiReferenceExpansionMiddleware = createWikiReferenceExpansionMiddleware();
