import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Monitor } from 'lucide-preact';
import { GraphView } from '@/components/wiki/graph-view';
import { DocumentView } from '@/components/wiki/document-view';
import { IngestionChat } from '@/components/wiki/ingestion-chat';
import { DomainFilter } from '@/components/wiki/domain-filter';
import {
  refreshDomains,
  refreshGraph,
  graphRefreshing,
  loadPage,
  activeDomainId,
} from '@/hooks/use-wiki';
import { hydrateWikiThread, wikiThreadId } from '@/hooks/use-wiki-ingestion';

// path prop is consumed by preact-iso's Router for route matching
export function WikiView(_props: { path?: string }) {
  const canvasView = useSignal<'graph' | 'document'>('graph');
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void refreshDomains();
    void refreshGraph();
    void hydrateWikiThread(wikiThreadId.value);
  }, []);

  function handleOpenInEditor(domainId: string, filename: string) {
    activeDomainId.value = domainId;
    void loadPage(domainId, filename);
    canvasView.value = 'document';
  }

  return (
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
                onClick={() => (canvasView.value = 'graph')}
                class={`px-2.5 py-1 transition-colors ${
                  canvasView.value === 'graph'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Graph
              </button>
              <button
                type="button"
                onClick={() => (canvasView.value = 'document')}
                class={`px-2.5 py-1 transition-colors ${
                  canvasView.value === 'document'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Document
              </button>
            </div>

            {canvasView.value === 'graph' && (
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
            {canvasView.value === 'graph' ? (
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
  );
}
