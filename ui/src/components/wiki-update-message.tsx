import { useLocation } from 'preact-iso';
import { BookOpen, ExternalLink, MessageSquarePlus, Check } from 'lucide-preact';
import { ThreadCardShell } from './thread-card-shell';
import { CardBadge } from './card-badge';
import type { StagedWikiReference } from './chat-input.js';
import type { WikiUpdateThreadMessage } from '../types/thread-message.js';

interface WikiUpdateMessageProps {
  message: WikiUpdateThreadMessage;
  /**
   * Fires with this card's own {wikiId, path, title} when "Add to Message"
   * is clicked — the caller owns staging it into the composer (see
   * chat-input.tsx's wikiReferences prop). Omitted by callers with no live
   * composer to stage into (read-only thread views), in which case the
   * button itself is never rendered.
   */
  onStageWikiReference?: (ref: StagedWikiReference) => void;
  /** True once this card's own page is already staged — renders a disabled "Added" state instead of re-firing onStageWikiReference. */
  isStaged?: boolean;
}

export function WikiUpdateMessage({
  message,
  onStageWikiReference,
  isStaged,
}: WikiUpdateMessageProps) {
  const { route } = useLocation();
  // Any pageKind other than the literal 'updated' — including a legacy
  // section-type string (e.g. 'entity') from a row persisted before this
  // field was a created/updated enum — renders as "Created" rather than
  // an unmapped or blank badge.
  const isUpdate = message.pageKind === 'updated';

  return (
    <ThreadCardShell>
      <div data-testid="wiki-update-card" className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <BookOpen className="size-3.5 shrink-0 text-muted-foreground" />
          <CardBadge variant="blue">{message.wikiName}</CardBadge>
          <CardBadge variant={isUpdate ? 'amber' : 'green'}>
            {isUpdate ? 'Updated' : 'Created'}
          </CardBadge>
        </div>

        <span className="text-sm font-medium text-foreground">{message.pageTitle}</span>

        {message.path && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="wiki-update-open-link"
              onClick={() =>
                route(
                  `/wiki?view=document&domain=${encodeURIComponent(message.wikiName)}&page=${encodeURIComponent(message.path!)}`,
                )
              }
              className="flex w-fit items-center gap-1 text-sm text-primary hover:underline"
            >
              Open
              <ExternalLink className="size-3.5" />
            </button>

            {onStageWikiReference && (
              <button
                type="button"
                data-testid="wiki-update-add-to-message"
                disabled={isStaged}
                onClick={() =>
                  onStageWikiReference({
                    wikiId: message.wikiName,
                    path: message.path!,
                    title: message.pageTitle,
                  })
                }
                className="flex w-fit items-center gap-1 text-sm text-primary hover:underline disabled:cursor-default disabled:text-muted-foreground disabled:no-underline"
              >
                {isStaged ? (
                  <>
                    Added
                    <Check className="size-3.5" />
                  </>
                ) : (
                  <>
                    Add to Message
                    <MessageSquarePlus className="size-3.5" />
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </ThreadCardShell>
  );
}
