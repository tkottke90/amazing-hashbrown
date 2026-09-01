import { useLocation } from 'preact-iso';
import { BookOpen, ExternalLink } from 'lucide-preact';
import { ThreadCardShell } from './thread-card-shell';
import { CardBadge } from './card-badge';
import type { WikiUpdateThreadMessage } from '../types/thread-message.js';

interface WikiUpdateMessageProps {
  message: WikiUpdateThreadMessage;
}

export function WikiUpdateMessage({ message }: WikiUpdateMessageProps) {
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
        )}
      </div>
    </ThreadCardShell>
  );
}
