import { Layout } from '@/components/layout';
import { useTitle } from '@/hooks/use-title';
import { DocumentView } from '@/pages/wiki/document-view';
import { DomainFilter } from '@/pages/wiki/domain-filter';
import { GraphView } from '@/pages/wiki/graph-view';
import { IngestionChat } from '@/pages/wiki/ingestion-chat';
import {
  activeDomainId,
  activePagePath,
  graphRefreshing,
  loadPage,
  refreshDomains,
  refreshGraph,
  refreshPages,
} from '@/pages/wiki/use-wiki';
import { hydrateWikiThread, wikiThreadId } from '@/pages/wiki/use-wiki-ingestion';
import { Monitor } from 'lucide-preact';
import { useLocation } from 'preact-iso';
import { useEffect, useRef } from 'preact/hooks';

// path prop is consumed by preact-iso's Router for route matching
export function WikiView(_props: { path?: string }) {
  const { setPageTitle } = useTitle('Wiki');
  const { query, route } = useLocation();
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  // Derive view state from URL — default is 'graph' when param is absent or unrecognised.
  const canvasView = query.view === 'document' ? 'document' : 'graph';
  const urlDomain = query.domain as string | undefined;
  const urlPage = query.page as string | undefined;

  // On mount: load global data and hydrate the wiki chat thread.
  useEffect(() => {
    void refreshDomains();
    void refreshGraph();
    void hydrateWikiThread(wikiThreadId.value);
  }, []);

  // Sync signals from URL params whenever the document view params change.
  // This covers initial deep-link loads AND browser back/forward navigation.
  useEffect(() => {
    setPageTitle(
      canvasView === 'graph' ? 'Wiki - Graph' : 'Wiki - Document'
    )

    if (canvasView === 'document') {
      if (urlDomain && urlPage) {
        activeDomainId.value = urlDomain;
        void refreshPages(urlDomain);
        void loadPage(urlDomain, urlPage);
      }

      if (urlPage) {
        setPageTitle(`Wiki - ${urlPage.split('/').at(-1)}`);
      } else {
        setPageTitle('Wiki - Documents');
      }

    } else {
      setPageTitle('Wiki - Graph');
    }
  }, [canvasView, urlDomain, urlPage]);

  function handleOpenInEditor(domainId: string, filename: string) {
    route(
      `/wiki?view=document&domain=${encodeURIComponent(domainId)}&page=${encodeURIComponent(filename)}`,
    );
  }

  function handleGraphViewClick() {
    route('/wiki?view=graph');
  }

  function handleDocumentViewClick() {
    // Preserve current domain/page in the URL if one is already loaded.
    const domainPart = activeDomainId.value
      ? `&domain=${encodeURIComponent(activeDomainId.value)}`
      : '';
    const pagePart = activePagePath.value
      ? `&page=${encodeURIComponent(activePagePath.value)}`
      : '';
    route(`/wiki?view=document${domainPart}${pagePart}`);
  }

  return (
    <Layout>
      <div class="flex h-full flex-col">
        {/* Mobile fallback */}
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center md:hidden">
          <Monitor class="size-10 text-muted-foreground" />
          <p class="text-sm text-muted-foreground">
            The Wiki view requires a larger screen. Please open on a desktop or tablet.
          </p>
        </div>

        {/* Desktop two-column layout */}
        <div class="hidden h-full md:grid" style={{ gridTemplateColumns: '65fr 35fr' }}>
          {/* Canvas column */}
          <div class="flex min-h-0 flex-col overflow-hidden">
            {/* Canvas header */}
            <div class="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
              <div class="flex items-center gap-1 rounded border border-border text-xs">
                <button
                  type="button"
                  onClick={handleGraphViewClick}
                  class={`px-2.5 py-1 transition-colors ${
                    canvasView === 'graph'
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Graph
                </button>
                <button
                  type="button"
                  onClick={handleDocumentViewClick}
                  class={`px-2.5 py-1 transition-colors ${
                    canvasView === 'document'
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Document
                </button>
              </div>

              {canvasView === 'graph' && (
                <div class="flex min-w-0 items-center gap-2">
                  <DomainFilter />
                  {graphRefreshing.value && (
                    <div class="size-3.5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
                  )}
                </div>
              )}
            </div>

            {/* Canvas body */}
            <div class="min-h-0 flex-1">
              {canvasView === 'graph' ? (
                <GraphView onOpenInEditor={handleOpenInEditor} />
              ) : (
                <DocumentView chatInputRef={chatInputRef} />
              )}
            </div>
          </div>

          {/* Chat column */}
          <IngestionChat chatInputRef={chatInputRef} />
        </div>
      </div>
    </Layout>
  );
}
