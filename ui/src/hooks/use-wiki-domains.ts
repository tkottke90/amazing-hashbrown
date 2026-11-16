import { signal } from '@preact/signals';
import { fetchDomains, type WikiDomain } from '@/services/wiki-api';

// Shared across chat/index.tsx and workspace-chat-tab.tsx, which both need
// the Wiki Domain list for the chat-input "Orient to wiki" submenu — see
// ui/AGENTS.md's "hook used by 2+ pages -> src/hooks/" rule. The wiki page's
// own chat (ingestion-chat.tsx) keeps using its existing domains signal from
// pages/wiki/use-wiki.ts instead (already fetched there), so this hook is
// not used on that page.
export const wikiDomains = signal<WikiDomain[]>([]);

// Call from a page's mount effect (mirrors use-providers.ts's
// fetchProviders()) — best-effort; the "Orient to wiki" submenu just stays
// absent on failure rather than surfacing an error of its own.
export async function fetchWikiDomains(): Promise<void> {
  try {
    wikiDomains.value = await fetchDomains();
  } catch {
    // best-effort
  }
}
