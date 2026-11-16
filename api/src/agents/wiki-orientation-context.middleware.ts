import { createMiddleware } from 'langchain';
import { SystemMessage } from '@langchain/core/messages';
import type { WikiRegistry } from '@tkottke90/llm-wiki';
import { getThreadStore } from '../services/thread-store.js';
import { getWikiRegistry } from '../services/wiki.js';
import { getMessageText } from './message-content.js';
import { formatWikiOrientation } from './wiki-orientation-format.js';

// Makes a thread's mechanically-set Wiki Orientation (see GLOSSARY.md) part
// of the model's context, fresh on every model call — same rationale as
// ambient-context.middleware.ts and tool-access.middleware.ts's thread-id
// read: getChatAgent()/getWorkspaceChatAgent()/getWikiIngestionAgent() cache
// built agents per provider:model (or workspaceId:provider:model), not per
// thread, so a thread's active wiki can only be read live here, never baked
// into a cached system-prompt string at agent-build time.
//
// Deliberately does NOT write anything into checkpoint/message history —
// unlike workspace-summarizer.ts's summary-boundary marker, there's nothing
// here that needs boundaryAwareTrim's (summary-boundary.ts) "cut cleanly
// after this point" behavior, since nothing is ever added to history. This
// is also what makes "Clear wiki orientation" and switching wikis fully
// clean: the very next model call simply stops seeing the old content, with
// no leftover marker to account for.
//
// A factory, not a bare singleton (same shape as createToolAccessMiddleware
// in tool-access.middleware.ts), so a test can inject a fake registry
// instead of standing up a real wiki root on disk. Production code uses the
// default-exported wikiOrientationContextMiddleware singleton below.
export function createWikiOrientationContextMiddleware(
  getRegistry: () => Promise<WikiRegistry> = getWikiRegistry,
) {
  return createMiddleware({
    name: 'WikiOrientationContextMiddleware',
    wrapModelCall: async (request, handler) => {
      const threadId = request.runtime.configurable?.thread_id;
      const activeWikiId = threadId
        ? getThreadStore().getThreadMeta(threadId)?.activeWikiId
        : null;
      if (!activeWikiId) return handler(request);

      try {
        const registry = await getRegistry();
        const wiki = await registry.load(activeWikiId);
        const block = formatWikiOrientation(activeWikiId, await wiki.orient());
        const baseContent = getMessageText(request.systemMessage.content);
        const systemMessage = new SystemMessage(`${baseContent}\n\n${block}`);
        return handler({ ...request, systemMessage });
      } catch {
        // The stored activeWikiId's domain no longer resolves (e.g. deleted
        // after being set active) — degrade silently rather than failing the
        // turn; same posture as every other best-effort context addition here.
        return handler(request);
      }
    },
  });
}

export const wikiOrientationContextMiddleware = createWikiOrientationContextMiddleware();
